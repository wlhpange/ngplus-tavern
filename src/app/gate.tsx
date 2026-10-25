import { useEffect, useState } from "react";
import { Redirect, useRouter } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";

import { C, Fonts, R, SHADOW } from "@/constants/theme";
import { onboardingState } from "@/lib/service";

export default function GateScreen() {
  const router = useRouter();
  const [pushing, setPushing] = useState(false);
  const [onboarded, setOnboarded] = useState<boolean | null>(null);
  const shift = useSharedValue(0);
  const rotate = useSharedValue(0);

  useEffect(() => {
    const s = onboardingState();
    setOnboarded(s.onboarded);
  }, []);

  const doorStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: shift.value }, { rotateY: `${rotate.value}deg` }],
    opacity: 1 - Math.min(0.75, Math.abs(rotate.value) / 60),
  }));

  if (onboarded) return <Redirect href="/" />;
  if (onboarded === null) return <View style={styles.loading} />;

  const push = () => {
    if (pushing) return;
    setPushing(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
    shift.value = withTiming(-10, { duration: 700, easing: Easing.out(Easing.cubic) });
    rotate.value = withTiming(-18, { duration: 700, easing: Easing.out(Easing.cubic) });
    setTimeout(() => router.push("/masters?first=1"), 700);
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <View style={styles.glow} />
      <View style={styles.badge}>
        <View style={styles.dot} />
        <Text style={styles.badgeText}>NG+ · 二周目协会</Text>
      </View>
      <Text style={styles.title}>叮 —— 您已解锁「二周目」</Text>
      <Text style={styles.subtitle}>这间协会，专为重新开始的人生服务。</Text>

      <Pressable onPress={push} accessibilityRole="button" accessibilityLabel="推开协会的门">
        <Animated.View style={[styles.door, doorStyle]}>
          <View style={styles.lamp} />
          <View style={styles.frame}>
            <View style={styles.wood} />
            <View style={styles.window} />
            <View style={styles.plate}>
              <Text style={styles.plateText}>二周目协会</Text>
            </View>
            <View style={styles.handle} />
            <View style={styles.seam} />
          </View>
        </Animated.View>
      </Pressable>

      <Text style={[styles.hint, { color: C.gold }]}>
        {pushing ? "门开了……" : "——　推开它　——"}
      </Text>
      <Text style={styles.tiny}>不用注册，也不用填任何东西</Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg, alignItems: "center", justifyContent: "center", gap: 14 },
  loading: { flex: 1, backgroundColor: C.bg },
  glow: {
    position: "absolute",
    top: -180,
    width: 480,
    height: 380,
    borderRadius: 240,
    backgroundColor: "rgba(140,107,177,0.10)",
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: C.goldLine,
    backgroundColor: C.surface,
    borderRadius: R.pill,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  dot: { width: 4, height: 4, borderRadius: 2, backgroundColor: C.gold },
  badgeText: { fontFamily: Fonts.mono, fontSize: 10, letterSpacing: 3, color: C.gold },
  title: { fontFamily: Fonts.display, fontSize: 24, color: C.fg, textAlign: "center", paddingHorizontal: 24 },
  subtitle: { fontFamily: Fonts.display, fontSize: 14, color: C.muted, textAlign: "center" },
  door: { width: 176, height: 288, marginVertical: 18 },
  lamp: {
    position: "absolute",
    top: -12,
    left: 86,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: C.gold,
    shadowColor: C.gold,
    shadowOpacity: 0.9,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 0 },
  },
  frame: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderWidth: 1,
    borderColor: C.goldLine,
    borderTopLeftRadius: 80,
    borderTopRightRadius: 80,
    backgroundColor: C.surface2,
    ...SHADOW.gold,
  },
  wood: {
    position: "absolute",
    top: 36,
    left: 8,
    right: 8,
    bottom: 8,
    borderWidth: 1,
    borderColor: C.border,
    borderTopLeftRadius: 64,
    borderTopRightRadius: 64,
    backgroundColor: C.surface,
  },
  window: {
    position: "absolute",
    top: 64,
    left: 44,
    width: 88,
    height: 80,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: 1,
    borderColor: C.borderStrong,
    backgroundColor: "rgba(217,176,97,0.18)",
  },
  plate: {
    position: "absolute",
    top: 166,
    alignSelf: "center",
    borderWidth: 1,
    borderColor: C.goldLine,
    backgroundColor: "rgba(11,8,16,0.85)",
    paddingHorizontal: 10,
    paddingVertical: 2,
    borderRadius: 4,
  },
  plateText: { fontFamily: Fonts.mono, fontSize: 9, letterSpacing: 3, color: C.gold },
  handle: {
    position: "absolute",
    right: 16,
    top: "52%",
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: C.gold,
    shadowColor: C.gold,
    shadowOpacity: 0.8,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
  },
  seam: { position: "absolute", right: 0, top: 12, bottom: 12, width: 3, borderRadius: 2, backgroundColor: "rgba(217,176,97,0.6)" },
  hint: { fontFamily: Fonts.mono, fontSize: 13, letterSpacing: 3 },
  tiny: { fontFamily: Fonts.body, fontSize: 10, color: C.faint },
});
