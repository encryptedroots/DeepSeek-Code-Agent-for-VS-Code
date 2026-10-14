import * as vscode from "vscode";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import {
  requestStructuredPlan,
  type AgentResponse,
  type FileOperation,
  type StructuredResponseProvider,
} from "@deepseek-agent/protocol";
import { ContextCollector, redactSecrets, type CollectedContext } from "./context";
import {
  parseSafeCommand,
  shouldAskForCommandApproval,
  shouldAskForFileApproval,
  type ApprovalMode,
  type ParsedCommand,
} from "./commandSafety";
import { TaskState, type TaskStatus } from "./state";
import { buildTaskPrompt } from "./taskPrompt";
import { composeBoundedTaskContext } from "./contextRanking";

export type { ApprovalMode } from "./commandSafety";

export interface AgentUi {
  status(status: TaskStatus, message: string): void;
  proposal(plan: string, changes: string[], commands: string[], verification: string[]): void;
  append(role: "user" | "assistant", text: string): void;
  clear(): void;
  stream(text: string): void;
  activity?(activity: "thinking" | "answering"): void;
  approach?(summary: string): void;
  requestApproval?(title: string, detail: string, approveLabel: string, signal: AbortSignal): Promise<boolean>;
  postSessions(items: Array<{ id: string; label: string }>): void;
  postHistory(id: string, items: Array<{ role: "user" | "assistant"; text: string }>): void;
}

interface StagedChange {
  operation: FileOperation;
  uri: vscode.Uri;
  before: string;
  after: string;
  originalBytes?: Uint8Array;
  diskHash?: string;
  originalDocument?: vscode.TextDocument;
}

interface CommandResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface SavedSession {
  id: string;
  label: string;
  messages: Array<{ role: "user" | "assistant"; text: string }>;
}

export class AgentController {
  private readonly taskState = new TaskState();
  private abortController: AbortController | undefined;
  private readonly failedCommands = new Set<string>();
  private viewingPastSession = false;

  constructor(
    private readonly extensionContext: vscode.ExtensionContext,
    private readonly workspace: vscode.WorkspaceFolder,
    private readonly provider: StructuredResponseProvider,
    private readonly ui: AgentUi,
  ) {}

  get status(): TaskStatus {
    return this.taskState.status;
  }

  get isRunning(): boolean {
    return this.abortController !== undefined;
  }

  async restoreHistory(): Promise<void> {
    const history = this.extensionContext.workspaceState.get<Array<{ role: "user" | "assistant"; text: string }>>(
      "history",
      [],
    );
    for (const item of history) this.ui.append(item.role, item.text);
    this.publishSessions();
  }

  async recoverInterruptedTask(): Promise<void> {
    const previous = this.extensionContext.workspaceState.get<{ startedAt: number }>("activeTask");
    if (!previous) return;
    await this.extensionContext.workspaceState.update("activeTask", undefined);
    const message = `A task was interrupted when the VS Code extension host restarted (${new Date(previous.startedAt).toLocaleString()}). Review any workspace changes and resubmit the task; interrupted tasks are not resumed automatically.`;
    this.ui.append("assistant", message);
    await this.persist("assistant", message);
  }

