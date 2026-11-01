import { existsSync } from "node:fs";
import { spawnProcess } from "@getpaseo/plugin/server";
import { CommandError, runCommand } from "./command";
import { type ManagedOutcome, parsePluginList, parseUpdateOutcomes, resolvePaseoCli } from "./paseo-model";
import type { PaseoTool } from "./updater";

const LIST_TIMEOUT_MS = 20_000;
const RELOAD_TIMEOUT_MS = 180_000;
const CHECK_TIMEOUT_MS = 120_000;
// Managed updates clone or download, build, and validate before swapping
const UPDATE_TIMEOUT_MS = 600_000;

/**
 * Plugin management through the Paseo CLI, since the plugin SDK has none. The CLI inherits this
 * process's PASEO_HOME, so it talks to the daemon this plugin runs in.
 */
export function createPaseoCli(): PaseoTool {
  const launch = resolvePaseoCli(process.env, process.execPath, process.platform, existsSync);
  const run = (args: string[], timeoutMs: number) =>
    runCommand(launch.command, [...launch.prefixArgs, ...args], {
      label: `paseo ${args.slice(0, 2).join(" ")}`,
      env: process.env,
      timeoutMs,
    });
  const runUpdate = async (args: string[], timeoutMs: number): Promise<ManagedOutcome[]> => {
    let stdout: string;
    try {
      stdout = await run(args, timeoutMs);
    } catch (error) {
      // `paseo plugin update` exits 1 when any plugin reports an error, after printing every result
      if (!(error instanceof CommandError) || !error.stdout.trimStart().startsWith("[")) throw error;
      stdout = error.stdout;
    }
    return parseOutput("paseo plugin update", () => parseUpdateOutcomes(stdout));
  };

  return {
    async listPlugins() {
      const stdout = await run(["plugin", "ls", "--json"], LIST_TIMEOUT_MS);
      return parseOutput("paseo plugin ls", () => parsePluginList(stdout));
    },

    async reloadPlugin(pluginId) {
      await run(["plugin", "reload", pluginId, "--json"], RELOAD_TIMEOUT_MS);
    },

    checkManaged: (pluginId) => runUpdate(["plugin", "update", pluginId ?? "--all", "--check", "--json"], CHECK_TIMEOUT_MS),

    updateManaged: (pluginId) => runUpdate(["plugin", "update", pluginId, "--yes", "--json"], UPDATE_TIMEOUT_MS),

    startDetached(args) {
      // On Windows a detached child is left out of this process's kill-on-close job, so it outlives
      // the plugin process it is about to restart
      const child = spawnProcess(launch.command, [...launch.prefixArgs, ...args], {
        env: process.env,
        detached: true,
        stdio: "ignore",
      });
      child.on("error", (error) => console.error(`[git-plugin-manager] Could not run paseo ${args.join(" ")}`, error.message));
      child.unref();
    },
  };
}

function parseOutput<T>(label: string, parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    throw new Error(`Could not read ${label} output: ${error instanceof Error ? error.message : String(error)}`);
  }
}
