import { useEffect } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { C } from "@/constants/theme";
import { initDb } from "@/lib/db";

export default function RootLayout() {
  useEffect(() => {
    initDb();
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: C.bg },
          animation: "fade",
        }}
      />
    </SafeAreaProvider>
  );
}