  async start(userPrompt: string, approvalMode: ApprovalMode = "review"): Promise<void> {
    if (this.abortController) {
      this.ui.status(this.status, "A task is already running. Cancel it before starting another.");
      return;
    }
    const prompt = userPrompt.trim();
    if (!prompt) return;
    if (Buffer.byteLength(prompt, "utf8") > 50_000) {
      this.ui.status("failed", "Prompt exceeds the 50 KB per-task limit.");
      return;
    }
    this.abortController = new AbortController();
    this.failedCommands.clear();
    try {
      if (this.viewingPastSession) {
        this.viewingPastSession = false;
        this.ui.clear();
        await this.restoreHistory();
      }
      this.ui.append("user", prompt);
      await this.extensionContext.workspaceState.update("activeTask", { startedAt: Date.now() });
      await this.persist("user", prompt);
      this.transition("thinking", "Collecting relevant workspace context…");
      if (!vscode.workspace.isTrusted)
        throw new Error("Mark this workspace as trusted in VS Code before using the coding agent.");
      await this.runTask(prompt, this.abortController.signal, approvalMode);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The task failed unexpectedly.";
      if (this.abortController.signal.aborted || message.startsWith("Task cancelled")) {
        this.transition("cancelled", "Task cancelled. No further changes will be applied.");
        const cancellation = "Task cancelled. Any changes already applied remain in the workspace.";
        this.ui.append("assistant", cancellation);
        await this.persist("assistant", cancellation);
      } else {
        this.transition("failed", message);
        const failure = `Task failed: ${message}`;
        this.ui.append("assistant", failure);
        await this.persist("assistant", failure);
      }
    } finally {
      this.abortController = undefined;
      try {
        await this.extensionContext.workspaceState.update("activeTask", undefined);
      } catch (error) {
        this.ui.status(
          "failed",
          `Could not save task recovery state: ${error instanceof Error ? error.message : "storage error"}`,
        );
      }
      this.ui.stream("");
      this.ui.proposal("", [], [], []);
    }
  }

  cancel(): void {
    this.abortController?.abort();
  }

  async clearHistory(): Promise<void> {
    if (this.isRunning) {
      this.ui.status(this.status, "Cancel the active task before clearing conversation history.");
      return;
    }
    await this.extensionContext.workspaceState.update("history", []);
    await this.extensionContext.workspaceState.update("pastSessions", []);
    this.viewingPastSession = false;
    this.ui.clear();
    this.publishSessions();
    this.ui.status(this.status, "Conversation cleared.");
  }

  async newSession(): Promise<void> {
    if (this.isRunning) {
      this.ui.status(this.status, "Cancel the active task before starting a new session.");
      return;
    }
    const history = this.extensionContext.workspaceState.get<Array<{ role: "user" | "assistant"; text: string }>>(
      "history",
      [],
    );
    const past = this.extensionContext.workspaceState.get<SavedSession[]>("pastSessions", []);
    if (history.length) {
      const firstUserMessage = history.find((item) => item.role === "user")?.text ?? "Conversation";
      const archived: SavedSession = {
        id: randomUUID(),
        label: firstUserMessage.slice(0, 70),
        messages: history,
      };
      await this.extensionContext.workspaceState.update("pastSessions", [...past, archived].slice(-20));
    }
    await this.extensionContext.workspaceState.update("history", []);
    this.viewingPastSession = false;
    this.ui.clear();
    this.publishSessions();
    this.ui.status(this.status, "New session started.");
  }

  async openSession(id: string): Promise<void> {
    if (this.isRunning) {
      this.ui.status(this.status, "Cancel the active task before switching conversations.");
      return;
    }
    if (id === "current") {
      this.viewingPastSession = false;
      this.ui.clear();
      await this.restoreHistory();
      return;
    }
    const saved = this.extensionContext.workspaceState
      .get<SavedSession[]>("pastSessions", [])
      .find((item) => item.id === id);
    if (!saved) {
      this.ui.status(this.status, "Saved conversation could not be found.");
      return;
    }
    this.viewingPastSession = true;
    this.ui.postHistory(saved.id, saved.messages);
  }

