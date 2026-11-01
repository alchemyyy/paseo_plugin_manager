import type { PluginPopoverProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon, SidebarRow, SidebarSeparator, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  checkPluginsRpc,
  type OperationKind,
  type PluginEntry,
  pluginsStateRpc,
  preferences,
  updatePluginsRpc,
} from "../shared/contracts";
import { PluginDetails } from "./plugin-details";
import { buildStatusIcons, rowStatus, updateText } from "./plugin-status";
import { PLUGINS_QUERY_KEY } from "./query-keys";
import { SectionHeader } from "./section-header";

// Catches plugins installed or removed elsewhere and repositories pulled in a terminal
const IDLE_POLL_INTERVAL_MS = 60_000;
// While a check or update runs, so rows follow its progress
const BUSY_POLL_INTERVAL_MS = 1_000;
const TRAILING_ICON_SIZE = 14;
const HIT_SLOP = { top: 6, bottom: 6, left: 6, right: 6 };
const TOAST_DURATION_MS = 5_000;
const ERROR_TOAST_DURATION_MS = 8_000;

/**
 * Sidebar block: a collapsible header that checks or updates every plugin, then one row per plugin.
 * Collapsed, only plugins with an update stay listed.
 */
export function PluginsItem({ theme, layout, openPopover }: PluginSidebarItemProps) {
  const getState = useRpc(pluginsStateRpc);
  const startCheck = useRpc(checkPluginsRpc);
  const startUpdate = useRpc(updatePluginsRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const settings = useSettings(preferences);
  const [expandedOverride, setExpandedOverride] = useState<boolean | null>(null);
  // Operations started from this window, toasted when they finish
  const awaited = useRef(new Set<string>());
  const state = useQuery({
    queryKey: PLUGINS_QUERY_KEY,
    queryFn: () => getState({}),
    refetchInterval: (query) =>
      query.state.data?.operations.some((operation) => operation.state !== "done")
        ? BUSY_POLL_INTERVAL_MS
        : IDLE_POLL_INTERVAL_MS,
  });
  const statusIcons = useMemo(() => buildStatusIcons(theme), [theme]);
  const data = state.data;

  useEffect(() => {
    for (const operation of data?.operations ?? []) {
      if (operation.state !== "done" || !awaited.current.delete(operation.id) || !operation.summary) continue;
      toast.show(operation.summary, {
        variant: operation.variant ?? "default",
        durationMs: operation.variant === "error" ? ERROR_TOAST_DURATION_MS : TOAST_DURATION_MS,
      });
    }
  }, [data, toast]);

  const start = async (kind: OperationKind, plugin: PluginEntry | null) => {
    try {
      const { operationId } = await (kind === "check" ? startCheck : startUpdate)({ pluginId: plugin?.id ?? null });
      awaited.current.add(operationId);
      await queryClient.invalidateQueries({ queryKey: PLUGINS_QUERY_KEY });
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      toast.error(`Could not ${kind} ${plugin?.name ?? "plugins"}: ${message}`);
    }
  };

  const expanded = expandedOverride ?? (settings.status === "ready" ? settings.values.expanded : false);
  const toggleExpanded = () => {
    const next = !expanded;
    setExpandedOverride(next);
    if (settings.status === "ready") void settings.save({ ...settings.values, expanded: next }, settings.revision);
  };

  const showPlugin = (plugin: PluginEntry) => {
    openPopover(function PluginPopover({ close }: PluginPopoverProps) {
      return (
        <PluginDetails
          theme={theme}
          plugin={plugin}
          onCheck={() => {
            close();
            void start("check", plugin);
          }}
          onUpdate={() => {
            close();
            void start("update", plugin);
          }}
        />
      );
    });
  };

  const showError = (title: string, message: string) => {
    openPopover(function ErrorPopover() {
      return (
        <View style={{ padding: 12, gap: 6, maxWidth: 360 }}>
          <Text style={{ color: theme.colors.statusDanger, fontWeight: "600" }}>{title}</Text>
          <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            {message}
          </Text>
        </View>
      );
    });
  };

  const plugins = data?.plugins ?? [];
  const running = data?.operations.find((operation) => operation.state !== "done") ?? null;
  const queryError = state.error ? (state.error instanceof Error ? state.error.message : String(state.error)) : null;
  const listError = queryError ?? data?.error ?? null;
  const visible = expanded ? plugins : plugins.filter((plugin) => plugin.updateAvailable);
  let label = "Plugins";
  if (running) label = running.kind === "check" ? "Plugins (checking)" : "Plugins (updating)";

  return (
    <>
      <SidebarSeparator />
      <SectionHeader
        theme={theme}
        compact={layout.compact}
        icon="Puzzle"
        label={label}
        expanded={expanded}
        onToggle={toggleExpanded}
        trailing={
          <ActionButtons
            theme={theme}
            checkLabel="Check all plugins for updates"
            updateLabel="Update all plugins"
            updateHighlighted={plugins.some((plugin) => plugin.updateAvailable)}
            disabled={running !== null}
            onCheck={() => void start("check", null)}
            onUpdate={() => void start("update", null)}
          />
        }
      />
      {listError ? (
        <SidebarRow
          id="error"
          icon={statusIcons.failed}
          label="Plugins unavailable"
          onPress={() => showError("Could not list plugins", listError)}
        />
      ) : null}
      {visible.map((plugin) => (
        <SidebarRow
          key={plugin.id}
          id={plugin.id}
          icon={statusIcons[rowStatus(plugin)]}
          label={rowLabel(plugin)}
          onPress={() => showPlugin(plugin)}
          trailing={
            <ActionButtons
              theme={theme}
              checkLabel={`Check ${plugin.name} for updates`}
              updateLabel={`Update and install ${plugin.name}`}
              updateHighlighted={plugin.updateAvailable}
              disabled={plugin.activity !== null}
              onCheck={() => void start("check", plugin)}
              onUpdate={() => void start("update", plugin)}
            />
          }
        />
      ))}
    </>
  );
}

function rowLabel(plugin: PluginEntry): string {
  if (plugin.activity === "checking") return `${plugin.name} (checking)`;
  if (plugin.activity === "updating") return `${plugin.name} (updating)`;
  return plugin.updateAvailable ? `${plugin.name} · ${updateText(plugin)}` : plugin.name;
}

/** Check for updates, then update and install; the update icon takes the accent color when one is waiting */
function ActionButtons({
  theme,
  checkLabel,
  updateLabel,
  updateHighlighted,
  disabled,
  onCheck,
  onUpdate,
}: {
  theme: PluginSidebarItemProps["theme"];
  checkLabel: string;
  updateLabel: string;
  updateHighlighted: boolean;
  disabled: boolean;
  onCheck(): void;
  onUpdate(): void;
}) {
  const buttons = [
    { icon: "RefreshCw", label: checkLabel, color: theme.colors.foregroundMuted, onPress: onCheck },
    {
      icon: "Download",
      label: updateLabel,
      color: updateHighlighted ? theme.colors.accent : theme.colors.foregroundMuted,
      onPress: onUpdate,
    },
  ];
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
      {buttons.map((button) => (
        <Pressable
          key={button.icon}
          accessibilityRole="button"
          accessibilityLabel={button.label}
          accessibilityState={{ disabled }}
          disabled={disabled}
          hitSlop={HIT_SLOP}
          onPress={button.onPress}
          style={{ opacity: disabled ? 0.4 : 1 }}
        >
          <Icon name={button.icon} size={TRAILING_ICON_SIZE} color={button.color} />
        </Pressable>
      ))}
    </View>
  );
}
