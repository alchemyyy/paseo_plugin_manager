import assert from "node:assert/strict";
import { test } from "node:test";
import { isManagedInstall, parsePluginList, parseUpdateOutcomes, resolvePaseoCli } from "./paseo-model.ts";

const noFiles = () => false;
const DESKTOP_EXE = "C:\\Program Files\\Paseo\\Paseo.exe";

test("PASEO_CLI from the daemon wins; a JS entry runs on the daemon's executable", () => {
  assert.deepEqual(resolvePaseoCli({ PASEO_CLI: "D:\\Paseo\\paseo.cmd" }, DESKTOP_EXE, "win32", noFiles), {
    command: "D:\\Paseo\\paseo.cmd",
    prefixArgs: [],
  });
  assert.deepEqual(resolvePaseoCli({ PASEO_CLI: "/src/paseo/cli/bin/paseo.mjs" }, "/usr/bin/node", "linux", noFiles), {
    command: "/usr/bin/node",
    prefixArgs: ["/src/paseo/cli/bin/paseo.mjs"],
  });
});

test("Without PASEO_CLI the desktop app's bundled CLI beats a PATH lookup", () => {
  const bundled = "C:\\Program Files\\Paseo\\resources\\bin\\paseo.cmd";
  assert.equal(resolvePaseoCli({}, DESKTOP_EXE, "win32", (file) => file === bundled).command, bundled);
  assert.equal(resolvePaseoCli({ PASEO_CLI: "  " }, DESKTOP_EXE, "win32", noFiles).command, "paseo");
});

test("Only installs Paseo cloned or downloaded count as managed", () => {
  const [directory, git, npm, legacyGit] = parsePluginList(
    JSON.stringify([
      { id: "a", path: "C:\\a", enabled: true, status: "running", installation: { identity: { kind: "directory", path: "C:\\a" } } },
      { id: "b", path: "C:\\b", enabled: true, status: "running", installation: { identity: { kind: "git", remote: "x" } } },
      { id: "c", path: "C:\\c", enabled: false, status: "disabled", npm: { packageName: "c", version: "1.0.0" } },
      { id: "d", path: "C:\\d", enabled: true, status: "running", source: "git", commit: "abc" },
    ]),
  );
  assert.equal(isManagedInstall(directory), false);
  assert.equal(isManagedInstall(git), true);
  assert.equal(isManagedInstall(npm), true);
  assert.equal(isManagedInstall(legacyGit), true);
});

test("parsePluginList accepts statuses it does not know and rejects malformed output", () => {
  const [plugin] = parsePluginList('[{"id":"a","path":"/a","enabled":true,"status":"starting","extra":1}]');
  assert.equal(plugin.status, "starting");
  assert.throws(() => parsePluginList('{"id":"a"}'));
});

test("parseUpdateOutcomes reads git commits, npm versions, and errors", () => {
  const outcomes = parseUpdateOutcomes(
    JSON.stringify([
      { id: "g", outcome: "update", current: { currentRevision: "aaa" }, target: { kind: "git", commit: "bbb" }, links: [] },
      { id: "n", outcome: "updated", target: { kind: "npm", version: "2.0.0" }, warning: "cleanup failed" },
      { id: "e", outcome: "error", error: "Remote unreachable", links: [] },
    ]),
  );
  assert.deepEqual(
    outcomes.map(({ id, outcome, current, latest, error, warning }) => [id, outcome, current, latest, error, warning]),
    [
      ["g", "update", "aaa", "bbb", null, null],
      ["n", "updated", null, "2.0.0", null, "cleanup failed"],
      ["e", "error", null, null, "Remote unreachable", null],
    ],
  );
});
