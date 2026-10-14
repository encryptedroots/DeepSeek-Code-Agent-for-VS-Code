export interface ParsedCommand {
  executable: string;
  args: string[];
}

export type ApprovalMode = "review" | "safe-auto" | "auto-all";

const TOKEN = /^[\w@./:=+,-]+$/;
const SAFE_NPM_COMMANDS = ["run", "test", "start", "list", "ls", "help", "prefix", "root"];

export function parseSafeCommand(command: string): ParsedCommand {
  if (command.length > 2_000 || /[\r\n;&|<>^%!`]/.test(command))
    throw new Error("Command contains unsupported or unsafe shell syntax.");
  const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const values = tokens.map((token) => {
    const unquoted = token.startsWith('"') || token.startsWith("'") ? token.slice(1, -1) : token;
    if (!unquoted || !TOKEN.test(unquoted)) throw new Error("Command contains unsupported characters or arguments.");
    return unquoted;
  });
  const executable = values.shift();
  if (
    !executable ||
    !/^(?:npm(?:\.cmd)?|npx(?:\.cmd)?|node(?:\.exe)?|git(?:\.exe)?|python(?:\.exe)?|pytest|vitest|tsc|eslint|prettier)$/i.test(
      executable,
    )
  ) {
    throw new Error("Only approved development tools (npm, node, git, Python, and common test/lint tools) can be run.");
  }
  const normalizedExecutable = executable.replace(/\.(?:cmd|exe)$/i, "").toLowerCase();
  const firstArgument = values[0]?.toLowerCase();
  if (normalizedExecutable === "npx")
    throw new Error("npx is blocked because it can download and run untrusted packages.");
  if (normalizedExecutable === "npm" && !SAFE_NPM_COMMANDS.includes(firstArgument ?? ""))
    throw new Error("Only npm run/test/start and read-only npm inspection commands are allowed.");
  if (normalizedExecutable === "python" && !(values[0] === "-m" && ["pytest", "unittest"].includes(values[1] ?? ""))) {
    throw new Error("Python commands are limited to the pytest and unittest test runners.");
  }
  if (
    normalizedExecutable === "git" &&
    !["status", "diff", "log", "show", "branch"].includes((values[0] ?? "").toLowerCase())
  ) {
    throw new Error("Only read-only Git commands (status, diff, log, show, branch) are allowed.");
  }
  if (normalizedExecutable === "git" && values.some((value) => /^--output(?:=|$)|^-O$/.test(value))) {
    throw new Error("Git output redirection is not allowed.");
  }
  if (
    normalizedExecutable === "git" &&
    values[0]?.toLowerCase() === "branch" &&
    values.slice(1).some((value) => /^-(?:d|D|m|M|c|C|f)$|^--(?:delete|move|copy|force)(?:=|$)/.test(value))
  ) {
    throw new Error("Git branch mutation commands are not allowed.");
  }
  return { executable, args: values };
}

export function isTrustedCommand(command: string, trusted: string[]): boolean {
  return trusted.some((entry) => entry.trim() === command.trim());
}

export function shouldAskForCommandApproval(command: string, trusted: string[], mode: ApprovalMode): boolean {
  if (mode === "review") return true;
  if (mode === "auto-all") return false;
  return !isTrustedCommand(command, trusted);
}

export function shouldAskForFileApproval(mode: ApprovalMode, containsDeletion: boolean): boolean {
  return mode === "review" || (mode === "safe-auto" && containsDeletion);
}
