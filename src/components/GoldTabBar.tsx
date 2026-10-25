import { Ionicons } from "@expo/vector-icons";
import type { BottomTabBarProps } from "expo-router/build/layouts/Tabs";
import { StyleSheet, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import * as Haptics from "expo-haptics";

import { C, Fonts, SHADOW } from "@/constants/theme";

type IconName = keyof typeof Ionicons.glyphMap;
type Item = { name: string; label: string; icon: IconName; iconActive: IconName; center?: boolean };

const ITEMS: Item[] = [
  { name: "quests", label: "委托", icon: "flag-outline", iconActive: "flag" },
  { name: "character", label: "面板", icon: "grid-outline", iconActive: "grid" },
  { name: "index", label: "对话", icon: "sparkles", iconActive: "sparkles", center: true },
  { name: "shop", label: "商店", icon: "bag-handle-outline", iconActive: "bag-handle" },
  { name: "settings", label: "设置", icon: "settings-outline", iconActive: "settings" },
];

function TabItem({ active, item, onPress }: { active: boolean; item: Item; onPress: () => void }) {
  const scale = useSharedValue(active ? 1.06 : 1);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <AnimatedPressable
      onPressIn={() => {
        scale.value = withSpring(0.9, { damping: 18, stiffness: 380 });
      }}
      onPressOut={() => {
        scale.value = withSpring(active ? 1.06 : 1, { damping: 15, stiffness: 260 });
      }}
      onPress={() => {
        Haptics.selectionAsync().catch(() => {});
        onPress();
      }}
      style={[styles.item, item.center && styles.centerSlot, style]}
      accessibilityRole="button"
      accessibilityLabel={item.label}
      accessibilityState={{ selected: active }}
    >
      {item.center ? (
        <View style={styles.centerBtn}>
          <Ionicons name={item.icon} size={24} color={C.onGold} />
        </View>
      ) : (
        <>
          <Ionicons name={active ? item.iconActive : item.icon} size={21} color={active ? C.gold : C.faint} />
          <Text style={[styles.label, { color: active ? C.gold : C.faint }]}>{item.label}</Text>
          {active ? <View style={styles.activeDot} /> : null}
        </>
      )}
    </AnimatedPressable>
  );
}

const AnimatedPressable = Animated.createAnimatedComponent(
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require("react-native").Pressable,
);

export function GoldTabBar({ state, navigateToTab, insets }: BottomTabBarProps) {
  const activeName = state.routes[state.index]?.name;
  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 6) }]}>
      {ITEMS.map((it) => {
        const route = state.routes.find((r) => r.name === it.name);
        if (!route) return null;
        return (
          <TabItem
            key={it.name}
            item={it}
            active={activeName === it.name}
            onPress={() => {
              if (activeName !== it.name) navigateToTab(route.key);
            }}
          />
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
  item: { flex: 1, alignItems: "center", gap: 3, paddingBottom: 2 },
  centerSlot: { marginTop: -20 },
  centerBtn: {
    width: 54,
    height: 54,
    borderRadius: 27,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: C.gold,
    borderWidth: 2,
    borderColor: C.bg,
    ...SHADOW.gold,
  },
  label: { fontFamily: Fonts.body, fontSize: 10, letterSpacing: 0.5 },
  activeDot: { position: "absolute", bottom: -6, width: 3, height: 3, borderRadius: 2, backgroundColor: C.gold },
});
