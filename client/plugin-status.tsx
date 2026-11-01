import type { PluginIconProps, PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/ui";
import type { ComponentType } from "react";
import type { PluginEntry } from "../shared/contracts";

/** What a plugin's row icon shows, most urgent first */
export type RowStatus = "busy" | "failed" | "problem" | "update" | "untracked" | "current";

const STATUS_ICON_NAMES: Record<RowStatus, string> = {
  busy: "LoaderCircle",
  failed: "CircleX",
  problem: "CircleAlert",
  update: "CircleArrowDown",
  untracked: "CircleDashed",
  current: "CircleCheck",
};

export function rowStatus(plugin: PluginEntry): RowStatus {
  if (plugin.activity !== null) return "busy";
  if (plugin.status === "failed") return "failed";
  if (plugin.problem !== null) return "problem";
  if (plugin.updateAvailable) return "update";
  const tracked =
    (plugin.source === "git" && plugin.git?.upstream != null) || (plugin.source === "managed" && plugin.managed !== null);
  return tracked ? "current" : "untracked";
}

export function statusColor(theme: PluginTheme, status: RowStatus): string {
  switch (status) {
    case "update":
      return theme.colors.accent;
    case "current":
      return theme.colors.statusSuccess;
    case "failed":
    case "problem":
      return theme.colors.statusDanger;
    case "busy":
    case "untracked":
      return theme.colors.foregroundMuted;
  }
}

/** "3 new commits" for a Git checkout; Paseo-managed installs report no commit count */
export function updateText(plugin: PluginEntry): string {
  const behind = plugin.git?.behind ?? 0;
  if (behind === 0) return "update available";
  return `${behind} new commit${behind === 1 ? "" : "s"}`;
}

/** Status icons tinted by theme; SidebarRow passes only size and its own color, so the tint is baked in */
export function buildStatusIcons(theme: PluginTheme): Record<RowStatus, ComponentType<PluginIconProps>> {
  const icons = {} as Record<RowStatus, ComponentType<PluginIconProps>>;
  for (const status of Object.keys(STATUS_ICON_NAMES) as RowStatus[]) {
    const name = STATUS_ICON_NAMES[status];
    const color = statusColor(theme, status);
    icons[status] = function StatusIcon({ size }: PluginIconProps) {
      return <Icon name={name} size={size} color={color} />;
    };
  }
  return icons;
}
