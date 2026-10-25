import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import type { BottomTabBarProps } from "expo-router/build/layouts/Tabs";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { C, Fonts } from "@/constants/theme";

type IconName = keyof typeof Ionicons.glyphMap;

type Item = {
  name: string;
  label: string;
  icon: IconName;
  iconActive: IconName;
  center?: boolean;
};

/** 视觉顺序：委托 / 面板 / 对话（中心）/ 商店 / 设置 */
const ITEMS: Item[] = [
  { name: "quests", label: "委托", icon: "flag-outline", iconActive: "flag" },
  { name: "character", label: "面板", icon: "grid-outline", iconActive: "grid" },
  { name: "index", label: "对话", icon: "sparkles", iconActive: "sparkles", center: true },
  { name: "shop", label: "商店", icon: "bag-handle-outline", iconActive: "bag-handle" },
  { name: "settings", label: "设置", icon: "settings-outline", iconActive: "settings" },
];

export function GoldTabBar({ state, navigateToTab, insets }: BottomTabBarProps) {
  const activeName = state.routes[state.index]?.name;

  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 6) }]}>
      {ITEMS.map((it) => {
        const route = state.routes.find((r) => r.name === it.name);
        if (!route) return null;
        const active = activeName === it.name;

        const onPress = () => {
          Haptics.selectionAsync().catch(() => {});
          if (!active) navigateToTab(route.key);
        };

        if (it.center) {
          return (
            <Pressable
              key={it.name}
              onPress={onPress}
              style={styles.centerSlot}
              accessibilityRole="button"
              accessibilityLabel={it.label}
              accessibilityState={{ selected: active }}
            >
              {({ pressed }) => (
                <View style={[styles.centerBtn, pressed && styles.centerPressed]}>
                  <Ionicons name={it.icon} size={24} color={C.onGold} />
                </View>
              )}
            </Pressable>
          );
        }

        return (
          <Pressable
            key={it.name}
            onPress={onPress}
            style={styles.item}
            accessibilityRole="button"
            accessibilityLabel={it.label}
            accessibilityState={{ selected: active }}
          >
            {({ pressed }) => (
              <View style={[styles.itemInner, pressed && { opacity: 0.55 }]}>
                <Ionicons
                  name={active ? it.iconActive : it.icon}
                  size={21}
                  color={active ? C.accent : C.faint}
                />
                <Text style={[styles.label, { color: active ? C.accent : C.faint }]}>
                  {it.label}
                </Text>
              </View>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-around",
    backgroundColor: C.bg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.border,
    paddingTop: 8,
  },
  item: {
    flex: 1,
    alignItems: "center",
  },
  itemInner: {
    alignItems: "center",
    gap: 3,
    paddingBottom: 2,
  },
  label: {
    fontFamily: Fonts.body,
    fontSize: 10,
    letterSpacing: 0.5,
  },
  centerSlot: {
    flex: 1,
    alignItems: "center",
    marginTop: -20,
  },
  centerBtn: {
    width: 54,
    height: 54,
    borderRadius: 27,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: C.gold,
    borderWidth: 2,
    borderColor: C.bg,
    shadowColor: C.gold,
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  centerPressed: {
    transform: [{ scale: 0.94 }],
    opacity: 0.92,
  },
});
