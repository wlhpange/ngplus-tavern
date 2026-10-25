import { useEffect } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn, FadeInDown, FadeOut, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from "react-native-reanimated";
import * as Haptics from "expo-haptics";

import { ATTR_LABEL } from "@/weblib/labels";
import { C, Fonts, R, S } from "@/constants/theme";

export interface CeremonyEvent {
  type: "level_up" | "rank_up";
  scope?: string;
  from: string | number;
  to: string | number;
  gold?: number;
  items?: { name: string; count: number }[];
}

function scopeLabel(scope?: string) {
  if (!scope || scope === "total") return "总等级";
  return `${ATTR_LABEL[scope] ?? scope} 属性`;
}

export function CeremonyOverlay({ event, onDone }: { event: CeremonyEvent; onDone: () => void }) {
  const isRank = event.type === "rank_up";
  useEffect(() => {
    try {
      void Haptics.notificationAsync(
        isRank ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning,
      );
    } catch {
      /* noop */
    }
    const timer = setTimeout(onDone, isRank ? 3000 : 2400);
    return () => clearTimeout(timer);
  }, [event, isRank, onDone]);

  const pulse = useSharedValue(0.85);
  useEffect(() => {
    pulse.value = withRepeat(withSequence(withTiming(1.08, { duration: 420 }), withTiming(0.95, { duration: 420 })), -1, true);
  }, [pulse]);
  const pulseStyle = useAnimatedStyle(() => ({ transform: [{ scale: pulse.value }] }));

  if (!isRank) {
    return (
      <Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(240)} pointerEvents="none" style={styles.levelWrap}>
        <View style={styles.levelCard}>
          <Text style={styles.kicker}>等级提升</Text>
          <Text style={styles.levelValue}>
            Lv.{event.from} → Lv.{event.to}
          </Text>
          <Text style={styles.sub}>{scopeLabel(event.scope)}</Text>
        </View>
      </Animated.View>
    );
  }

  return (
    <Animated.View entering={FadeIn.duration(220)} exiting={FadeOut.duration(260)} style={styles.rankWrap}>
      <Pressable style={styles.rankInner} onPress={onDone}>
        <Animated.View style={[styles.rankSeal, pulseStyle]}>
          <Text style={styles.rankFrom}>{event.from}</Text>
          <Text style={styles.rankTo}>{event.to}</Text>
        </Animated.View>
        <Animated.Text entering={FadeInDown.delay(180)} style={styles.kicker}>
          突 破 达 成
        </Animated.Text>
        <Text style={styles.rankSub}>
          {event.from} → {event.to}
          {event.gold ? ` · 酬金 ${event.gold} 金币` : ""}
        </Text>
        {event.items?.length ? (
          <Text style={styles.rankSub}>突破礼：{event.items.map((i) => `${i.name} ×${i.count}`).join("、")}</Text>
        ) : null}
        <Text style={styles.hint}>协会的蜡封已经重铸</Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  levelWrap: { position: "absolute", left: 0, right: 0, top: "34%", alignItems: "center", zIndex: 80 },
  levelCard: {
    borderRadius: R.card,
    borderWidth: 1,
    borderColor: C.goldLine,
    backgroundColor: C.surface,
    paddingHorizontal: S.xl,
    paddingVertical: S.lg,
    alignItems: "center",
    gap: 4,
    shadowColor: C.gold,
    shadowOpacity: 0.4,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 0 },
    elevation: 14,
  },
  kicker: { fontFamily: Fonts.mono, fontSize: 11, color: C.gold, letterSpacing: 4 },
  levelValue: { fontFamily: Fonts.display, fontSize: 28, color: C.gold },
  sub: { fontFamily: Fonts.body, fontSize: 11, color: C.muted },
  rankWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    zIndex: 90,
    backgroundColor: "rgba(11,8,16,0.82)",
    alignItems: "center",
    justifyContent: "center",
  },
  rankInner: { alignItems: "center", gap: S.sm, padding: S.xl },
  rankSeal: {
    width: 150,
    height: 150,
    borderRadius: 75,
    backgroundColor: C.danger,
    borderWidth: 3,
    borderColor: C.goldLine,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: C.gold,
    shadowOpacity: 0.6,
    shadowRadius: 32,
    shadowOffset: { width: 0, height: 0 },
    elevation: 18,
  },
  rankFrom: { position: "absolute", fontFamily: Fonts.display, fontSize: 52, color: "rgba(217,176,97,0.25)" },
  rankTo: { fontFamily: Fonts.display, fontSize: 64, color: C.gold },
  rankSub: { fontFamily: Fonts.mono, fontSize: 12, color: C.fg },
  hint: { fontFamily: Fonts.body, fontSize: 11, color: C.faint, marginTop: 4 },
});
