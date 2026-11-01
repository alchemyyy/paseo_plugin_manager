import { randomUUID } from "node:crypto";
import type {
  Activity,
  GitState,
  Operation,
  OperationKind,
  PluginEntry,
  PluginSource,
  PluginsState,
} from "../shared/contracts";
// NOTE: explicit extensions so `node --test` can load this module directly
import { dependencyFilesChanged, directoryKey } from "./git-model.ts";
import { type InstalledPlugin, isManagedInstall, type ManagedOutcome } from "./paseo-model.ts";
import { firstLine, type Outcome, type PluginOutcome, summarize } from "./summary.ts";

export interface GitTool {
  /** The work tree's top-level directory, or null when the folder is not inside a Git work tree */
  findRoot(directory: string): Promise<string | null>;
  /** Local state only: ahead and behind compare against the upstream ref as of the last fetch */
  inspect(root: string): Promise<GitState>;
  fetch(root: string): Promise<void>;
  /** Moves the branch to its upstream; refuses to merge, and never discards local changes */
  fastForward(root: string): Promise<void>;
  /** Paths changed between two commits, relative to the work tree root */
  changedFiles(root: string, from: string, to: string): Promise<string[]>;
}

export interface PaseoTool {
  listPlugins(): Promise<InstalledPlugin[]>;
  reloadPlugin(pluginId: string): Promise<void>;
  /** `paseo plugin update <id> --check`, or every plugin with null */
  checkManaged(pluginId: string | null): Promise<ManagedOutcome[]>;
  /** `paseo plugin update <id> --yes`, which also restarts the plugin */
  updateManaged(pluginId: string): Promise<ManagedOutcome[]>;
  /** Runs a CLI command in a process that outlives this one, since the command restarts it */
  startDetached(args: string[]): void;
}

export interface UpdaterDependencies {
  git: GitTool;
  paseo: PaseoTool;
  /** `npm ci` (or `npm install`) in a plugin folder */
  installDependencies(pluginPath: string): Promise<void>;
  /** This plugin's id: reloading it ends this process, so that happens last and detached */
  selfId: string;
  platform: NodeJS.Platform;
  now(): number;
}

const CONCURRENCY = 4;
/** A state read while idle re-lists plugins when the last list is older than this */
const LIST_STALE_MS = 20_000;
const KEPT_FINISHED_OPERATIONS = 20;
const STARTUP_CHECK_DELAY_MS = 20_000;
const AUTO_CHECK_INTERVAL_MS = 30 * 60_000;
const NOT_IN_GIT = "is not in a Git repository";

interface LocatedPlugin {
  plugin: InstalledPlugin;
  source: PluginSource;
  /** Work tree root of a git plugin */
  root: string | null;
  /** `root` as a map key */
  repoKey: string | null;
  /** Why Git could not inspect the plugin's folder */
  locateError: string | null;
}

interface RunResult {
  outcomes: Map<string, Outcome>;
  /** CLI arguments that restart this plugin, run once the operation is final */
  restartSelf: string[] | null;
}

/**
 * Lists installed plugins and runs checks and updates one operation at a time, in the background:
 * plugin RPCs time out after 30 seconds, while fetches, npm installs, and reloads can take longer.
 * Clients start an operation, then poll `state()` until it is done.
 */
export class PluginUpdater {
  private readonly deps: UpdaterDependencies;
  private located: LocatedPlugin[] = [];
  private listError: string | null = null;
  private listedAt: number | null = null;
  private readonly gitStates = new Map<string, GitState>();
  /** Repository key → why its local state could not be read */
  private readonly gitErrors = new Map<string, string>();
  /** Repository key → last successful fetch */
  private readonly fetchedAt = new Map<string, number>();
  private readonly managed = new Map<string, ManagedOutcome>();
  private readonly managedCheckedAt = new Map<string, number>();
  private readonly activity = new Map<string, Activity>();
  private readonly problems = new Map<string, string>();
  /** Plugins whose dependency install failed; retried before their next reload */
  private readonly pendingInstall = new Set<string>();
  private operations: Operation[] = [];
  private queue: Promise<void> = Promise.resolve();
  private refreshing: Promise<void> | null = null;

  constructor(deps: UpdaterDependencies) {
    this.deps = deps;
  }

