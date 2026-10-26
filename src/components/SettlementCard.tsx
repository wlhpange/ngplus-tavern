import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, { FadeInDown, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from "react-native-reanimated";

import { ATTR_LABEL, KIND_LABEL, itemDisplay } from "@/weblib/labels";
import { playCue } from "@/lib/audio";
import { A, C, Fonts, R, S } from "@/constants/theme";
import { haptic } from "./ui";
import { SparkleBurst } from "./Sparkle";

export interface SettlementCardData {
  id: string;
  kind: string;
  questTitle: string | null;
  completionRatio: number | null;
  confidence: number | null;
  xpAwarded: number;
  goldAwarded: number;
  attrSplit: Record<string, number>;
  adjustments: Record<string, unknown> | null;
  createdAt: number;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function Seal({ children, tone }: { children: string; tone?: "partial" | "normal" }) {
  return (
    <View style={[styles.seal, tone === "partial" && { backgroundColor: "#6B4B2A", borderColor: "#9A7B4F" }]}>
      <Text style={styles.sealText}>{children}</Text>
    </View>
  );
}

export function SettlementCard({
  s,
  fresh = false,
  silent = false,
}: {
  s: SettlementCardData;
  fresh?: boolean;
  /** 同一轮有更隆重的仪式（升级/晋段）时静音，避免音效叠放 */
  silent?: boolean;
}) {
  const kindLabel = KIND_LABEL[s.kind] ?? s.kind;
  const title = s.questTitle ?? kindLabel;
  const isGain = s.kind === "quest_complete" || s.kind === "mainline_complete" || s.kind === "bonus";
  const partial = s.completionRatio != null && s.completionRatio < 1;
  const rarity = s.adjustments?.rarity === "legendary" ? "传说" : s.adjustments?.rarity === "rare" ? "稀有" : null;
  const itemKey = typeof s.adjustments?.item_key === "string" ? s.adjustments.item_key : null;
  const reason = typeof s.adjustments?.reason === "string" ? s.adjustments.reason : null;
  const attrs = Object.entries(s.attrSplit).filter(([, v]) => v !== 0);
  const hasDetails = attrs.length > 0 || Boolean(rarity) || Boolean(itemKey) || Boolean(reason);
  const [open, setOpen] = useState(fresh || !hasDetails);

  // 本轮新卡：按事件类型播一声（历史卡片重放不发声）
  // firedRef 防止 silent 变化（例如仪式晚到）时把同一张卡再播一遍。
  const firedRef = useRef(false);
  useEffect(() => {
    if (!fresh || firedRef.current) return;
    firedRef.current = true;
    haptic(isGain ? "success" : "light");
    if (silent) return;
    if (s.kind === "quest_complete" || s.kind === "mainline_complete") {
      playCue(partial ? "settle_partial" : "settle");
    } else if (s.kind === "purchase") {
      playCue("purchase");
    } else if (s.kind === "gift") {
      playCue("gift");
    }
  }, [fresh, silent, isGain, partial, s.kind]);

  const glow = useSharedValue(0);
  useEffect(() => {
    if (!fresh) return;
    glow.value = withSequence(withTiming(1, { duration: 320 }), withTiming(0, { duration: 1400 }));
  }, [fresh, glow]);
  const glowStyle = useAnimatedStyle(() => ({ opacity: glow.value * 0.55 }));

  return (
    <Animated.View entering={fresh ? FadeInDown.duration(260) : undefined} style={styles.card}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.sweep, glowStyle]} />
      {fresh ? (
        <View pointerEvents="none" style={styles.burst}>
          <SparkleBurst size={200} opacity={0.8} />
        </View>
      ) : null}
      <View style={styles.top}>
        <Seal tone={partial ? "partial" : "normal"}>契</Seal>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.title} numberOfLines={2}>
            {title}
          </Text>
          <Text style={styles.meta}>
            {kindLabel} · {formatTime(s.createdAt)}
            {partial ? ` · 完成度 ${Math.round((s.completionRatio ?? 0) * 100)}%` : ""}
          </Text>
        </View>
        <View style={{ alignItems: "flex-end" }}>
          {s.xpAwarded !== 0 ? (
            <Text style={styles.xp}>
              {s.xpAwarded > 0 ? "+" : ""}
              {s.xpAwarded} XP
            </Text>
          ) : null}
          {s.goldAwarded !== 0 ? (
            <Text style={styles.gold}>
              {s.goldAwarded > 0 ? "+" : ""}
              {s.goldAwarded} 金币
            </Text>
          ) : null}
        </View>
      </View>
      {hasDetails && open ? (
        <>
          <View style={styles.details}>
            {attrs.map(([k, v]) => (
              <Text key={k} style={[styles.attr, { color: A[k as keyof typeof A] ?? C.muted }]}>
                {ATTR_LABEL[k] ?? k} {v > 0 ? `+${v}` : v}
              </Text>
            ))}
            {rarity ? (
              <View style={styles.rarity}>
                <Text style={styles.rarityText}>{rarity}</Text>
              </View>
            ) : null}
            {itemKey ? (
              <Text style={styles.attr}>
                {s.kind === "purchase" ? "购入" : "送出"}：{itemDisplay(itemKey)}
              </Text>
            ) : null}
          </View>
          {reason && isGain ? <Text style={styles.reason}>复核理由：{reason}</Text> : null}
        </>
      ) : null}
      {hasDetails ? (
        <Text style={styles.toggle} onPress={() => setOpen((v) => !v)}>
          {open ? "收起 ▴" : "详情 ▾"}
        </Text>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  burst: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  card: {
    borderRadius: R.card,
    borderWidth: 1,
    borderColor: C.goldLine,
    backgroundColor: C.surface,
    padding: S.md,
    gap: 6,
    overflow: "hidden",
  },
  sweep: { backgroundColor: C.gold, opacity: 0 },
  top: { flexDirection: "row", alignItems: "flex-start", gap: S.sm },
  seal: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: C.goldLine,
    backgroundColor: C.danger,
    alignItems: "center",
    justifyContent: "center",
    transform: [{ rotate: "-8deg" }],
  },
  sealText: { fontFamily: Fonts.display, fontSize: 14, color: C.gold },
  title: { fontFamily: Fonts.display, fontSize: 15, color: C.fg },
  meta: { fontFamily: Fonts.mono, fontSize: 10, color: C.muted, marginTop: 1 },
  xp: { fontFamily: Fonts.mono, fontSize: 12, color: C.accent },
  gold: { fontFamily: Fonts.mono, fontSize: 12, color: C.gold },
  details: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.border,
    paddingTop: 6,
  },
  attr: { fontFamily: Fonts.mono, fontSize: 11, color: C.muted },
  rarity: {
    borderRadius: R.pill,
    borderWidth: 1,
    borderColor: C.goldLine,
    backgroundColor: C.goldSoft,
    paddingHorizontal: 7,
  },
  rarityText: { fontFamily: Fonts.mono, fontSize: 10, color: C.gold },
  reason: { fontFamily: Fonts.body, fontSize: 11, color: C.gold, lineHeight: 16 },
  toggle: { fontFamily: Fonts.body, fontSize: 10, color: C.faint, textAlign: "right" },
});
