import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/ui";
import { type ReactNode, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

// SidebarRow's geometry from Paseo's theme tokens (the plugin theme carries only colors): rows and
// icons grow on compact layouts. SidebarRow's label is a plain string, so it cannot hold the chevron.
const ROW_HEIGHT = { regular: 28, compact: 36 };
const ICON_SIZE = { regular: 14, compact: 18 };
const CHEVRON_SIZE = { regular: 12, compact: 14 };
const LABEL_FONT_SIZE = 14;
// Foreground washes approximate the sidebar's hover and pressed fills in light and dark themes
const HOVER_TINT = 0.06;
const PRESSED_TINT = 0.1;

/** A header row that looks like SidebarRow, with a disclosure chevron right after its label */
export function SectionHeader({
  theme,
  compact,
  icon,
  label,
  expanded,
  onToggle,
  trailing,
}: {
  theme: PluginTheme;
  compact: boolean;
  /** Lucide icon name */
  icon: string;
  label: string;
  expanded: boolean;
  onToggle(): void;
  /** Buttons at the right edge; they press on their own */
  trailing: ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const size = compact ? "compact" : "regular";
  const color = hovered ? theme.colors.foreground : theme.colors.foregroundMuted;
  let tint = 0;
  if (pressed) tint = PRESSED_TINT;
  else if (hovered) tint = HOVER_TINT;

  return (
    <View style={styles.container}>
      <View
        style={[styles.row, { minHeight: ROW_HEIGHT[size] }]}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => {
          setHovered(false);
          setPressed(false);
        }}
      >
        {tint > 0 ? (
          <View pointerEvents="none" style={[styles.tint, { backgroundColor: theme.colors.foreground, opacity: tint }]} />
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ expanded }}
          onPress={onToggle}
          onPressIn={() => setPressed(true)}
          onPressOut={() => setPressed(false)}
          style={[styles.button, { minHeight: ROW_HEIGHT[size] }]}
        >
          <Icon name={icon} size={ICON_SIZE[size]} color={color} />
          <View style={styles.title}>
            <Text numberOfLines={1} selectable={false} style={[styles.label, { color }]}>
              {label}
            </Text>
            <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={CHEVRON_SIZE[size]} color={theme.colors.foregroundMuted} />
          </View>
        </Pressable>
        <View style={styles.trailing}>{trailing}</View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 8 },
  row: { flexDirection: "row", alignItems: "center", borderRadius: 8 },
  tint: { ...StyleSheet.absoluteFillObject, borderRadius: 8 },
  button: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  title: { flexShrink: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 4 },
  label: { flexShrink: 1, fontSize: LABEL_FONT_SIZE },
  trailing: { flexDirection: "row", alignItems: "center", paddingRight: 8 },
});