  /** Plugins and operations; re-lists the plugins first when idle and the last list is stale */
  async state(): Promise<PluginsState> {
    const idle = this.operations.every((operation) => operation.state === "done");
    if (idle && (this.listedAt === null || this.deps.now() - this.listedAt >= LIST_STALE_MS)) {
      this.refreshing ??= this.loadList().finally(() => {
        this.refreshing = null;
      });
      await this.refreshing;
    }
    const plugins = this.located
      .map((located) => this.entry(located))
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
    return { plugins, operations: this.operations.map((operation) => ({ ...operation })), error: this.listError };
  }

  /** Queues a check or update of one plugin, or every plugin with null; an identical pending one is reused */
  enqueue(kind: OperationKind, pluginId: string | null): string {
    const pending = this.operations.find(
      (operation) => operation.state !== "done" && operation.kind === kind && operation.pluginId === pluginId,
    );
    if (pending) return pending.id;
    const operation: Operation = { id: randomUUID(), kind, pluginId, state: "queued", summary: null, variant: null };
    this.operations.push(operation);
    this.queue = this.queue.then(() => this.run(operation));
    return operation.id;
  }

  /** Resolves when every queued operation has finished */
  whenIdle(): Promise<void> {
    return this.queue;
  }

  /** Checks every plugin shortly after startup, then periodically; returns the cleanup */
  startAutoCheck(): () => void {
    const check = () => {
      this.enqueue("check", null);
    };
    const first = setTimeout(check, STARTUP_CHECK_DELAY_MS);
    const interval = setInterval(check, AUTO_CHECK_INTERVAL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(interval);
    };
  }

  private async run(operation: Operation): Promise<void> {
    operation.state = "running";
    let targets: LocatedPlugin[] = [];
    let restartSelf: string[] | null = null;
    try {
      // A state read may still be listing; this operation lists again right after
      await this.refreshing;
      await this.loadList();
      if (this.listError !== null) throw new Error(`Could not list plugins: ${this.listError}`);
      targets =
        operation.pluginId === null
          ? this.located
          : this.located.filter(({ plugin }) => plugin.id === operation.pluginId);
      if (targets.length === 0) {
        throw new Error(operation.pluginId === null ? "No plugins are installed" : `${operation.pluginId} is not installed`);
      }
      for (const { plugin } of targets) {
        this.activity.set(plugin.id, operation.kind === "check" ? "checking" : "updating");
        this.problems.delete(plugin.id);
      }
      const single = operation.pluginId !== null;
      const result = operation.kind === "check" ? await this.check(targets) : await this.update(targets, single);
      restartSelf = result.restartSelf;
      const outcomes = targets.flatMap(({ plugin }): PluginOutcome[] => {
        const outcome = result.outcomes.get(plugin.id);
        return outcome ? [{ name: displayName(plugin), self: plugin.id === this.deps.selfId, outcome }] : [];
      });
      const summary = summarize(operation.kind, single, outcomes);
      operation.summary = summary.message;
      operation.variant = summary.variant;
    } catch (error) {
      operation.summary = firstLine(describe(error));
      operation.variant = "error";
    } finally {
      for (const { plugin } of targets) this.activity.delete(plugin.id);
      operation.state = "done";
      const finished = this.operations.filter(({ state }) => state === "done");
      const dropped = new Set(finished.slice(0, Math.max(0, finished.length - KEPT_FINISHED_OPERATIONS)));
      this.operations = this.operations.filter((kept) => !dropped.has(kept));
    }
    // The summary is final before the restart ends this process
    if (restartSelf) this.deps.paseo.startDetached(restartSelf);
  }

  private async check(targets: LocatedPlugin[]): Promise<RunResult> {
    const outcomes = new Map<string, Outcome>();
    // Folders have nothing to fetch, so they settle at once
    for (const target of targets.filter(({ source }) => source === "folder")) {
      this.setOutcome(
        target,
        outcomes,
        target.locateError === null ? { kind: "untracked", reason: NOT_IN_GIT } : { kind: "failed", reason: target.locateError },
      );
      this.activity.delete(target.plugin.id);
    }
    await mapLimit([...groupByRepository(targets)], CONCURRENCY, async ([key, members]) => {
      try {
        const outcome = gitOutcome(await this.refreshRepository(members[0].root!, key, true));
        for (const member of members) this.setOutcome(member, outcomes, outcome);
      } catch (error) {
        for (const member of members) this.setOutcome(member, outcomes, { kind: "failed", reason: describe(error) });
      } finally {
        for (const { plugin } of members) this.activity.delete(plugin.id);
      }
    });
    await this.checkManaged(
      targets.filter(({ source }) => source === "managed"),
      outcomes,
    );
    return { outcomes, restartSelf: null };
  }

