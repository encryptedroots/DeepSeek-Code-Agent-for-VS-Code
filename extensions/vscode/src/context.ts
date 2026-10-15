import * as vscode from "vscode";
import { createHash } from "node:crypto";
import { isSafeRelativePath, redactSecrets } from "./safety";
import {
  buildOverviewInventoryText,
  buildOverviewFileBatches,
  findMentionedWorkspacePaths,
  isOverviewInventoryPath,
  rankWorkspacePaths,
  relevantExcerpt,
  taskTerms,
  truncateUtf8,
  type OverviewSourceFile,
} from "./contextRanking";
export { isSafeRelativePath, redactSecrets } from "./safety";

const DEFAULT_EXCLUDES = [
  "**/node_modules/**",
  "**/vendor/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/coverage/**",
  "**/.git/**",
  "**/.svn/**",
  "**/.hg/**",
  "**/.next/**",
  "**/.cache/**",
  "**/.turbo/**",
  "**/target/**",
  "**/.venv/**",
  "**/venv/**",
  "**/__pycache__/**",
  "**/.idea/**",
  "**/.vscode-test/**",
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/*secret*",
  "**/*credential*",
  "**/id_rsa*",
  "**/id_ed25519*",
  "**/.npmrc",
  "**/.pypirc",
  "**/credentials",
];
export interface CollectedContext {
  text: string;
  files: string[];
  fingerprints: Map<string, string>;
  contentHashes: Map<string, string>;
  fullFiles: Set<string>;
  headerHash: string;
  fileRequestStatuses: Map<string, "included" | "previously included" | "unavailable" | "too large" | "over budget">;
}

export interface OverviewInventory {
  paths: string[];
  discoveredFileCount: number;
  discoveryTruncated: boolean;
  text: string;
  listedPaths: string[];
  omittedCount: number;
}

export interface CollectedOverviewFiles {
  batches: Array<{ text: string; completedPaths: string[] }>;
  deliveredPaths: string[];
  unavailablePaths: string[];
  tooLargePaths: string[];
  overBudgetPaths: string[];
  deferredPaths: string[];
  bytesRead: number;
}

interface GitRepository {
  rootUri: vscode.Uri;
  diff(cached?: boolean): Promise<string>;
  log(options?: { maxEntries?: number }): Promise<Array<{ message: string }>>;
}

interface GitExtensionExports {
  getAPI(version: 1): { repositories: GitRepository[] };
}

export class ContextCollector {
  constructor(private readonly workspace: vscode.WorkspaceFolder) {}

  async collectOverviewInventory(limit: number): Promise<OverviewInventory> {
    const config = vscode.workspace.getConfiguration("deepseekCodeAgent");
    const customExcludes = config.get<string[]>("excludedGlobs", []);
    const excludePattern = `{${[...DEFAULT_EXCLUDES, ...customExcludes].join(",")}}`;
    const allFiles = await vscode.workspace.findFiles(
      new vscode.RelativePattern(this.workspace, "**/*"),
      excludePattern,
      2000,
    );
    const discovered = allFiles.map((uri) => ({
      uri,
      path: vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/"),
    }));
    const inventoryPaths = discovered
      .map(({ path }) => path)
      .filter(isOverviewInventoryPath)
      .sort((left, right) => left.localeCompare(right));
    const inventory = buildOverviewInventoryText(
      this.workspace.name,
      inventoryPaths,
      Math.max(1, Math.floor(limit * 0.8)),
    );
    return {
      paths: inventoryPaths,
      discoveredFileCount: discovered.length,
      discoveryTruncated: discovered.length === 2000,
      text: inventory.text,
      listedPaths: inventory.includedPaths,
      omittedCount: inventory.omittedCount,
    };
  }