  private async runTask(userPrompt: string, signal: AbortSignal, approvalMode: ApprovalMode): Promise<void> {
    const configuration = vscode.workspace.getConfiguration("deepseekCodeAgent");
    const maxIterations = configuration.get<number>("maxIterations", 5);
    const responseLimit = configuration.get<number>("maxResponseBytes", 150_000);
    const contextLimit = configuration.get<number>("contextLimitBytes", 80_000);
    const collector = new ContextCollector(this.workspace);
    const boundedTaskPrompt = redactSecrets(buildTaskPrompt(userPrompt));
    const recentChanges = this.extensionContext.workspaceState.get<string[]>("recentAgentChanges", []);
    const requestedFiles = new Set<string>();
    const requestedSearches: string[] = [];
    const seenSearchResults = new Set<string>();
    let sentSearchCount = 0;
    let previouslySentContext:
      | {
          fileHashes: Map<string, string>;
          fullFiles: Set<string>;
          headerHash: string;
        }
      | undefined;
    let latestContext: CollectedContext;
    let verificationMessages: string[] = [];
    let previousSentContext: string | undefined;
    const responseSignatures = new Set<string>();

    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      this.throwIfCancelled(signal);
      this.transition("thinking", `Thinking · iteration ${iteration} of ${maxIterations}`);
      latestContext = await collector.collect(
        boundedTaskPrompt,
        contextLimit,
        [...requestedFiles],
        recentChanges,
        previouslySentContext,
      );
      previouslySentContext = {
        fileHashes: latestContext.contentHashes,
        fullFiles: latestContext.fullFiles,
        headerHash: latestContext.headerHash,
      };
      const missingFiles = [...requestedFiles].filter((path) => !latestContext.files.includes(path));
      const missingContext = missingFiles.length
        ? `\n\nRequested files not found, excluded for safety, or too large for the context budget: ${missingFiles.join(", ")}`
        : "";
      const errorContext = verificationMessages.length
        ? `Previous verification results (fix these; do not repeat a failed command unchanged):\n${verificationMessages.join("\n").slice(-12_000)}`
        : "";
      const newSearches = requestedSearches.slice(sentSearchCount);
      sentSearchCount = requestedSearches.length;
      const boundedContext = composeBoundedTaskContext(
        `${latestContext.text}\n${newSearches.join("\n\n")}${missingContext}`,
        errorContext,
        contextLimit,
      );
      const promptContext =
        boundedContext === previousSentContext
          ? "Workspace context is unchanged from the preceding task turn; use the context already supplied."
          : boundedContext;
      previousSentContext = boundedContext;
      this.throwIfCancelled(signal);
      this.transition("thinking", "Connecting to DeepSeek…");
      const response = await requestStructuredPlan(
        this.provider,
        boundedTaskPrompt,
        promptContext,
        responseLimit,
        signal,
        undefined,
        {
          includeProtocol: iteration === 1,
          onActivity: (activity) => this.ui.activity?.(activity),
        },
      );
      this.throwIfCancelled(signal);
      this.ui.approach?.(response.plan);
      this.transition("thinking", "Preparing changes…");
      const signature = createHash("sha256").update(JSON.stringify(response)).digest("hex");
      if (responseSignatures.has(signature) && verificationMessages.length) {
        throw new Error("DeepSeek repeated an identical failed proposal. Stopped to prevent a retry loop.");
      }
      responseSignatures.add(signature);

      if (response.clarification) {
        if (
          response.operations.length ||
          response.commands.length ||
          response.requestedFiles?.length ||
          response.searches?.length
        )
          throw new Error("A clarification response cannot also request context or propose changes.");
        this.transition("clarification", "Waiting for your clarification");
        const reply = response.clarification.trim();
        this.ui.append("assistant", reply);
        await this.persist("assistant", reply);
        return;
      }

      if (response.requestedFiles?.length || response.searches?.length) {
        if (response.operations.length || response.commands.length)
          throw new Error("A response cannot request more context and propose changes in the same step.");
        for (const file of response.requestedFiles ?? []) requestedFiles.add(file);
        for (const query of response.searches ?? []) {
          const matches = (await collector.search(query, 20)).filter((match) => {
            if (seenSearchResults.has(match)) return false;
            seenSearchResults.add(match);
            return true;
          });
          requestedSearches.push(`Search: ${query}\n${matches.join("\n") || "No new matches found."}`);
        }
        continue;
      }

      const staged = await this.stage(response, collector, latestContext);
      this.throwIfCancelled(signal);
      const configuredCommands = configuration.get<string[]>("verificationCommands", []);
      const commandsToRun = [...new Set([...response.commands, ...configuredCommands])];
      this.ui.proposal(
        response.plan,
        staged.map((change) => `${change.operation.type.toUpperCase()} ${change.operation.path}`),
        commandsToRun,
        response.verification,
      );
      if (staged.length) {
        const containsDeletion = staged.some((change) => change.operation.type === "delete");
        const requiresDiffReview = shouldAskForFileApproval(approvalMode, containsDeletion);
        if (requiresDiffReview) {
          this.transition(
            "waiting",
            containsDeletion
              ? "Waiting for approval · file changes include deletion(s)"
              : `Waiting for approval · ${staged.length} proposed file change(s)`,
          );
          const approved = await this.previewAndApprove(staged, response.plan, approvalMode === "review", signal);
          this.throwIfCancelled(signal);
          if (!approved) throw new Error("Task cancelled by user before applying the proposed changes.");
        }
        this.transition(
          "editing",
          `Applying ${staged.length} ${approvalMode === "review" ? "approved " : ""}file change(s)…`,
        );
        await this.applyChanges(staged, signal, approvalMode);
        recentChanges.push(...staged.map((change) => `${change.operation.type} ${change.operation.path}`));
        await this.extensionContext.workspaceState.update("recentAgentChanges", recentChanges.slice(-40));
      }

      const commandResults: CommandResult[] = [];
      for (const command of commandsToRun) {
        this.throwIfCancelled(signal);
        const trusted = configuration.get<string[]>("trustedCommands", []);
        if (shouldAskForCommandApproval(command, trusted, approvalMode))
          this.transition("waiting", `Waiting for approval · ${command}`);
        const result = await this.approveAndRun(command, signal, approvalMode);
        if (!result) throw new Error("Task cancelled before running a proposed command.");
        commandResults.push(result);
      }
      if (!commandResults.length) {
        const changeResult = staged.length
          ? approvalMode !== "review"
            ? `Applied ${staged.length} file change(s) in ${approvalMode === "auto-all" ? "auto-apply everything" : "safe auto"} mode.`
            : `Applied ${staged.length} approved file change(s).`
          : "No files were changed.";
        const message = `Intended summary: ${response.summary}\n\n${changeResult}\nVerification was not performed.${response.verification.length ? `\nProposed checks were not run: ${response.verification.join("; ")}` : ""}`;
        this.transition("completed", "Completed · verification not performed");
        this.ui.append("assistant", message);
        await this.persist("assistant", message);
        return;
      }

      const failed = commandResults.filter((result) => result.exitCode !== 0 || result.timedOut);
      const resultText = commandResults.map((result) =>
        `$ ${result.command}\nExit: ${result.exitCode === null ? "terminated" : result.exitCode}${result.timedOut ? " (timed out)" : ""}\n${result.stdout}\n${result.stderr}`.trim(),
      );
      if (!failed.length) {
        const changeResult = staged.length
          ? approvalMode !== "review"
            ? `Applied ${staged.length} file change(s) in ${approvalMode === "auto-all" ? "auto-apply everything" : "safe auto"} mode.`
            : `Applied ${staged.length} approved file change(s).`
          : "No files were changed.";
        const message = `Intended summary: ${response.summary}\n\n${changeResult}\nVerification passed:\n${commandResults.map((item) => `- ${item.command} (exit ${item.exitCode})\n${item.stdout.slice(-1_000)}${item.stderr ? `\n${item.stderr.slice(-1_000)}` : ""}`).join("\n")}`;
        this.transition("completed", "Completed · verification passed");
        this.ui.append("assistant", message);
        await this.persist("assistant", message);
        return;
      }
      for (const result of failed) {
        const failureKey = createHash("sha256")
          .update(`${result.command}\n${result.exitCode}\n${result.stdout}\n${result.stderr}`)
          .digest("hex");
        if (this.failedCommands.has(failureKey))
          throw new Error(`The same command failed twice; stopped retrying: ${result.command}`);
        this.failedCommands.add(failureKey);
      }
      verificationMessages = resultText;
      this.transition("thinking", `Verification failed · asking DeepSeek to diagnose`);
    }
    throw new Error(
      `The task reached the configured limit of ${maxIterations} iterations. Review current changes; verification may still be failing.`,
    );
  }

  private async stage(
    response: AgentResponse,
    collector: ContextCollector,
    context: CollectedContext,
  ): Promise<StagedChange[]> {
    const staged: StagedChange[] = [];
    for (const operation of response.operations) {
      const uri = await collector.resolveSafePath(operation.path);
      let beforeBytes: Uint8Array | undefined;
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if ((stat.type & vscode.FileType.Directory) !== 0)
          throw new Error(`Expected a file, not a directory: ${operation.path}`);
        beforeBytes = await vscode.workspace.fs.readFile(uri);
      } catch (error) {
        if (!(error instanceof vscode.FileSystemError) || error.code !== "FileNotFound") throw error;
      }
      if (operation.type === "create" && beforeBytes)
        throw new Error(`Cannot create ${operation.path}: the file already exists.`);
      if (operation.type !== "create" && !beforeBytes)
        throw new Error(`Cannot ${operation.type} ${operation.path}: the file does not exist.`);
      const openDocument = beforeBytes
        ? vscode.workspace.textDocuments.find((item) => item.uri.toString() === uri.toString())
        : undefined;
      if (openDocument?.isDirty)
        throw new Error(`Save ${operation.path} before asking the agent to edit it; the editor has unsaved changes.`);
      const existingDocument = openDocument ?? (beforeBytes ? await vscode.workspace.openTextDocument(uri) : undefined);
      const before = existingDocument?.getText() ?? "";
      if (before.includes("\0")) throw new Error(`Binary file operations are not supported: ${operation.path}`);
      if (beforeBytes && beforeBytes.length > 1_000_000)
        throw new Error(`File is too large for a safe text edit: ${operation.path}`);
      const diskHash = beforeBytes ? createHash("sha256").update(beforeBytes).digest("hex") : undefined;
      if (operation.type !== "create") {
        const contextHash = context.fingerprints.get(operation.path);
        if (!contextHash)
          throw new Error(
            `DeepSeek proposed changing ${operation.path} without receiving its contents. Request the file as context and try again.`,
          );
        if (contextHash !== diskHash)
          throw new Error(
            `${operation.path} changed while DeepSeek was preparing the proposal. Re-run the task with fresh context.`,
          );
      }
      let after = before;
      if (operation.type === "create") after = operation.content;
      if (operation.type === "replace") {
        for (const edit of operation.edits) {
          const occurrences = countOccurrences(after, edit.search);
          const expected = edit.expectedOccurrences ?? 1;
          if (occurrences !== expected)
            throw new Error(
              `Edit for ${operation.path} expected ${expected} exact occurrence(s), found ${occurrences}. No changes were applied.`,
            );
          after = after.split(edit.search).join(edit.replace);
        }
      }
      if (operation.type === "delete") after = "";
      staged.push({
        operation,
        uri,
        before,
        after,
        diskHash,
        originalBytes: beforeBytes,
        originalDocument: existingDocument,
      });
    }
    return staged;
  }

  private async previewAndApprove(
    staged: StagedChange[],
    plan: string,
    requireApproval = true,
    signal?: AbortSignal,
  ): Promise<boolean> {
    for (const change of staged) {
      const original =
        change.originalDocument ??
        (change.diskHash
          ? await vscode.workspace.openTextDocument(change.uri)
          : await vscode.workspace.openTextDocument({ content: "", language: languageFor(change.operation.path) }));
      const content = normalizeEol(change.after, original.eol);
      const proposed = await vscode.workspace.openTextDocument({
        language: original.languageId || languageFor(change.operation.path),
        content,
      });
      await vscode.commands.executeCommand(
        "vscode.diff",
        original.uri,
        proposed.uri,
        `${change.operation.type}: ${change.operation.path}`,
      );
    }
    if (!requireApproval) return true;
    if (!signal) throw new Error("An abort signal is required for file approval.");
    return (
      (await this.ui.requestApproval?.(
        "Review proposed file changes",
        `${plan}\n\nReview the open diffs. Apply ${staged.length} proposed file change(s)?`,
        "Apply changes",
        signal,
      )) ?? false
    );
  }

  private async applyChanges(staged: StagedChange[], signal: AbortSignal, approvalMode: ApprovalMode): Promise<void> {
    for (const change of staged) {
      if (change.operation.type === "delete" && approvalMode !== "auto-all") {
        this.transition("waiting", `Waiting for deletion approval · ${change.operation.path}`);
        const approved =
          (await this.ui.requestApproval?.(
            "Confirm file deletion",
            `Delete ${change.operation.path}? A backup will be kept in extension storage.`,
            "Delete file",
            signal,
          )) ?? false;
        this.throwIfCancelled(signal);
        if (!approved)
          throw new Error(`Task cancelled by user: deletion was not approved for ${change.operation.path}.`);
        this.transition("editing", `Deleting approved file · ${change.operation.path}`);
      }
    }
    for (const change of staged) {
      if (change.diskHash) {
        const bytes = await vscode.workspace.fs.readFile(change.uri);
        const currentHash = createHash("sha256").update(bytes).digest("hex");
        if (currentHash !== change.diskHash)
          throw new Error(
            `${change.operation.path} changed after the proposal was shown. Nothing further was applied.`,
          );
      } else {
        try {
          await vscode.workspace.fs.stat(change.uri);
          throw new Error(`${change.operation.path} was created after the proposal was shown.`);
        } catch (error) {
          if (!(error instanceof vscode.FileSystemError) || error.code !== "FileNotFound") throw error;
        }
      }
    }
    for (const change of staged) {
      this.throwIfCancelled(signal);
      if (change.operation.type === "delete") await this.backup(change);
      if (change.operation.type === "create") {
        await vscode.workspace.fs.createDirectory(parentUri(change.uri));
      }
    }
    this.throwIfCancelled(signal);
    const edit = new vscode.WorkspaceEdit();
    for (const change of staged) {
      if (change.operation.type === "delete") {
        edit.deleteFile(change.uri, { ignoreIfNotExists: false, recursive: false });
      } else if (change.operation.type === "create") {
        edit.createFile(change.uri, { ignoreIfExists: false });
        edit.insert(change.uri, new vscode.Position(0, 0), change.after);
      } else {
        const document = change.originalDocument ?? (await vscode.workspace.openTextDocument(change.uri));
        const fullRange = new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length));
        edit.replace(change.uri, fullRange, normalizeEol(change.after, document.eol));
      }
    }
    if (!(await vscode.workspace.applyEdit(edit)))
      throw new Error("VS Code could not apply the approved workspace edit. No success was reported.");
    for (const change of staged) {
      if (change.operation.type === "delete") continue;
      const document = await vscode.workspace.openTextDocument(change.uri);
      if (!(await document.save()))
        throw new Error(`VS Code could not save the approved edit to ${change.operation.path}.`);
    }
  }

  private async backup(change: StagedChange): Promise<void> {
    const directory = vscode.Uri.joinPath(this.extensionContext.globalStorageUri, "backups");
    await vscode.workspace.fs.createDirectory(directory);
    const filename = `${Date.now()}-${createHash("sha256").update(change.operation.path).digest("hex").slice(0, 12)}-${(change.operation.path.split("/").at(-1) ?? "file").slice(0, 100)}`;
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(directory, filename),
      change.originalBytes ?? new TextEncoder().encode(change.before),
    );
  }

  private async approveAndRun(
    command: string,
    signal: AbortSignal,
    approvalMode: ApprovalMode,
  ): Promise<CommandResult | undefined> {
    const parsed = parseSafeCommand(command);
    const trusted = vscode.workspace.getConfiguration("deepseekCodeAgent").get<string[]>("trustedCommands", []);
    if (shouldAskForCommandApproval(command, trusted, approvalMode)) {
      const approved =
        (await this.ui.requestApproval?.(
          "Run proposed command?",
          `Run this exact command in the workspace?\n\n${command}`,
          "Run command",
          signal,
        )) ?? false;
      this.throwIfCancelled(signal);
      if (!approved) return undefined;
    }
    this.transition(
      "testing",
      `Running ${approvalMode === "auto-all" ? "automatically approved" : "approved"} command: ${command}`,
    );
    return runProcess(
      parsed,
      this.workspace,
      signal,
      vscode.workspace.getConfiguration("deepseekCodeAgent").get<number>("commandTimeoutSeconds", 120) * 1000,
    );
  }

  private transition(status: TaskStatus, message: string): void {
    this.taskState.transition(status);
    this.ui.status(status, message);
  }

  private throwIfCancelled(signal: AbortSignal): void {
    if (signal.aborted) throw new Error("Task cancelled.");
  }

  private async persist(role: "user" | "assistant", text: string): Promise<void> {
    const history = this.extensionContext.workspaceState.get<Array<{ role: "user" | "assistant"; text: string }>>(
      "history",
      [],
    );
    const next = [...history, { role, text: redactSecrets(text).slice(0, 16_000) }].slice(-40);
    await this.extensionContext.workspaceState.update("history", next);
  }

  private publishSessions(): void {
    const past = this.extensionContext.workspaceState.get<SavedSession[]>("pastSessions", []);
    this.ui.postSessions(past.map(({ id, label }) => ({ id, label })));
  }
}

