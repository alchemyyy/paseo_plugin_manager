import type { PluginTheme } from "@getpaseo/plugin";
import { Platform, Pressable, Text, View } from "react-native";
import type { GitState, PluginEntry, PluginSource } from "../shared/contracts";
import { rowStatus, statusColor, updateText } from "./plugin-status";

const SOURCE_LABELS: Record<PluginSource, string> = {
  git: "Git checkout",
  folder: "Local folder",
  managed: "Installed by Paseo",
};
const MAX_SHOWN_COMMITS = 10;
const BUTTON_STYLE = { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 };
const MONOSPACE = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });
const FULL_COMMIT_HASH = /^[0-9a-f]{40,64}$/;

/** A plugin's source, upstream state, incoming commits, and failures, with its two actions */
export function PluginDetails({
  theme,
  plugin,
  onCheck,
  onUpdate,
}: {
  theme: PluginTheme;
  plugin: PluginEntry;
  onCheck(): void;
  onUpdate(): void;
}) {
  const muted = theme.colors.foregroundMuted;
  const danger = theme.colors.statusDanger;
  const busy = plugin.activity !== null;
  const shownCommits = plugin.git?.incoming.slice(0, MAX_SHOWN_COMMITS) ?? [];
  const hiddenCommits = (plugin.git?.behind ?? 0) - shownCommits.length;

  return (
    <View style={{ padding: 12, gap: 6, maxWidth: 380 }}>
      <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{plugin.name}</Text>
      <Text style={{ color: muted, fontSize: 12 }}>
        {plugin.id} · {SOURCE_LABELS[plugin.source]}
        {plugin.enabled ? "" : " · disabled"}
      </Text>
      {plugin.git ? (
        <Text selectable style={{ color: muted, fontSize: 12 }}>
          {branchLine(plugin.git)}
        </Text>
      ) : null}
      <Text style={{ color: statusColor(theme, rowStatus(plugin)), fontSize: 12 }}>{statusText(plugin)}</Text>
      {plugin.checkedAt === null ? null : (
        <Text style={{ color: muted, fontSize: 12 }}>Checked {formatAge(Date.now() - plugin.checkedAt)}</Text>
      )}
      {shownCommits.length > 0 ? (
        <View style={{ gap: 2, marginTop: 2 }}>
          {shownCommits.map((commit) => (
            <Text key={commit.hash} selectable numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 12 }}>
              <Text style={{ color: muted, fontFamily: MONOSPACE }}>{commit.hash}</Text> {commit.subject}
            </Text>
          ))}
          {hiddenCommits > 0 ? <Text style={{ color: muted, fontSize: 12 }}>and {hiddenCommits} more</Text> : null}
        </View>
      ) : null}
      {plugin.problem ? (
        <Text selectable style={{ color: danger, fontSize: 12 }}>
          {plugin.problem}
        </Text>
      ) : null}
      {plugin.loadError ? (
        <Text selectable style={{ color: danger, fontSize: 12 }}>
          Paseo could not load it: {plugin.loadError}
        </Text>
      ) : null}
      <Text selectable style={{ color: muted, fontSize: 11 }}>
        {plugin.path}
      </Text>
      <View style={{ flexDirection: "row", gap: 8, marginTop: 4 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={onCheck}
          style={[BUTTON_STYLE, { backgroundColor: theme.colors.surface2, opacity: busy ? 0.6 : 1 }]}
        >
          <Text style={{ color: theme.colors.foreground }}>Check for updates</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={onUpdate}
          style={[BUTTON_STYLE, { backgroundColor: theme.colors.accent, opacity: busy ? 0.6 : 1 }]}
        >
          <Text style={{ color: theme.colors.accentForeground }}>Update and install</Text>
        </Pressable>
      </View>
    </View>
  );
}

function branchLine(git: GitState): string {
  const upstream = git.upstream === null ? "" : ` → ${git.upstream}`;
  const head = git.head === null ? "" : ` · ${git.head.slice(0, 7)}`;
  return `${git.branch ?? "detached HEAD"}${upstream}${head}`;
}

function statusText(plugin: PluginEntry): string {
  if (plugin.activity === "checking") return "Checking for updates...";
  if (plugin.activity === "updating") return "Updating...";
  switch (plugin.source) {
    case "folder":
      return "Not in a Git repository; Update and install reloads it from disk";
    case "managed": {
      if (plugin.managed === null) return "Not checked yet";
      const { current, latest } = plugin.managed;
      if (plugin.updateAvailable) return `Update available: ${revision(current)} → ${revision(latest)}`;
      return current === null ? "Up to date" : `Up to date (${revision(current)})`;
    }
    case "git": {
      const { git } = plugin;
      if (git === null) return "Git state unavailable";
      if (git.upstream === null) {
        return git.branch === null ? "Detached HEAD; nothing to update from" : `${git.branch} has no upstream branch to update from`;
      }
      if (git.upstreamGone) return `Upstream ${git.upstream} no longer exists`;
      const notes = [git.behind > 0 ? `${updateText(plugin)} on ${git.upstream}` : `Up to date with ${git.upstream}`];
      if (git.ahead > 0) notes.push(`${git.ahead} local commit${git.ahead === 1 ? "" : "s"} not on ${git.upstream}`);
      if (git.changedFiles > 0) notes.push(`${git.changedFiles} changed file${git.changedFiles === 1 ? "" : "s"}`);
      return notes.join(" · ");
    }
  }
}

/** Abbreviates commit hashes; npm versions stay whole */
function revision(value: string | null): string {
  if (value === null) return "unknown";
  return FULL_COMMIT_HASH.test(value) ? value.slice(0, 7) : value;
}

function formatAge(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
}
