import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createGit } from "./server/git";
import { installDependencies } from "./server/npm";
import { createPaseoCli } from "./server/paseo-cli";
import { PluginUpdater } from "./server/updater";
import { checkPluginsRpc, pluginsStateRpc, preferences, updatePluginsRpc } from "./shared/contracts";

// NOTE: must match paseo-plugin.json: the updater reloads this plugin last, from a detached process
const SELF_PLUGIN_ID = "git-plugin-manager";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(preferences);
  const updater = new PluginUpdater({
    git: createGit(),
    paseo: createPaseoCli(),
    installDependencies,
    selfId: SELF_PLUGIN_ID,
    platform: process.platform,
    now: Date.now,
  });
  server.handle(pluginsStateRpc, () => updater.state());
  server.handle(checkPluginsRpc, ({ pluginId }) => ({ operationId: updater.enqueue("check", pluginId) }));
  server.handle(updatePluginsRpc, ({ pluginId }) => ({ operationId: updater.enqueue("update", pluginId) }));
  return updater.startAutoCheck();
}
