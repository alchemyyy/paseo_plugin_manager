import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";

// JSON from the Paseo CLI is read whole; npm's chatter keeps only its tail
const MAX_STDOUT_CHARACTERS = 4 * 1024 * 1024;
const MAX_STDERR_CHARACTERS = 64 * 1024;
const MAX_DETAIL_LINES = 12;
// cmd.exe's message when a `.cmd` launcher or bare command name is not on PATH
const NOT_RECOGNIZED = /is not recognized as an internal or external command/i;

/** A command that failed, with what it printed */
export class CommandError extends Error {
  readonly stdout: string;
  readonly stderr: string;

  constructor(message: string, stdout: string, stderr: string) {
    super(message);
    this.name = "CommandError";
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export interface RunOptions {
  /** Names the command in errors, such as "git fetch" */
  label: string;
  cwd?: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** false starts the executable directly, without cmd.exe; default: cmd.exe for `.cmd` files and bare names */
  shell?: boolean;
}

/**
 * Runs a command to completion and resolves with its stdout. stdin is closed so nothing waits on a
 * prompt, and a timeout kills the whole process tree: `.cmd` launchers such as npm and paseo leave
 * their real process behind cmd.exe.
 */
export function runCommand(command: string, args: string[], options: RunOptions): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnProcess(command, args, { cwd: options.cwd, env: options.env, shell: options.shell, stdio: "pipe" });
  } catch (error) {
    reject(new CommandError(`${options.label}: ${error instanceof Error ? error.message : String(error)}`, "", ""));
    return promise;
  }
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    terminateProcess(child).catch(() => {});
  }, options.timeoutMs);
  const fail = (message: string) => {
    clearTimeout(timer);
    reject(new CommandError(message, stdout, stderr));
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (stdout.length < MAX_STDOUT_CHARACTERS) stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-MAX_STDERR_CHARACTERS);
  });
  child.stdin.on("error", () => {});
  child.stdin.end();
  child.on("error", (error: NodeJS.ErrnoException) => {
    fail(`${options.label}: ${error.code === "ENOENT" ? `${command} was not found` : error.message}`);
  });
  child.on("close", (exitCode) => {
    if (timedOut) {
      fail(`${options.label} timed out after ${Math.round(options.timeoutMs / 1000)} s`);
    } else if (exitCode === 0) {
      clearTimeout(timer);
      resolve(stdout);
    } else if (NOT_RECOGNIZED.test(stderr)) {
      fail(`${options.label}: ${command} was not found on PATH`);
    } else {
      // git, npm, and paseo put the reason in the last lines of stderr
      const reason = stderr
        .split(/\r?\n/)
        .filter((line) => line.trim() !== "")
        .slice(-MAX_DETAIL_LINES)
        .join("\n");
      fail(`${options.label} failed: ${reason || `exit code ${exitCode}`}`);
    }
  });
  return promise;
}
