import { StyleSheet, Text, View } from "react-native";

import { Card } from "@/components/Card";
import { Page } from "@/components/Page";
import { C, Fonts, S } from "@/constants/theme";

const ROADMAP = [
  ["委托板", "按状态看全部委托，完成的可以重挂"],
  ["结算", "汇报 → 会长判定 → 经验 / 金币 / 六维"],
  ["连击", "断签与休整卷轴，保住连续天数"],
];

export default function QuestsScreen() {
  return (
    <Page title="委托" subtitle="任务模式 · 与会长结算">
      <Card>
        <Text style={styles.emptyTitle}>还没有委托</Text>
        <Text style={styles.body}>
          Android 首版先把对话和本地库跑通。委托管线按下面三步接进来。
        </Text>
      </Card>

      {ROADMAP.map(([title, desc], i) => (
        <Card key={title}>
          <View style={styles.row}>
            <Text style={styles.index}>{String(i + 1).padStart(2, "0")}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.itemTitle}>{title}</Text>
              <Text style={styles.body}>{desc}</Text>
            </View>
          </View>
        </Card>
      ))}
    </Page>
  );
}

const styles = StyleSheet.create({
  emptyTitle: {
    fontFamily: Fonts.display,
    fontSize: 18,
    color: C.fg,
  },
  body: {
    fontFamily: Fonts.body,
    fontSize: 13,
    lineHeight: 20,
    color: C.muted,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: S.md,
  },
  index: {
    fontFamily: Fonts.mono,
    fontSize: 12,
    color: C.gold,
    paddingTop: 3,
  },
  itemTitle: {
    fontFamily: Fonts.display,
    fontSize: 16,
    color: C.fg,
    marginBottom: 2,
  },
});