function countOccurrences(text: string, search: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(search, offset)) !== -1) {
    count += 1;
    offset += search.length;
  }
  return count;
}

function normalizeEol(content: string, eol: vscode.EndOfLine): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  return lines.join(eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n");
}

function parentUri(uri: vscode.Uri): vscode.Uri {
  return uri.with({ path: uri.path.slice(0, uri.path.lastIndexOf("/")) });
}

function languageFor(path: string): string {
  const extension = extname(path).slice(1).toLowerCase();
  const languages: Record<string, string> = {
    ts: "typescript",
    tsx: "typescriptreact",
    js: "javascript",
    jsx: "javascriptreact",
    py: "python",
    json: "json",
    md: "markdown",
    css: "css",
    html: "html",
  };
  return languages[extension] ?? "plaintext";
}

function runProcess(
  parsed: ParsedCommand,
  workspace: vscode.WorkspaceFolder,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<CommandResult> {
  const invocation = resolveExecutable(parsed);
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(invocation.executable, invocation.args, {
        cwd: workspace.uri.fsPath,
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      reject(
        new Error(`Could not start ${parsed.executable}: ${error instanceof Error ? error.message : "process error"}`),
      );
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const append = (current: string, chunk: Buffer): string => `${current}${chunk.toString("utf8")}`.slice(-30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    const kill = () => child.kill();
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", kill);
    };
    signal.addEventListener("abort", kill, { once: true });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Could not execute ${parsed.executable}: ${error.message}`));
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ command: [parsed.executable, ...parsed.args].join(" "), exitCode, stdout, stderr, timedOut });
    });
  });
}

function resolveExecutable(command: ParsedCommand): { executable: string; args: string[] } {
  if (process.platform === "win32" && /^(npm|npm\.cmd)$/i.test(command.executable)) {
    const cli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    if (!existsSync(cli)) throw new Error("Could not locate the installed npm CLI next to Node.js.");
    return { executable: process.execPath, args: [cli, ...command.args] };
  }
  return { executable: command.executable, args: command.args };
}
