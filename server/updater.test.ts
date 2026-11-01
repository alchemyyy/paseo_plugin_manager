import assert from "node:assert/strict";
import { test } from "node:test";
import type { GitState, OperationKind } from "../shared/contracts.ts";
import type { InstalledPlugin, ManagedOutcome } from "./paseo-model.ts";
import { PluginUpdater } from "./updater.ts";

interface FakeRepository {
  state: GitState;
  /** What `git diff --name-only` reports for the fast-forward */
  changed: string[];
  fastForwardError?: string;
}

function gitState(root: string, overrides: Partial<GitState> = {}): GitState {
  return {
    root,
    branch: "main",
    upstream: "origin/main",
    upstreamGone: false,
    head: "old",
    ahead: 0,
    behind: 0,
    changedFiles: 0,
    incoming: [],
    ...overrides,
  };
}

function plugin(id: string, path: string, overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    path,
    enabled: true,
    status: "running",
    installation: { identity: { kind: "directory" } },
    ...overrides,
  };
}

/** An updater over fake git, Paseo CLI, and npm that log what they were asked to do */
function harness(options: {
  plugins: InstalledPlugin[];
  repositories: Record<string, FakeRepository>;
  managed?: ManagedOutcome[];
  failingInstalls?: Set<string>;
}) {
  const log: string[] = [];
  const restarts: { args: string[]; operationState: string | undefined }[] = [];
  const { repositories } = options;
  const updater: PluginUpdater = new PluginUpdater({
    git: {
      async findRoot(directory) {
        return Object.keys(repositories).find((root) => directory === root || directory.startsWith(`${root}/`)) ?? null;
      },
      async inspect(root) {
        return structuredClone(repositories[root].state);
      },
      async fetch(root) {
        log.push(`fetch ${root}`);
      },
      async fastForward(root) {
        log.push(`merge ${root}`);
        const repository = repositories[root];
        if (repository.fastForwardError) throw new Error(repository.fastForwardError);
        repository.state = { ...repository.state, head: "new", behind: 0, incoming: [] };
      },
      async changedFiles(root) {
        return repositories[root].changed;
      },
    },
    paseo: {
      async listPlugins() {
        return options.plugins;
      },
      async reloadPlugin(pluginId) {
        log.push(`reload ${pluginId}`);
      },
      async checkManaged(pluginId) {
        log.push(`check-managed ${pluginId ?? "--all"}`);
        return options.managed ?? [];
      },
      async updateManaged(pluginId) {
        log.push(`update-managed ${pluginId}`);
        return [{ id: pluginId, outcome: "updated", current: null, latest: null, error: null, warning: null }];
      },
      startDetached(args) {
        log.push(`detached ${args.join(" ")}`);
        // state() builds its snapshot synchronously here: the list is fresh, so it does not re-list
        void updater.state().then(({ operations }) => restarts.push({ args, operationState: operations.at(-1)?.state }));
      },
    },
    async installDependencies(pluginPath) {
      log.push(`npm ${pluginPath}`);
      if (options.failingInstalls?.has(pluginPath)) throw new Error("npm ci failed: EBUSY: resource busy or locked");
    },
    selfId: "manager",
    platform: "linux",
    now: () => 0,
  });
  const run = async (kind: OperationKind, pluginId: string | null) => {
    const operationId = updater.enqueue(kind, pluginId);
    await updater.whenIdle();
    const state = await updater.state();
    const operation = state.operations.find(({ id }) => id === operationId);
    assert.ok(operation);
    return { state, operation, entry: (id: string) => state.plugins.find((entry) => entry.id === id)! };
  };
  /** Work-tree and Paseo changes in order; fetches run in parallel, so they are left out */
  const actions = () => log.filter((line) => !line.startsWith("fetch "));
  return { log, restarts, run, actions };
}

test("Update all fast-forwards repositories behind upstream, reinstalls dependencies only where package files changed, and reloads only changed plugins", async () => {
  const { run, actions } = harness({
    plugins: [plugin("alpha", "/a"), plugin("beta", "/b"), plugin("gamma", "/c"), plugin("delta", "/d")],
    repositories: {
      "/a": { state: gitState("/a", { behind: 2 }), changed: ["package-lock.json", "client/view.tsx"] },
      "/b": { state: gitState("/b", { behind: 1 }), changed: ["server/index.ts"] },
      "/c": { state: gitState("/c"), changed: [] },
    },
  });
  const { operation, entry } = await run("update", null);
  assert.deepEqual(actions(), ["merge /a", "npm /a", "merge /b", "reload alpha", "reload beta"]);
  assert.equal(operation.summary, "Updated Alpha, Beta");
  assert.equal(operation.variant, "success");
  assert.equal(entry("alpha").updateAvailable, false);
  assert.equal(entry("delta").source, "folder");
});

test("Updating one plugin that is already up to date still reloads it, since update also installs it", async () => {
  const { run, actions } = harness({
    plugins: [plugin("gamma", "/c"), plugin("delta", "/d")],
    repositories: { "/c": { state: gitState("/c"), changed: [] } },
  });
  assert.equal((await run("update", "gamma")).operation.summary, "Gamma is up to date; reloaded it");
  assert.equal((await run("update", "delta")).operation.summary, "Delta is not in a Git repository; reloaded it");
  assert.deepEqual(actions(), ["reload gamma", "reload delta"]);
});