  private async update(targets: LocatedPlugin[], single: boolean): Promise<RunResult> {
    const outcomes = new Map<string, Outcome>();
    const reloads: LocatedPlugin[] = [];
    const queueReload = (target: LocatedPlugin) => {
      if (!reloads.includes(target)) reloads.push(target);
    };
    let restartSelf: string[] | null = null;

    for (const target of targets.filter(({ source }) => source === "folder")) {
      if (target.locateError !== null) {
        this.setOutcome(target, outcomes, { kind: "failed", reason: target.locateError });
      } else if (!single) {
        outcomes.set(target.plugin.id, { kind: "untracked", reason: NOT_IN_GIT });
      } else if (!this.pendingInstall.has(target.plugin.id) || (await this.install(target, outcomes))) {
        // Updating one plugin also installs it: Paseo re-reads it from disk
        queueReload(target);
        outcomes.set(target.plugin.id, { kind: "reloaded", note: NOT_IN_GIT });
        continue;
      }
      this.activity.delete(target.plugin.id);
    }

    // Fetch every repository first, in parallel
    const repositories = [...groupByRepository(targets)];
    const fetched = new Map<string, GitState | Error>();
    await mapLimit(repositories, CONCURRENCY, async ([key, members]) => {
      try {
        fetched.set(key, await this.refreshRepository(members[0].root!, key, true));
      } catch (error) {
        fetched.set(key, error instanceof Error ? error : new Error(String(error)));
      }
    });

    // Then fast-forward one at a time: dependency installs and reloads are heavy
    for (const [key, members] of repositories) {
      const root = members[0].root!;
      const state = fetched.get(key)!;
      if (state instanceof Error) {
        for (const member of members) {
          this.setOutcome(member, outcomes, { kind: "failed", reason: state.message });
          this.activity.delete(member.plugin.id);
        }
        continue;
      }
      const status = gitOutcome(state);
      if (status.kind !== "available") {
        for (const member of members) {
          if (status.kind === "failed" || !single) {
            this.setOutcome(member, outcomes, status);
          } else if (!this.pendingInstall.has(member.plugin.id) || (await this.install(member, outcomes))) {
            // Updating one plugin also installs it: Paseo re-reads it from disk
            queueReload(member);
            outcomes.set(member.plugin.id, { kind: "reloaded", note: status.kind === "untracked" ? status.reason : null });
          }
          if (!single) this.activity.delete(member.plugin.id);
        }
        continue;
      }
      try {
        await this.deps.git.fastForward(root);
        const updated = await this.refreshRepository(root, key, false);
        // From an unborn branch everything is new
        const changed =
          state.head === null || updated.head === null ? null : await this.deps.git.changedFiles(root, state.head, updated.head);
        // Every installed plugin in the repository changed on disk, not only the targets
        for (const resident of this.located.filter(({ repoKey }) => repoKey === key)) {
          const dependenciesChanged =
            changed === null || dependencyFilesChanged(changed, root, resident.plugin.path, this.deps.platform);
          if ((dependenciesChanged || this.pendingInstall.has(resident.plugin.id)) && !(await this.install(resident, outcomes))) {
            continue;
          }
          queueReload(resident);
        }
        for (const member of members) {
          if (!outcomes.has(member.plugin.id)) outcomes.set(member.plugin.id, { kind: "updated", commits: state.behind });
        }
      } catch (error) {
        for (const member of members) {
          this.setOutcome(member, outcomes, { kind: "failed", reason: describe(error) });
          this.activity.delete(member.plugin.id);
        }
      }
    }

    const managedTargets = targets.filter(({ source }) => source === "managed");
    const previews = await this.checkManaged(managedTargets, outcomes);
    for (const target of managedTargets) {
      const { id } = target.plugin;
      const preview = previews.get(id);
      // checkManaged recorded the failure
      if (!preview || preview.outcome === "error") continue;
      if (preview.outcome !== "update") {
        if (single) {
          queueReload(target);
          outcomes.set(id, { kind: "reloaded", note: null });
        }
        continue;
      }
      if (id === this.deps.selfId) {
        restartSelf = ["plugin", "update", id, "--yes"];
        outcomes.set(id, { kind: "updated", commits: null });
        continue;
      }
      try {
        const result = (await this.deps.paseo.updateManaged(id)).find((candidate) => candidate.id === id);
        if (result?.outcome === "updated") {
          this.managed.set(id, { ...preview, outcome: "current", current: preview.latest });
          outcomes.set(id, { kind: "updated", commits: null });
        } else {
          this.setOutcome(target, outcomes, { kind: "failed", reason: result?.error ?? "Paseo did not update it" });
        }
      } catch (error) {
        this.setOutcome(target, outcomes, { kind: "failed", reason: describe(error) });
      }
    }

    // Paseo queues reloads anyway; one at a time keeps each failure attached to its plugin
    for (const target of reloads) {
      const { id } = target.plugin;
      if (id === this.deps.selfId) {
        restartSelf ??= ["plugin", "reload", id];
        continue;
      }
      // A disabled plugin compiles the new code when it is enabled
      if (!target.plugin.enabled) continue;
      try {
        await this.deps.paseo.reloadPlugin(id);
      } catch (error) {
        const prefix = outcomes.get(id)?.kind === "updated" ? "Updated on disk, but Paseo" : "Paseo";
        this.setOutcome(target, outcomes, { kind: "failed", reason: `${prefix} could not reload it: ${describe(error)}` });
      } finally {
        this.activity.delete(id);
      }
    }
    return { outcomes, restartSelf };
  }

