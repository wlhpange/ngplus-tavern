import { StyleSheet, Text, View } from "react-native";

import { Card } from "@/components/Card";
import { Page } from "@/components/Page";
import { C, Fonts, R, S } from "@/constants/theme";

const ATTRS = [
  { name: "体魄", value: 1, color: "#E2795E" },
  { name: "心智", value: 1, color: "#6FA6D8" },
  { name: "意志", value: 1, color: "#A98BE8" },
  { name: "财富", value: 1, color: "#D9B061" },
  { name: "社交", value: 1, color: "#D98FB5" },
  { name: "创造", value: 1, color: "#5FD8C4" },
];

export default function CharacterScreen() {
  return (
    <Page title="面板" subtitle="协会宗卷室 · 与结算记录同源">
      <Card>
        <View style={styles.topRow}>
          <View style={styles.rank}>
            <Text style={styles.rankText}>F</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.level}>Lv.1</Text>
            <Text style={styles.meta}>距下一级 150 XP</Text>
            <View style={styles.track}>
              <View style={[styles.fill, { width: "4%" }]} />
            </View>
          </View>
        </View>
        <View style={styles.goldRow}>
          <Text style={styles.meta}>金币</Text>
          <Text style={styles.gold}>0</Text>
        </View>
      </Card>

      <Card>
        <Text style={styles.cardTitle}>属性星图</Text>
        {ATTRS.map((a) => (
          <View key={a.name} style={styles.attrRow}>
            <Text style={styles.attrName}>{a.name}</Text>
            <View style={styles.attrTrack}>
              <View style={[styles.attrFill, { width: "12%", backgroundColor: a.color }]} />
            </View>
            <Text style={styles.attrValue}>{a.value}</Text>
          </View>
        ))}
        <Text style={styles.hint}>首版先占位；委托结算接入后会实时变化。</Text>
      </Card>
    </Page>
  );
}

const styles = StyleSheet.create({
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: S.lg,
  },
  rank: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 2,
    borderColor: C.goldLine,
    backgroundColor: C.goldSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  rankText: {
    fontFamily: Fonts.display,
    fontSize: 32,
    color: C.gold,
  },
  level: {
    fontFamily: Fonts.display,
    fontSize: 24,
    color: C.gold,
  },
  meta: {
    fontFamily: Fonts.body,
    fontSize: 12,
    color: C.muted,
  },
  track: {
    height: 6,
    borderRadius: 3,
    backgroundColor: C.surface3,
    overflow: "hidden",
    marginTop: S.sm,
  },
  fill: {
    height: "100%",
    backgroundColor: C.gold,
  },
  goldRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: S.md,
    paddingTop: S.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.border,
  },
  gold: {
    fontFamily: Fonts.mono,
    fontSize: 16,
    color: C.gold,
  },
  cardTitle: {
    fontFamily: Fonts.display,
    fontSize: 18,
    color: C.gold,
    marginBottom: S.sm,
  },
  attrRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: S.sm,
    paddingVertical: 4,
  },
  attrName: {
    width: 36,
    fontFamily: Fonts.body,
    fontSize: 13,
    color: C.fg,
  },
  attrTrack: {
    flex: 1,
    height: 6,
    borderRadius: 3,
    backgroundColor: C.surface3,
    overflow: "hidden",
  },
  attrFill: {
    height: "100%",
    borderRadius: 3,
  },
  attrValue: {
    width: 24,
    textAlign: "right",
    fontFamily: Fonts.mono,
    fontSize: 12,
    color: C.muted,
  },
  hint: {
    fontFamily: Fonts.body,
    fontSize: 11,
    color: C.faint,
    marginTop: S.sm,
  },
});
