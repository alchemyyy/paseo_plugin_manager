import path from "node:path";
import { z } from "zod";

/** How to start the Paseo CLI: `command` with `prefixArgs` before the CLI's own arguments */
export interface CliLaunch {
  command: string;
  prefixArgs: string[];
}

const SCRIPT_FILE = /\.[cm]?js$/i;

/**
 * Finds the CLI of the daemon this plugin runs in. The daemon exports PASEO_CLI to its plugin
 * processes; it names `paseo.cmd` in the desktop app and a JS entry in development builds, which
 * runs on the daemon's own executable. Plugin processes run on Paseo.exe, beside `resources\bin`.
 */
export function resolvePaseoCli(
  environment: NodeJS.ProcessEnv,
  execPath: string,
  platform: NodeJS.Platform,
  fileExists: (filePath: string) => boolean,
): CliLaunch {
  const exported = environment.PASEO_CLI?.trim();
  if (exported) {
    return SCRIPT_FILE.test(exported) ? { command: execPath, prefixArgs: [exported] } : { command: exported, prefixArgs: [] };
  }
  if (platform === "win32") {
    const bundled = path.win32.join(path.win32.dirname(execPath), "resources", "bin", "paseo.cmd");
    if (fileExists(bundled)) return { command: bundled, prefixArgs: [] };
  }
  return { command: "paseo", prefixArgs: [] };
}

// The slice of `paseo plugin ls --json` items this plugin reads; status stays a string so a status
// added by a newer Paseo does not break the list
const InstalledPluginSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  path: z.string(),
  enabled: z.boolean(),
  status: z.string(),
  source: z.string().optional(),
  npm: z.object({ packageName: z.string() }).optional(),
  installation: z.object({ identity: z.object({ kind: z.string() }) }).optional(),
  error: z.string().optional(),
});
export type InstalledPlugin = z.infer<typeof InstalledPluginSchema>;

export function parsePluginList(stdout: string): InstalledPlugin[] {
  return z.array(InstalledPluginSchema).parse(JSON.parse(stdout));
}

/** Paseo cloned or downloaded the plugin into its own folder, so `paseo plugin update` owns its updates */
export function isManagedInstall(plugin: InstalledPlugin): boolean {
  const kind = plugin.installation?.identity.kind;
  if (kind !== undefined) return kind !== "directory";
  return plugin.source === "git" || plugin.npm !== undefined;
}

const UpdateOutcomeSchema = z.object({
  id: z.string(),
  /** update, current, installed-newer, local, error (check); updated, error (apply) */
  outcome: z.string(),
  current: z.object({ currentRevision: z.string().optional() }).optional(),
  target: z.object({ commit: z.string().optional(), version: z.string().optional() }).optional(),
  error: z.string().optional(),
  warning: z.string().optional(),
});

export interface ManagedOutcome {
  id: string;
  outcome: string;
  /** Installed commit or npm version */
  current: string | null;
  /** Latest commit or npm version the check found */
  latest: string | null;
  error: string | null;
  warning: string | null;
}

/** Reads `paseo plugin update ... --json`, whose items are previews, or apply results when `--yes` applied them */
export function parseUpdateOutcomes(stdout: string): ManagedOutcome[] {
  return z
    .array(UpdateOutcomeSchema)
    .parse(JSON.parse(stdout))
    .map((item) => ({
      id: item.id,
      outcome: item.outcome,
      current: item.current?.currentRevision ?? null,
      latest: item.target?.commit ?? item.target?.version ?? null,
      error: item.error ?? null,
      warning: item.warning ?? null,
    }));
}
