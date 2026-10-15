import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import type { ParsedCommand } from "./commandSafety";

export interface CommandResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function runProcess(
  parsed: ParsedCommand,
  cwd: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<CommandResult> {
  if (signal.aborted) return Promise.reject(new Error("Task cancelled."));
  let invocation: { executable: string; args: string[] };
  try {
    invocation = resolveExecutable(parsed);
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error("Could not resolve the command executable."));
  }
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(invocation.executable, invocation.args, {
        cwd,
        shell: false,
        detached: process.platform !== "win32",
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
    let terminationRequested = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const append = (current: string, chunk: Buffer): string => `${current}${chunk.toString("utf8")}`.slice(-30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    const kill = () => {
      if (terminationRequested) return;
      terminationRequested = true;
      const pid = child.pid;
      if (!pid) {
        child.kill();
        return;
      }
      if (process.platform === "win32") {
        const treeKiller = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        treeKiller.once("error", () => child.kill());
        treeKiller.once("close", (exitCode) => {
          if (exitCode !== 0) child.kill();
        });
        return;
      }
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      forceKillTimer = setTimeout(() => {
        try {
          process.kill(-pid, 0);
          process.kill(-pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, 1_000);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", kill);
      if (!terminationRequested && forceKillTimer) clearTimeout(forceKillTimer);
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

export function resolveExecutable(
  command: ParsedCommand,
  platform = process.platform,
  pathValue = process.env.PATH ?? "",
): { executable: string; args: string[] } {
  if (platform === "win32" && /^python(?:\.exe)?$/i.test(command.executable)) {
    const launcher = pathValue
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => join(directory, "py.exe"))
      .find(existsSync);
    if (launcher) return { executable: launcher, args: ["-3", ...command.args] };
  }
  if (platform === "win32" && /^(npm|npm\.cmd)$/i.test(command.executable)) {
    const cli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    if (!existsSync(cli)) throw new Error("Could not locate the installed npm CLI next to Node.js.");
    return { executable: process.execPath, args: [cli, ...command.args] };
  }
  return { executable: command.executable, args: command.args };
}
