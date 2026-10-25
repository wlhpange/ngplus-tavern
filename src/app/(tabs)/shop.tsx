import { useCallback, useState } from "react";
import { useFocusEffect } from "expo-router";
import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { C, Fonts, R, S } from "@/constants/theme";
import { Button, Card, ErrorBar, Loading, Screen, haptic } from "@/components/ui";
import { useToast } from "@/components/Toast";
import { shopBuy, shopData, shopGift } from "@/lib/service";

interface ShopItem {
  key: string;
  name: string;
  type: "consumable" | "gift";
  price: number;
  desc: string;
  count: number;
  unlocked: boolean;
  unlockHint: string | null;
  discount: { ratio: number; priceAfter: number } | null;
}
interface ShopState {
  gold: number;
  intimacy: { stage: number; label: string; points: number } | null;
  items: ShopItem[];
}

const SECTIONS = [
  { type: "consumable" as const, label: "道具", hint: "买了就进你的抽屉，到点自动生效" },
  { type: "gift" as const, label: "给会长的礼物", hint: "送出去就是你们的共同回忆" },
];

export default function ShopScreen() {
  const toast = useToast();
  const [data, setData] = useState<ShopState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    try {
      setData(shopData() as ShopState);
      setError(null);
    } catch (e) {
      setData({ gold: 0, intimacy: null, items: [] });
      setError(e instanceof Error ? e.message : "商店没能翻出来。");
    }
  }, []);

  useFocusEffect(useCallback(() => load(), [load]));

  async function post(item: ShopItem, action: "buy" | "gift") {
    setBusy(item.key + (action === "gift" ? ":gift" : ""));
    setError(null);
    try {
      const receipt = action === "gift" ? shopGift(item.key) : shopBuy(item.key);
      if (action === "gift") {
        const r = receipt as { name?: string; stageUp?: boolean; intimacyLabel?: string };
        toast(r.stageUp ? `他收下了「${r.name}」。你们的交情到了「${r.intimacyLabel}」` : "他收下了", "ok");
      } else {
        toast("记上了，货已入袋", "ok");
      }
      haptic("success");
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "协会那边没办成，请稍后再试。");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Screen title="协会商店" subtitle="只有仪式感的消耗，没有数值的捷径——买不到经验，也买不到通融">
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
        <Text style={styles.goldLabel}>金币</Text>
        <Text style={styles.gold}>{data?.gold ?? "…"}</Text>
      </View>
      {data?.intimacy ? <Text style={styles.intimacy}>交情：{data.intimacy.label}</Text> : null}
      {data === null ? <Loading text="正在翻商品架子……" /> : null}
      {error ? <ErrorBar text={error} /> : null}

      {data
        ? SECTIONS.map((section) => {
            const list = data.items.filter((i) => i.type === section.type);
            if (!list.length) return null;
            return (
              <View key={section.type} style={{ gap: S.sm }}>
                <Text style={styles.section}>{section.label}</Text>
                <Text style={styles.hint}>{section.hint}</Text>
                {list.map((item) => {
                  const locked = !item.unlocked;
                  const owned = item.count > 0;
                  const effPrice = item.discount ? item.discount.priceAfter : item.price;
                  const afford = !locked && data.gold >= effPrice;
                  const isGift = item.type === "gift";
                  const buyLabel = locked ? item.unlockHint ?? "未解锁" : !afford ? "金币不够" : owned ? (isGift ? "买一份" : "再买一份") : "买下";
                  return (
                    <Card key={item.key} style={locked ? { opacity: 0.6 } : undefined}>
                      <View style={{ flexDirection: "row", gap: S.md }}>
                        <View style={styles.art}>
                          <Ionicons name={isGift ? "gift-outline" : "book-outline"} size={20} color={C.muted} />
                        </View>
                        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                          <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: S.sm }}>
                            <Text style={styles.itemName}>{item.name}</Text>
                            <View style={{ alignItems: "flex-end" }}>
                              <Text style={styles.price}>{effPrice} <Text style={styles.priceUnit}>金币</Text></Text>
                              {item.discount ? <Text style={styles.oldPrice}>{item.price}</Text> : null}
                            </View>
                          </View>
                          <Text style={styles.desc}>
                            {item.desc}
                            {item.discount ? <Text style={{ color: C.gold }}>（旅商过境 · 今日折扣）</Text> : null}
                          </Text>
                          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: S.sm, marginTop: 2 }}>
                            <Text style={styles.stock}>{locked ? "货架未开放" : `持有 ×${item.count}`}</Text>
                            {locked ? (
                              <Text style={styles.locked}>{item.unlockHint ?? "未解锁"}</Text>
                            ) : (
                              <View style={{ flexDirection: "row", gap: S.sm }}>
                                {isGift && owned ? (
                                  <Button variant="gold" small onPress={() => void post(item, "gift")} loading={busy === item.key + ":gift"}>
                                    {item.count >= 2 ? "送他一份" : "送给他"}
                                  </Button>
                                ) : null}
                                <Button variant="outline" small onPress={() => void post(item, "buy")} disabled={!afford || !!busy} loading={busy === item.key}>
                                  {buyLabel}
                                </Button>
                              </View>
                            )}
                          </View>
                        </View>
                      </View>
                    </Card>
                  );
                })}
              </View>
            );
          })
        : null}
      <Text style={styles.hint}>休整卷轴在断签当晚自动生效；礼物只推进交情，不卖数值。</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  goldLabel: { fontFamily: Fonts.body, fontSize: 12, color: C.muted },
  gold: { fontFamily: Fonts.mono, fontSize: 22, color: C.gold, fontWeight: "700" },
  intimacy: { fontFamily: Fonts.mono, fontSize: 10, color: C.faint },
  section: { fontFamily: Fonts.display, fontSize: 18, color: C.fg },
  hint: { fontFamily: Fonts.body, fontSize: 10, color: C.faint, lineHeight: 16 },
  art: {
    width: 44,
    height: 44,
    borderRadius: R.tile,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: "center",
    justifyContent: "center",
  },
  itemName: { flex: 1, fontFamily: Fonts.display, fontSize: 16, color: C.fg },
  price: { fontFamily: Fonts.mono, fontSize: 13, color: C.gold, fontWeight: "600" },
  priceUnit: { fontSize: 9, fontWeight: "400" },
  oldPrice: { fontFamily: Fonts.mono, fontSize: 9, color: C.faint, textDecorationLine: "line-through" },
  desc: { fontFamily: Fonts.body, fontSize: 11, color: C.muted, lineHeight: 17 },
  stock: { fontFamily: Fonts.mono, fontSize: 9, color: C.faint },
  locked: { fontFamily: Fonts.body, fontSize: 10, color: C.faint, borderWidth: 1, borderColor: C.border, borderRadius: 9, paddingHorizontal: 9, paddingVertical: 3 },
});
