import assert from "node:assert/strict";
import { test } from "node:test";
import { dependencyFilesChanged, parseBranchStatus, parseCommits } from "./git-model.ts";

test("parseBranchStatus reads the branch, its upstream counts, and tracked changes", () => {
  const status = parseBranchStatus(
    [
      "# branch.oid 10bf029a1b2c3d4e5f60718293a4b5c6d7e8f901",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -3",
      "1 .M N... 100644 100644 100644 aaaa bbbb README.md",
      "2 R. N... 100644 100644 100644 aaaa bbbb R100 new.ts\told.ts",
      "u UU N... 100644 100644 100644 100644 aaaa bbbb cccc conflicted.ts",
      "",
    ].join("\n"),
  );
  assert.deepEqual(status, {
    head: "10bf029a1b2c3d4e5f60718293a4b5c6d7e8f901",
    branch: "main",
    upstream: "origin/main",
    ahead: 2,
    behind: 3,
    changedFiles: 3,
  });
});

test("parseBranchStatus tells a missing upstream from a deleted one", () => {
  const detached = parseBranchStatus("# branch.oid abc\r\n# branch.head (detached)\r\n");
  assert.equal(detached.branch, null);
  assert.equal(detached.upstream, null);
  assert.equal(detached.behind, null);

  // The upstream is configured but its ref is gone, so git prints no counts
  const gone = parseBranchStatus("# branch.oid abc\n# branch.head topic\n# branch.upstream origin/topic\n");
  assert.equal(gone.upstream, "origin/topic");
  assert.equal(gone.behind, null);

  assert.equal(parseBranchStatus("# branch.oid (initial)\n# branch.head main\n").head, null);
});

test("parseCommits splits hash and subject at the unit separator, keeping later separators in the subject", () => {
  assert.deepEqual(parseCommits("abc1234\x1fFix the tree\r\ndef5678\x1fSplit\x1fview\n\n"), [
    { hash: "abc1234", subject: "Fix the tree" },
    { hash: "def5678", subject: "Split\x1fview" },
  ]);
});

test("dependencyFilesChanged watches only the plugin's own package files", () => {
  const changed = ["README.md", "other/package.json", "plugin/package-lock.json"];
  assert.equal(dependencyFilesChanged(changed, "/repo", "/repo/plugin", "linux"), true);
  assert.equal(dependencyFilesChanged(changed, "/repo", "/repo/other", "linux"), true);
  assert.equal(dependencyFilesChanged(changed, "/repo", "/repo/third", "linux"), false);
  // At the work tree root only top-level files count
  assert.equal(dependencyFilesChanged(changed, "/repo", "/repo", "linux"), false);
  assert.equal(dependencyFilesChanged(["package.json"], "/repo", "/repo/", "linux"), true);
  assert.equal(dependencyFilesChanged(["package.json"], "/repo", "/elsewhere", "linux"), false);
});

test("dependencyFilesChanged matches Windows paths across separators and letter case", () => {
  assert.equal(
    dependencyFilesChanged(["Plugin/Package.json"], "C:/Work/Repo", "c:\\work\\repo\\plugin", "win32"),
    true,
  );
  assert.equal(dependencyFilesChanged(["Plugin/Package.json"], "/work/repo", "/work/repo/plugin", "linux"), false);
});
