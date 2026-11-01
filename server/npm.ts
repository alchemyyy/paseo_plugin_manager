import { existsSync } from "node:fs";
import path from "node:path";
import { runCommand } from "./command";

const NPM_TIMEOUT_MS = 10 * 60_000;

/**
 * Reinstalls a plugin's node_modules, which Paseo bundles from each time it compiles the plugin.
 * Dev dependencies are included: Paseo resolves type-only imports from them too.
 */
export async function installDependencies(pluginPath: string): Promise<void> {
  const locked = existsSync(path.join(pluginPath, "package-lock.json"));
  const args = [locked ? "ci" : "install", "--include=dev", "--no-audit", "--no-fund"];
  await runCommand("npm", args, { label: `npm ${args[0]}`, cwd: pluginPath, env: process.env, timeoutMs: NPM_TIMEOUT_MS });
}
