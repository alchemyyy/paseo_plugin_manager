import type { PluginClientContext } from "@getpaseo/plugin/client";
import { PluginsItem } from "./client/plugins-item";

export default function contribute(client: PluginClientContext) {
  return client.addSidebarHeaderItem({ id: "plugins", title: "Plugins", Component: PluginsItem });
}