  async collectOverviewFiles(
    requestedPaths: string[],
    limit: number,
    signal: AbortSignal,
    maxFiles = 10,
    remainingReadBudget = 300_000,
  ): Promise<CollectedOverviewFiles> {
    const config = vscode.workspace.getConfiguration("deepseekCodeAgent");
    const customExcludes = config.get<string[]>("excludedGlobs", []);
    const excludePattern = `{${[...DEFAULT_EXCLUDES, ...customExcludes].join(",")}}`;
    const allFiles = await vscode.workspace.findFiles(
      new vscode.RelativePattern(this.workspace, "**/*"),
      excludePattern,
      2000,
    );
    const availablePaths = new Set(
      allFiles
        .map((uri) => vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/"))
        .filter(isOverviewInventoryPath),
    );
    const uniquePaths = [...new Set(requestedPaths)];
    const selectedPaths = uniquePaths.slice(0, maxFiles);
    const result: CollectedOverviewFiles = {
      batches: [],
      deliveredPaths: [],
      unavailablePaths: uniquePaths.filter((path) => !availablePaths.has(path)),
      tooLargePaths: [],
      overBudgetPaths: [],
      deferredPaths: uniquePaths.slice(maxFiles),
      bytesRead: 0,
    };
    const sourceFiles: OverviewSourceFile[] = [];
    let bytesUsed = 0;
    for (const path of selectedPaths) {
      if (signal.aborted) throw new Error("Task cancelled while reading requested workspace files.");
      if (!availablePaths.has(path)) continue;
      let safeUri: vscode.Uri;
      try {
        safeUri = await this.resolveSafePath(path);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Symbolic links are not allowed")) {
          result.unavailablePaths.push(path);
          continue;
        }
        throw error;
      }
      let stat: vscode.FileStat;
      try {
        stat = await vscode.workspace.fs.stat(safeUri);
      } catch (error) {
        if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") {
          result.unavailablePaths.push(path);
          continue;
        }
        throw error;
      }
      if ((stat.type & vscode.FileType.Directory) !== 0 || stat.size > 1_000_000) {
        result.tooLargePaths.push(path);
        continue;
      }
      if (stat.size > remainingReadBudget - bytesUsed) {
        result.overBudgetPaths.push(path);
        continue;
      }
      let bytes: Uint8Array;
      try {
        bytes = await vscode.workspace.fs.readFile(safeUri);
      } catch (error) {
        if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") {
          result.unavailablePaths.push(path);
          continue;
        }
        throw error;
      }
      if (bytes.byteLength > remainingReadBudget - bytesUsed) {
        result.overBudgetPaths.push(path);
        continue;
      }
      if (bytes.subarray(0, Math.min(bytes.length, 8_000)).includes(0)) {
        result.unavailablePaths.push(path);
        continue;
      }
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        result.unavailablePaths.push(path);
        continue;
      }
      const file = { path, content: redactSecrets(content) };
      sourceFiles.push(file);
      result.deliveredPaths.push(path);
      bytesUsed += bytes.byteLength;
    }
    result.bytesRead = bytesUsed;
    result.batches = buildOverviewFileBatches(sourceFiles, Math.max(1, Math.floor(limit * 0.75)));
    return result;
  }

  async collect(
    prompt: string,
    limit: number,
    explicitFiles: string[] = [],
    recentChanges: string[] = [],
    previouslySent?: { fileHashes: Map<string, string>; fullFiles: Set<string>; headerHash: string },
  ): Promise<CollectedContext> {
    const config = vscode.workspace.getConfiguration("deepseekCodeAgent");
    const customExcludes = config.get<string[]>("excludedGlobs", []);
    const excludePattern = `{${[...DEFAULT_EXCLUDES, ...customExcludes].join(",")}}`;
    const allFiles = await vscode.workspace.findFiles(
      new vscode.RelativePattern(this.workspace, "**/*"),
      excludePattern,
      2000,
    );
    const relative = allFiles.map((uri) => vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/"));
    const suppliedFiles = [...new Set([...explicitFiles, ...findMentionedWorkspacePaths(relative, prompt)])];
    const editor = vscode.window.activeTextEditor;
    const candidatePath =
      editor?.document.uri.scheme === "file" && this.belongsToWorkspace(editor.document.uri)
        ? vscode.workspace.asRelativePath(editor.document.uri, false).replace(/\\/g, "/")
        : undefined;
    const activePath = candidatePath && relative.includes(candidatePath) ? candidatePath : undefined;
    const ranked = rankWorkspacePaths(relative, prompt, activePath);
    const selected = new Set([...suppliedFiles.filter((path) => relative.includes(path)), ...ranked.slice(0, 14)]);
    if (activePath) selected.add(activePath);
    const fingerprints = new Map<string, string>();
    const tree = truncateUtf8(ranked.slice(0, 80).join("\n"), Math.min(6_000, Math.floor(limit / 10)));
    const relevantChanges = recentChanges
      .slice(-40)
      .filter((change) => taskTerms(prompt).some((term) => change.toLowerCase().includes(term)))
      .slice(-10);
    const includedFiles: string[] = [];
    const selectedInstructions = ranked
      .filter((path) =>
        /(?:^|\/)(?:agents\.md|claude\.md|copilot-instructions\.md|[^/]+\.instructions\.md)$/i.test(path),
      )
      .slice(0, 8);
    const selection =
      editor && activePath
        ? `\n--- Active editor selection (${activePath}) ---\n${redactSecrets(editor.document.getText(editor.selection).slice(0, 8_000)) || "[No selection]"}`
        : "";
    const diagnostics = vscode.languages
      .getDiagnostics()
      .flatMap(([uri, entries]) => {
        if (!this.belongsToWorkspace(uri)) return [];
        return entries
          .filter((item) => item.severity === vscode.DiagnosticSeverity.Error)
          .slice(0, 8)
          .map((item) =>
            redactSecrets(
              `${vscode.workspace.asRelativePath(uri, false)}:${item.range.start.line + 1}: ${item.message.slice(0, 300)}`,
            ),
          );
      })
      .slice(0, 40);
    const gitContext = truncateUtf8(await this.gitContext(prompt, activePath), Math.min(5_000, Math.floor(limit / 8)));
    const header = [
      `Workspace: ${this.workspace.name}`,
      `Task-relevant file paths (up to ${Math.min(ranked.length, 80)} of ${relative.length} files):\n${tree}`,
      `Project instructions to follow: ${selectedInstructions.join(", ") || "None found"}`,
      `VS Code error diagnostics:\n${truncateUtf8(diagnostics.join("\n") || "None", 3_000)}`,
      `Recent task-relevant agent changes:\n${truncateUtf8(relevantChanges.join("\n") || "None", 1_000)}`,
      gitContext,
      selection,
    ].join("\n\n");
    const headerHash = createHash("sha256").update(header).digest("hex");
    let text =
      previouslySent?.headerHash === headerHash ? "" : truncateUtf8(header, Math.min(20_000, Math.floor(limit * 0.3)));
    const seenContentHashes = new Set<string>();
    const contentHashes = new Map<string, string>();
    const fullFiles = new Set<string>();
    const fileRequestStatuses = new Map<
      string,
      "included" | "previously included" | "unavailable" | "too large" | "over budget"
    >();
    for (const path of suppliedFiles) {
      if (!relative.includes(path)) fileRequestStatuses.set(path, "unavailable");
    }
    for (const path of selected) {
      if (!relative.includes(path)) continue;
      const uri = vscode.Uri.joinPath(this.workspace.uri, ...path.split("/"));
      const bytes = await vscode.workspace.fs.readFile(uri);
      const isExplicit = suppliedFiles.includes(path);
      const content = redactSecrets(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
      const isFull = isExplicit || bytes.length <= 6_000;
      const contentHash = createHash("sha256").update(content).digest("hex");
      const fileHash = createHash("sha256").update(bytes).digest("hex");
      if (previouslySent?.fileHashes.get(path) === fileHash) {
        contentHashes.set(path, fileHash);
        if (previouslySent.fullFiles.has(path)) {
          fullFiles.add(path);
          includedFiles.push(path);
          fingerprints.set(path, fileHash);
          if (isExplicit) fileRequestStatuses.set(path, "previously included");
          continue;
        }
        if (!isExplicit) continue;
      }
      if (!isExplicit && seenContentHashes.has(contentHash)) continue;
      const excerpt = isFull ? content : relevantExcerpt(content, prompt, 5_000);
      const block = `\n--- ${path}${isFull ? "" : " (relevant excerpt)"} ---\n${excerpt}`;
      if (Buffer.byteLength(`${text}${block}`, "utf8") > limit) {
        if (isExplicit) fileRequestStatuses.set(path, "over budget");
        break;
      }
      text += block;
      seenContentHashes.add(contentHash);
      contentHashes.set(path, fileHash);
      if (isFull) {
        includedFiles.push(path);
        fingerprints.set(path, fileHash);
        fullFiles.add(path);
        if (isExplicit) fileRequestStatuses.set(path, "included");
      }
    }
    for (const path of suppliedFiles) {
      if (!fileRequestStatuses.has(path)) fileRequestStatuses.set(path, "over budget");
    }
    return { text, files: includedFiles, fingerprints, contentHashes, fullFiles, headerHash, fileRequestStatuses };
  }

  private async gitContext(task: string, activePath?: string): Promise<string> {
    const extension = vscode.extensions.getExtension<GitExtensionExports>("vscode.git");
    if (!extension) return "Git changes: Git extension is unavailable.";
    const api = extension.isActive ? extension.exports : await extension.activate();
    const workspaceRoot = this.workspace.uri.toString().replace(/\/$/, "");
    const repository = api
      .getAPI(1)
      .repositories.find((item) => item.rootUri.toString().replace(/\/$/, "") === workspaceRoot);
    if (!repository) return "Git changes: workspace is not a Git repository.";
    const terms = taskTerms(task);
    const diff = redactSecrets(await repository.diff(false));
    const diffSections = diff.split(/(?=^diff --git )/m).filter((section) => section.trim());
    const relevantDiff = diffSections.filter((section) => {
      const path = /^diff --git a\/(.+?) b\//m.exec(section)?.[1] ?? "";
      return path === activePath || terms.some((term) => path.toLowerCase().includes(term));
    });
    const commits = redactSecrets(
      (await repository.log({ maxEntries: 10 }))
        .map((item) => item.message.split(/\r?\n/, 1)[0])
        .filter((message) => terms.some((term) => message.toLowerCase().includes(term)))
        .slice(0, 3)
        .join("\n"),
    );
    return `Task-relevant working-tree diff:\n${relevantDiff.join("\n").slice(0, 5_000) || "No task-relevant diff"}\n\nTask-relevant recent commits:\n${commits || "No relevant commits"}`;
  }

  async search(query: string, maxHits = 20): Promise<string[]> {
    const needle = query.trim().toLowerCase();
    if (!needle) throw new Error("Workspace search terms must not be empty.");
    const excludes = vscode.workspace.getConfiguration("deepseekCodeAgent").get<string[]>("excludedGlobs", []);
    const excludePattern = `{${[...DEFAULT_EXCLUDES, ...excludes].join(",")}}`;
    const files = await vscode.workspace.findFiles(
      new vscode.RelativePattern(this.workspace, "**/*"),
      excludePattern,
      500,
    );
    const results: string[] = [];
    for (const uri of files) {
      if (results.length >= maxHits) break;
      const path = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
      if (!/\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|cs|cpp|h|hpp|html|css|json|ya?ml|md)$/i.test(path)) continue;
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.length > 50_000) continue;
      const lines = redactSecrets(new TextDecoder().decode(bytes)).split(/\r?\n/);
      lines.forEach((line, index) => {
        if (line.toLowerCase().includes(needle) && results.length < maxHits) {
          results.push(`${path}:${index + 1}: ${line.trim().slice(0, 300)}`);
        }
      });
    }
    return results;
  }

  async resolveSafePath(path: string): Promise<vscode.Uri> {
    if (!isSafeRelativePath(path)) throw new Error(`Unsafe workspace path: ${path}`);
    let current = this.workspace.uri;
    let existingAncestors = true;
    const parts = path.split("/");
    for (const [index, part] of parts.entries()) {
      current = vscode.Uri.joinPath(current, part);
      if (!existingAncestors) continue;
      try {
        const stat = await vscode.workspace.fs.stat(current);
        if ((stat.type & vscode.FileType.SymbolicLink) !== 0)
          throw new Error(`Symbolic links are not allowed in agent paths: ${path}`);
        if (index < parts.length - 1 && (stat.type & vscode.FileType.Directory) === 0)
          throw new Error(`A parent path is not a directory: ${path}`);
      } catch (error) {
        if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") {
          existingAncestors = false;
          continue;
        }
        if (error instanceof Error && error.message.startsWith("Symbolic links")) throw error;
        if (error instanceof Error && error.message.startsWith("A parent path")) throw error;
        throw error;
      }
    }
    return current;
  }

  private belongsToWorkspace(uri: vscode.Uri): boolean {
    const root = this.workspace.uri.toString().replace(/\/$/, "");
    return uri.toString() === root || uri.toString().startsWith(`${root}/`);
  }
}
