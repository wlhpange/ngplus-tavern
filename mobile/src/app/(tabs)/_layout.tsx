import { Tabs } from "expo-router";

import { GoldTabBar } from "@/components/GoldTabBar";
import { C } from "@/constants/theme";

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: C.bg },
      }}
      tabBar={(props) => <GoldTabBar {...props} />}
    >
      <Tabs.Screen name="quests" options={{ title: "委托" }} />
      <Tabs.Screen name="character" options={{ title: "面板" }} />
      <Tabs.Screen name="index" options={{ title: "对话" }} />
      <Tabs.Screen name="shop" options={{ title: "商店" }} />
      <Tabs.Screen name="settings" options={{ title: "设置" }} />
    </Tabs>
  );
}