  /** Previews Paseo-managed installs; returns them by id and records failures */
  private async checkManaged(targets: LocatedPlugin[], outcomes: Map<string, Outcome>): Promise<Map<string, ManagedOutcome>> {
    const previews = new Map<string, ManagedOutcome>();
    if (targets.length === 0) return previews;
    try {
      const checked = await this.deps.paseo.checkManaged(targets.length === 1 ? targets[0].plugin.id : null);
      for (const preview of checked) previews.set(preview.id, preview);
    } catch (error) {
      for (const target of targets) this.setOutcome(target, outcomes, { kind: "failed", reason: describe(error) });
      return previews;
    }
    const checkedAt = this.deps.now();
    for (const target of targets) {
      const preview = previews.get(target.plugin.id);
      if (!preview || preview.outcome === "error") {
        this.setOutcome(target, outcomes, { kind: "failed", reason: preview?.error ?? "Paseo did not report on it" });
        continue;
      }
      this.managed.set(target.plugin.id, preview);
      this.managedCheckedAt.set(target.plugin.id, checkedAt);
      outcomes.set(target.plugin.id, preview.outcome === "update" ? { kind: "available", commits: null } : { kind: "current" });
    }
    return previews;
  }

  private async install(target: LocatedPlugin, outcomes: Map<string, Outcome>): Promise<boolean> {
    try {
      await this.deps.installDependencies(target.plugin.path);
      this.pendingInstall.delete(target.plugin.id);
      return true;
    } catch (error) {
      this.pendingInstall.add(target.plugin.id);
      this.setOutcome(target, outcomes, {
        kind: "failed",
        reason: `Installing its dependencies failed, so Paseo keeps running the previous version: ${describe(error)}`,
      });
      return false;
    }
  }

  private setOutcome(target: LocatedPlugin, outcomes: Map<string, Outcome>, outcome: Outcome): void {
    outcomes.set(target.plugin.id, outcome);
    if (outcome.kind === "failed") this.problems.set(target.plugin.id, outcome.reason);
  }

  private async refreshRepository(root: string, key: string, fetch: boolean): Promise<GitState> {
    let state = await this.deps.git.inspect(root);
    // Without an upstream there is nothing to fetch for
    if (fetch && state.upstream !== null) {
      await this.deps.git.fetch(root);
      state = await this.deps.git.inspect(root);
      this.fetchedAt.set(key, this.deps.now());
    }
    this.gitStates.set(key, state);
    this.gitErrors.delete(key);
    return state;
  }