test("Updating one plugin reloads every plugin of its repository, installing only where package files changed", async () => {
  const { run, actions } = harness({
    plugins: [plugin("alpha", "/mono/alpha"), plugin("beta", "/mono/beta")],
    repositories: { "/mono": { state: gitState("/mono", { behind: 1 }), changed: ["alpha/package.json"] } },
  });
  const { operation } = await run("update", "alpha");
  assert.deepEqual(actions(), ["merge /mono", "npm /mono/alpha", "reload alpha", "reload beta"]);
  assert.equal(operation.summary, "Updated Alpha (1 commit)");
});

test("The plugin manager reloads itself last, from a detached process, once its operation is done", async () => {
  const { run, actions, restarts } = harness({
    plugins: [plugin("manager", "/m"), plugin("alpha", "/a")],
    repositories: {
      "/m": { state: gitState("/m", { behind: 1 }), changed: ["client/plugins-item.tsx"] },
      "/a": { state: gitState("/a", { behind: 1 }), changed: [] },
    },
  });
  const { operation } = await run("update", null);
  assert.deepEqual(actions(), ["merge /m", "merge /a", "reload alpha", "detached plugin reload manager"]);
  assert.deepEqual(restarts, [{ args: ["plugin", "reload", "manager"], operationState: "done" }]);
  assert.equal(operation.summary, "Updated Manager, Alpha");
});

test("A failed fast-forward reports git's reason and skips the reload", async () => {
  const { run, actions } = harness({
    plugins: [plugin("alpha", "/a")],
    repositories: {
      "/a": {
        state: gitState("/a", { behind: 2, ahead: 1 }),
        changed: [],
        fastForwardError: "git merge failed: fatal: Not possible to fast-forward, aborting.",
      },
    },
  });
  const { operation, entry } = await run("update", "alpha");
  assert.deepEqual(actions(), ["merge /a"]);
  assert.equal(operation.variant, "error");
  assert.equal(operation.summary, "Could not update Alpha: git merge failed: fatal: Not possible to fast-forward, aborting.");
  assert.match(entry("alpha").problem ?? "", /Not possible to fast-forward/);
  assert.equal(entry("alpha").updateAvailable, true);
});

test("A failed dependency install leaves the plugin unreloaded and is retried before its next reload", async () => {
  const failingInstalls = new Set(["/a"]);
  const { run, actions } = harness({
    plugins: [plugin("alpha", "/a")],
    repositories: { "/a": { state: gitState("/a", { behind: 1 }), changed: ["package.json"] } },
    failingInstalls,
  });
  const first = await run("update", "alpha");
  assert.deepEqual(actions(), ["merge /a", "npm /a"]);
  assert.equal(first.operation.variant, "error");
  assert.match(first.entry("alpha").problem ?? "", /Paseo keeps running the previous version: npm ci failed/);

  failingInstalls.clear();
  const second = await run("update", "alpha");
  assert.deepEqual(actions(), ["merge /a", "npm /a", "npm /a", "reload alpha"]);
  assert.equal(second.entry("alpha").problem, null);
});

test("Check fetches tracked repositories and reports updates without touching work trees", async () => {
  const { run, log, actions } = harness({
    plugins: [plugin("alpha", "/a"), plugin("gamma", "/c"), plugin("epsilon", "/e")],
    repositories: {
      "/a": { state: gitState("/a", { behind: 3, incoming: [{ hash: "abc1234", subject: "Fix" }] }), changed: [] },
      "/c": { state: gitState("/c"), changed: [] },
      "/e": { state: gitState("/e", { upstream: null }), changed: [] },
    },
  });
  const { operation, entry } = await run("check", null);
  assert.deepEqual(log.filter((line) => line.startsWith("fetch ")).sort(), ["fetch /a", "fetch /c"]);
  assert.deepEqual(actions(), []);
  assert.equal(operation.summary, "1 plugin update available: Alpha");
  assert.equal(entry("alpha").updateAvailable, true);
  assert.equal(entry("alpha").checkedAt, 0);
  assert.equal(entry("epsilon").updateAvailable, false);
});

test("Paseo-managed installs update through paseo plugin update, which restarts them itself", async () => {
  const { run, actions } = harness({
    plugins: [plugin("remote", "/home/.paseo/plugins/remote", { installation: { identity: { kind: "git" } } })],
    repositories: {},
    managed: [{ id: "remote", outcome: "update", current: "aaa", latest: "bbb", error: null, warning: null }],
  });
  const { operation, entry } = await run("update", null);
  assert.deepEqual(actions(), ["check-managed remote", "update-managed remote"]);
  assert.equal(operation.summary, "Updated Remote");
  assert.equal(entry("remote").updateAvailable, false);
  assert.deepEqual(entry("remote").managed, { current: "bbb", latest: "bbb" });
});
