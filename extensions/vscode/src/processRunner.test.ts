import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveExecutable, runProcess } from "./processRunner";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error("Timed out waiting for the child process to start.");
}

describe("process runner", () => {
  it("uses the Windows Python launcher instead of the Store alias when available", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deepseek-agent-python-"));
    temporaryDirectories.push(directory);
    const launcher = join(directory, "py.exe");
    await writeFile(launcher, "");

    expect(resolveExecutable({ executable: "python", args: ["fix.py"] }, "win32", directory)).toEqual({
      executable: launcher,
      args: ["-3", "fix.py"],
    });
    expect(resolveExecutable({ executable: "C:\\Python\\python.exe", args: ["fix.py"] }, "win32", directory)).toEqual({
      executable: "C:\\Python\\python.exe",
      args: ["fix.py"],
    });
    expect(resolveExecutable({ executable: "python", args: ["fix.py"] }, "win32", "")).toEqual({
      executable: "python",
      args: ["fix.py"],
    });
  });

  it("captures command output and exit status", async () => {
    const result = await runProcess(
      { executable: process.execPath, args: ["-e", 'process.stdout.write("ok"); process.stderr.write("warn")'] },
      process.cwd(),
      new AbortController().signal,
      5_000,
    );
    expect(result).toMatchObject({ exitCode: 0, stdout: "ok", stderr: "warn", timedOut: false });
  });

  it("terminates the process tree when a command is cancelled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deepseek-agent-process-"));
    temporaryDirectories.push(directory);
    const pidPath = join(directory, "child.pid");
    const readyPath = join(directory, "child-ready");
    const signalPath = join(directory, "child-stopped");
    const childCode = [
      'const fs = require("node:fs");',
      `process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(signalPath)}, "stopped"); process.exit(0); });`,
      `fs.writeFileSync(${JSON.stringify(readyPath)}, "ready");`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const parentCode = [
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      `const child = spawn(process.execPath, ["-e", ${JSON.stringify(childCode)}], { stdio: "ignore" });`,
      `fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const controller = new AbortController();
    const running = runProcess(
      { executable: process.execPath, args: ["-e", parentCode] },
      directory,
      controller.signal,
      10_000,
    );
    const childPid = Number(await waitForFile(pidPath));
    await waitForFile(readyPath);
    controller.abort();
    const result = await running;
    expect(result.exitCode).not.toBe(0);

    if (process.platform !== "win32") {
      await waitForFile(signalPath);
    } else {
      await expect(
        runProcess(
          { executable: process.execPath, args: ["-e", `process.kill(${childPid}, 0)`] },
          directory,
          new AbortController().signal,
          5_000,
        ),
      ).resolves.toMatchObject({ exitCode: 1 });
    }
  });

  it("does not start a command for an already-cancelled task", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runProcess(
        { executable: process.execPath, args: ["-e", "process.exit(0)"] },
        process.cwd(),
        controller.signal,
        5_000,
      ),
    ).rejects.toThrow(/cancelled/);
  });

  it("times out commands and terminates their process tree", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deepseek-agent-timeout-"));
    temporaryDirectories.push(directory);
    const result = await runProcess(
      { executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] },
      directory,
      new AbortController().signal,
      50,
    );
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });
});
