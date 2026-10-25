import { useEffect, useRef, useState } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useFonts } from "expo-font";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";

import { C, Fonts } from "@/constants/theme";
import { initApp, runCatchUp, waitForSecrets, watchForeground, type CatchUpResult } from "@/lib/bootstrap";
import { ToastProvider, useToast } from "@/components/Toast";

function Splash() {
  return (
    <View style={styles.splash}>
      <View style={styles.sigil}>
        <Text style={styles.sigilText}>✦</Text>
      </View>
      <Text style={styles.splashTitle}>二周目协会</Text>
      <Text style={styles.splashSub}>正在点灯……</Text>
    </View>
  );
}

function Shell({ ready }: { ready: boolean }) {
  const toast = useToast();
  const onCatchUp = useRef((r: CatchUpResult) => {
    if (r.mutated > 0) toast("跨天补算完成：有委托断了签。", "info");
  });
  useEffect(() => {
    if (!ready) return;
    watchForeground((r) => onCatchUp.current(r));
  }, [ready]);

  if (!ready) return <Splash />;
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: C.bg },
        animation: "slide_from_right",
        animationDuration: 240,
        gestureEnabled: true,
        fullScreenGestureEnabled: true,
      }}
    >
      <Stack.Screen name="(tabs)" options={{ animation: "fade" }} />
      <Stack.Screen name="gate" options={{ animation: "fade" }} />
      <Stack.Screen name="masters" options={{ presentation: "card" }} />
      <Stack.Screen name="worldbook" />
      <Stack.Screen name="memory" />
      <Stack.Screen name="records" />
      <Stack.Screen name="archive" />
      <Stack.Screen name="skills" />
      <Stack.Screen name="settings/model" />
      <Stack.Screen name="settings/image" />
    </Stack>
  );
}

export default function RootLayout() {
  const [ready, setReady] = useState(false);
  // 标题用霞鹜文楷（子集化，见 assets/fonts/OFL-LXGWWenKai.txt）；正文仍走系统字体
  const [fontsLoaded, fontError] = useFonts({
    LXGWWenKai: require("../../assets/fonts/LXGWWenKai-Regular.ttf"),
  });
  useEffect(() => {
    initApp();
    void (async () => {
      await waitForSecrets();
      await runCatchUp().catch(() => null);
      setReady(true);
    })();
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: C.bg }}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        <ToastProvider>
          <Shell ready={ready && (fontsLoaded || Boolean(fontError))} />
        </ToastProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  splash: { flex: 1, backgroundColor: C.bg, alignItems: "center", justifyContent: "center", gap: 10 },
  sigil: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 1,
    borderColor: C.goldLine,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: C.goldSoft,
  },
  sigilText: { fontFamily: Fonts.display, fontSize: 30, color: C.gold },
  splashTitle: { fontFamily: Fonts.display, fontSize: 24, color: C.fg, letterSpacing: 2 },
  splashSub: { fontFamily: Fonts.mono, fontSize: 11, color: C.faint, letterSpacing: 3 },
});
