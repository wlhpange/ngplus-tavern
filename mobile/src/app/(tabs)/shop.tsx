import { StyleSheet, Text, View } from "react-native";

import { Card } from "@/components/Card";
import { Page } from "@/components/Page";
import { C, Fonts, R, S } from "@/constants/theme";

const ITEMS = [
  { name: "休整卷轴", price: 100, desc: "保一次断签：断签当晚自动生效。", lv: 1 },
  { name: "一盏热茶", price: 50, desc: "给会长递一盏热茶。", lv: 2 },
  { name: "一本旧书", price: 120, desc: "旧书摊上淘到的绝版诗集。", lv: 3 },
  { name: "一盒点心", price: 260, desc: "城里最好的铺子做的，甜而不腻。", lv: 6 },
];

export default function ShopScreen() {
  return (
    <Page title="协会商店" subtitle="只有仪式感的消耗 · 买不到捷径">
      <Text style={styles.gold}>金币 0</Text>
      {ITEMS.map((it) => {
        const locked = it.lv > 1;
        return (
          <Card key={it.name}>
            <View style={styles.row}>
              <View style={styles.icon}>
                <Text style={styles.iconText}>✦</Text>
              </View>
              <View style={{ flex: 1 }}>
                <View style={styles.titleRow}>
                  <Text style={styles.name}>{it.name}</Text>
                  <Text style={styles.price}>{it.price} 金币</Text>
                </View>
                <Text style={styles.desc}>{it.desc}</Text>
                <Text style={styles.state}>{locked ? `需要 Lv.${it.lv}` : "金币不足"}</Text>
              </View>
            </View>
          </Card>
        );
      })}
      <Text style={styles.hint}>首版只做了展示；购买与库存接商店逻辑后再开放。</Text>
    </Page>
  );
}

const styles = StyleSheet.create({
  gold: {
    fontFamily: Fonts.mono,
    fontSize: 13,
    color: C.gold,
    alignSelf: "flex-end",
  },
  row: { flexDirection: "row", gap: S.md },
  icon: {
    width: 44,
    height: 44,
    borderRadius: R.tile,
    backgroundColor: C.surface2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.border,
    alignItems: "center",
    justifyContent: "center",
  },
  iconText: { color: C.gold, fontSize: 18 },
  titleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: S.sm,
  },
  name: {
    fontFamily: Fonts.display,
    fontSize: 16,
    color: C.fg,
  },
  price: {
    fontFamily: Fonts.mono,
    fontSize: 12,
    color: C.gold,
  },
  desc: {
    fontFamily: Fonts.body,
    fontSize: 12,
    lineHeight: 18,
    color: C.muted,
    marginTop: 2,
  },
  state: {
    fontFamily: Fonts.body,
    fontSize: 11,
    color: C.faint,
    marginTop: S.sm,
  },
  hint: {
    fontFamily: Fonts.body,
    fontSize: 11,
    color: C.faint,
    lineHeight: 16,
  },
});