  private async loadList(): Promise<void> {
    let plugins: InstalledPlugin[];
    try {
      plugins = await this.deps.paseo.listPlugins();
    } catch (error) {
      // The previous list stays on screen beside the error
      this.listError = describe(error);
      this.listedAt = this.deps.now();
      return;
    }
    const located = await mapLimit(plugins, CONCURRENCY, (plugin) => this.locate(plugin));
    const repositories = new Map<string, string>();
    for (const { root, repoKey } of located) if (root !== null && repoKey !== null) repositories.set(repoKey, root);
    await mapLimit([...repositories], CONCURRENCY, async ([key, root]) => {
      try {
        await this.refreshRepository(root, key, false);
      } catch (error) {
        this.gitErrors.set(key, describe(error));
      }
    });
    this.located = located;
    this.listError = null;
    this.listedAt = this.deps.now();
    // Forget plugins and repositories that are no longer installed
    const ids = new Set(plugins.map(({ id }) => id));
    for (const map of [this.managed, this.managedCheckedAt, this.problems] as Map<string, unknown>[]) {
      for (const id of map.keys()) if (!ids.has(id)) map.delete(id);
    }
    for (const id of this.pendingInstall) if (!ids.has(id)) this.pendingInstall.delete(id);
    for (const map of [this.gitStates, this.gitErrors, this.fetchedAt] as Map<string, unknown>[]) {
      for (const key of map.keys()) if (!repositories.has(key)) map.delete(key);
    }
  }

  private async locate(plugin: InstalledPlugin): Promise<LocatedPlugin> {
    const folder: LocatedPlugin = { plugin, source: "folder", root: null, repoKey: null, locateError: null };
    if (isManagedInstall(plugin)) return { ...folder, source: "managed" };
    try {
      const root = await this.deps.git.findRoot(plugin.path);
      return root === null ? folder : { ...folder, source: "git", root, repoKey: directoryKey(root, this.deps.platform) };
    } catch (error) {
      return { ...folder, locateError: describe(error) };
    }
  }

  private entry({ plugin, source, repoKey, locateError }: LocatedPlugin): PluginEntry {
    const git = repoKey === null ? null : (this.gitStates.get(repoKey) ?? null);
    const managed = source === "managed" ? (this.managed.get(plugin.id) ?? null) : null;
    let updateAvailable = false;
    if (git !== null) updateAvailable = git.upstream !== null && !git.upstreamGone && git.behind > 0;
    else if (managed !== null) updateAvailable = managed.outcome === "update";
    return {
      id: plugin.id,
      name: displayName(plugin),
      description: plugin.description ?? null,
      path: plugin.path,
      enabled: plugin.enabled,
      status: plugin.status,
      loadError: plugin.error ?? null,
      source,
      git,
      managed: managed === null ? null : { current: managed.current, latest: managed.latest },
      updateAvailable,
      activity: this.activity.get(plugin.id) ?? null,
      problem: this.problems.get(plugin.id) ?? locateError ?? (repoKey === null ? null : (this.gitErrors.get(repoKey) ?? null)),
      checkedAt: repoKey === null ? (this.managedCheckedAt.get(plugin.id) ?? null) : (this.fetchedAt.get(repoKey) ?? null),
    };
  }
}

/** What a fetched repository means for its plugins */
function gitOutcome(state: GitState): Outcome {
  if (state.upstream === null) {
    return { kind: "untracked", reason: state.branch === null ? "is on a detached HEAD" : "has no upstream branch" };
  }
  if (state.upstreamGone) return { kind: "failed", reason: `Its upstream branch ${state.upstream} no longer exists` };
  return state.behind > 0 ? { kind: "available", commits: state.behind } : { kind: "current" };
}

function groupByRepository(targets: readonly LocatedPlugin[]): Map<string, LocatedPlugin[]> {
  const groups = new Map<string, LocatedPlugin[]>();
  for (const target of targets) {
    if (target.repoKey === null) continue;
    const group = groups.get(target.repoKey);
    if (group) group.push(target);
    else groups.set(target.repoKey, [target]);
  }
  return groups;
}

async function mapLimit<Item, Result>(
  items: readonly Item[],
  limit: number,
  task: (item: Item) => Promise<Result>,
): Promise<Result[]> {
  const results: Result[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function displayName(plugin: InstalledPlugin): string {
  return plugin.name?.trim() || plugin.id;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
