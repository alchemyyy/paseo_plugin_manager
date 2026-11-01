import { existsSync } from "node:fs";
import path from "node:path";
import { CommandError, runCommand } from "./command";
import { COMMIT_FORMAT, parseBranchStatus, parseCommits } from "./git-model";
import type { GitTool } from "./updater";

const LOCAL_TIMEOUT_MS = 30_000;
// Long enough for a credential helper's sign-in window
const FETCH_TIMEOUT_MS = 120_000;
const MAX_INCOMING_COMMITS = 20;
const NOT_A_REPOSITORY = /not a git repository/i;

/**
 * Git through its executable, started directly so arguments such as `--format=%h` reach it intact.
 * These commands run in the background: they never prompt in a terminal, and read-only ones never
 * take the index lock away from the user's own Git.
 */
export function createGit(): GitTool {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
  const git = (cwd: string, args: string[], timeoutMs = LOCAL_TIMEOUT_MS) =>
    runCommand("git", args, { label: `git ${args[0]}`, cwd, env, timeoutMs, shell: false });

  return {
    async findRoot(directory) {
      if (!existsSync(directory)) throw new Error(`The plugin folder ${directory} does not exist`);
      try {
        const root = (await git(directory, ["rev-parse", "--show-toplevel"])).trim();
        return root === "" ? null : path.resolve(root);
      } catch (error) {
        if (error instanceof CommandError && NOT_A_REPOSITORY.test(error.stderr)) return null;
        throw error;
      }
    },

    async inspect(root) {
      const status = parseBranchStatus(await git(root, ["status", "--porcelain=v2", "--branch", "--untracked-files=no"]));
      const behind = status.behind ?? 0;
      const incoming =
        status.head !== null && behind > 0
          ? parseCommits(
              await git(root, ["log", `--format=${COMMIT_FORMAT}`, `--max-count=${MAX_INCOMING_COMMITS}`, "HEAD..@{upstream}"]),
            )
          : [];
      return {
        root,
        branch: status.branch,
        upstream: status.upstream,
        upstreamGone: status.upstream !== null && status.behind === null,
        head: status.head,
        ahead: status.ahead ?? 0,
        behind,
        changedFiles: status.changedFiles,
        incoming,
      };
    },

    async fetch(root) {
      await git(root, ["fetch", "--quiet"], FETCH_TIMEOUT_MS);
    },

    async fastForward(root) {
      await git(root, ["merge", "--ff-only", "--quiet", "@{upstream}"]);
    },

    async changedFiles(root, from, to) {
      return (await git(root, ["diff", "--name-only", "-z", from, to])).split("\0").filter((file) => file !== "");
    },
  };
}
