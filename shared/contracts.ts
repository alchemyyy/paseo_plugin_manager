import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const preferences = defineSettings({
  id: "preferences",
  scope: "host",
  version: 1,
  schema: z.object({
    /** The sidebar section lists every installed plugin, not only those with an update */
    expanded: z.boolean().default(false),
  }),
});

/**
 * Where a plugin's updates come from: a directory install inside a Git work tree (fetch, then
 * fast-forward), a directory install outside Git (nothing to fetch), or an install Paseo cloned or
 * downloaded itself, which `paseo plugin update` owns.
 */
export const PluginSourceSchema = z.enum(["git", "folder", "managed"]);
export type PluginSource = z.infer<typeof PluginSourceSchema>;

export const CommitSchema = z.object({ hash: z.string(), subject: z.string() });
export type Commit = z.infer<typeof CommitSchema>;

export const GitStateSchema = z.object({
  /** The work tree's top-level directory; plugins in one repository update together */
  root: z.string(),
  /** Null on a detached HEAD */
  branch: z.string().nullable(),
  /** The branch's upstream, such as `origin/main`; null when none is configured */
  upstream: z.string().nullable(),
  /** The upstream is configured but its ref no longer exists */
  upstreamGone: z.boolean(),
  /** Null on a branch without commits */
  head: z.string().nullable(),
  /** Commits on HEAD missing from the upstream, as of the last fetch */
  ahead: z.number().int().nonnegative(),
  /** Upstream commits missing from HEAD, as of the last fetch */
  behind: z.number().int().nonnegative(),
  /** Tracked files with uncommitted changes */
  changedFiles: z.number().int().nonnegative(),
  /** The newest upstream commits missing from HEAD, newest first, capped */
  incoming: z.array(CommitSchema),
});
export type GitState = z.infer<typeof GitStateSchema>;

export const ActivitySchema = z.enum(["checking", "updating"]);
export type Activity = z.infer<typeof ActivitySchema>;

export const PluginEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  path: z.string(),
  enabled: z.boolean(),
  /** Paseo's runtime status: running, disabled, or failed */
  status: z.string(),
  /** Why Paseo could not load the plugin */
  loadError: z.string().nullable(),
  source: PluginSourceSchema,
  git: GitStateSchema.nullable(),
  /** Paseo-managed installs: installed and latest revision from the last check */
  managed: z.object({ current: z.string().nullable(), latest: z.string().nullable() }).nullable(),
  updateAvailable: z.boolean(),
  activity: ActivitySchema.nullable(),
  /** Why the last check or update of this plugin failed */
  problem: z.string().nullable(),
  /** When updates were last fetched for this plugin, in epoch milliseconds */
  checkedAt: z.number().nullable(),
});
export type PluginEntry = z.infer<typeof PluginEntrySchema>;

export const OperationKindSchema = z.enum(["check", "update"]);
export type OperationKind = z.infer<typeof OperationKindSchema>;

export const SummaryVariantSchema = z.enum(["success", "warning", "error"]);
export type SummaryVariant = z.infer<typeof SummaryVariantSchema>;

export const OperationSchema = z.object({
  id: z.string(),
  kind: OperationKindSchema,
  /** Null: every installed plugin */
  pluginId: z.string().nullable(),
  state: z.enum(["queued", "running", "done"]),
  /** The outcome once done, for a toast */
  summary: z.string().nullable(),
  variant: SummaryVariantSchema.nullable(),
});
export type Operation = z.infer<typeof OperationSchema>;

export const PluginsStateSchema = z.object({
  plugins: z.array(PluginEntrySchema),
  /** Queued, running, and recently finished checks and updates, oldest first */
  operations: z.array(OperationSchema),
  /** Why Paseo's plugin list could not be read */
  error: z.string().nullable(),
});
export type PluginsState = z.infer<typeof PluginsStateSchema>;

export const pluginsStateRpc = defineRpc({
  name: "plugins.state",
  input: z.object({}),
  output: PluginsStateSchema,
});

const OperationInputSchema = z.object({ pluginId: z.string().min(1).nullable() });
const OperationOutputSchema = z.object({ operationId: z.string() });

/** Fetches upstream and reports updates without changing any work tree */
export const checkPluginsRpc = defineRpc({
  name: "plugins.check",
  input: OperationInputSchema,
  output: OperationOutputSchema,
});

/** Fast-forwards to upstream (or runs `paseo plugin update`), then reloads the plugin in Paseo */
export const updatePluginsRpc = defineRpc({
  name: "plugins.update",
  input: OperationInputSchema,
  output: OperationOutputSchema,
});
