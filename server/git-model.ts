import type { Commit } from "../shared/contracts";

/** What `git status --porcelain=v2 --branch` says about the checked-out branch and the work tree */
export interface BranchStatus {
  /** Null on a branch without commits */
  head: string | null;
  /** Null on a detached HEAD */
  branch: string | null;
  upstream: string | null;
  /** Null when there is no upstream or its ref is missing (deleted upstream branch) */
  ahead: number | null;
  behind: number | null;
  /** Tracked files with staged, unstaged, or conflicted changes */
  changedFiles: number;
}

export function parseBranchStatus(output: string): BranchStatus {
  const status: BranchStatus = { head: null, branch: null, upstream: null, ahead: null, behind: null, changedFiles: 0 };
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("# branch.oid ")) {
      const oid = line.slice("# branch.oid ".length).trim();
      status.head = oid === "(initial)" ? null : oid;
    } else if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length).trim();
      status.branch = head === "(detached)" ? null : head;
    } else if (line.startsWith("# branch.upstream ")) {
      status.upstream = line.slice("# branch.upstream ".length).trim();
    } else if (line.startsWith("# branch.ab ")) {
      const counts = /^\+(\d+) -(\d+)$/.exec(line.slice("# branch.ab ".length).trim());
      if (counts) {
        status.ahead = Number(counts[1]);
        status.behind = Number(counts[2]);
      }
    } else if (/^[12u] /.test(line)) {
      // Ordinary, renamed or copied, and unmerged entries; untracked ones are excluded by the caller
      status.changedFiles += 1;
    }
  }
  return status;
}

/** The `git log --format` that parseCommits reads: abbreviated hash, unit separator, subject */
export const COMMIT_FORMAT = "%h%x1f%s";

export function parseCommits(output: string): Commit[] {
  return output
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const separator = line.indexOf("\x1f");
      return separator < 0
        ? { hash: line.trim(), subject: "" }
        : { hash: line.slice(0, separator), subject: line.slice(separator + 1) };
    });
}

/** Map key for a directory: one separator style, no trailing slash, case folded where Windows ignores case */
export function directoryKey(directory: string, platform: NodeJS.Platform): string {
  const unified = directory.replace(/\\/g, "/").replace(/\/+$/, "");
  return platform === "win32" ? unified.toLowerCase() : unified;
}

/**
 * Whether a change between two commits touched the plugin's package.json or package-lock.json, so
 * its node_modules must be reinstalled before Paseo can compile it. `changedPaths` are relative to
 * the work tree root, as `git diff --name-only` prints them.
 */
export function dependencyFilesChanged(
  changedPaths: readonly string[],
  root: string,
  pluginPath: string,
  platform: NodeJS.Platform,
): boolean {
  const rootKey = directoryKey(root, platform);
  const pluginKey = directoryKey(pluginPath, platform);
  if (pluginKey !== rootKey && !pluginKey.startsWith(`${rootKey}/`)) return false;
  const prefix = pluginKey === rootKey ? "" : `${pluginKey.slice(rootKey.length + 1)}/`;
  const watched = new Set([`${prefix}package.json`, `${prefix}package-lock.json`]);
  return changedPaths.some((changed) => watched.has(platform === "win32" ? changed.toLowerCase() : changed));
}
