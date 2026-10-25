import { useCallback, useState } from "react";
import { useFocusEffect, useRouter } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import * as Sharing from "expo-sharing";
import { File, Paths } from "expo-file-system";

import { A, C, Fonts, R, S } from "@/constants/theme";
import { ATTR_LABEL, ATTR_ORDER, KIND_LABEL, itemDisplay } from "@/weblib/labels";
import { RadarChart } from "@/components/RadarChart";
import { Button, Card, ErrorBar, Loading, ProgressBar, Screen, haptic } from "@/components/ui";
import { bill, characterPanel, exportBills } from "@/lib/service";
import { useToast } from "@/components/Toast";

interface AttrSummary {
  xp: number;
  level: number;
  xpToNext: number;
}
interface SettlementRecord {
  id: string;
  kind: string;
  questTitle: string | null;
  completionRatio: number | null;
  xpAwarded: number;
  goldAwarded: number;
  attrSplit: Record<string, number>;
  adjustments: Record<string, unknown> | null;
  createdAt: number;
}
interface CharacterData {
  totalXp: number;
  totalLevel: number;
  xpToNextLevel: number;
  nextLevelXpRequired: number;
  rank: string;
  rankBadge: { current: string; next: { rank: string; levelsNeeded: number } | null };
  ranks: { rank: string; minLevel: number }[];
  gold: number;
  attrs: Record<string, AttrSummary>;
  titles: string[];
  monthSummary: { xp: number; gold: number; count: number };
  skillSummary: { owned: number; total: number };
  achievements: { key: string; name: string; desc: string; owned: boolean }[];
  achievementSummary: { owned: number; total: number };
  weeklyBoss: { week: string; name: string; desc: string; progress: number; target: number; claimed: boolean; reward: { gold: number; item: string; item_count: number } };
}

const BILL_FILTERS = [
  { key: "all", label: "全部" },
  { key: "quest_complete,mainline_complete", label: "委托" },
  { key: "review_adjustment", label: "复核" },
  { key: "purchase", label: "购买" },
  { key: "gift", label: "赠送" },
  { key: "skill_purchase", label: "技能" },
  { key: "title_grant", label: "称号" },
];
const TITLE_LABEL: Record<string, string> = { streak_7: "七日不熄", first_gold: "第一桶金" };

function titleDisplay(key: string): string {
  if (TITLE_LABEL[key]) return TITLE_LABEL[key];
  if (key.startsWith("rank_")) return `突破徽记 · ${key.slice(5).toUpperCase()}`;
  const m = key.match(/^attr_([a-z]+)_(\d+)$/);
  if (m) return `${ATTR_LABEL[m[1]] ?? m[1]} Lv${m[2]}`;
  return key.replaceAll("_", " ");
}
function titleSeal(key: string, label: string) {
  if (key.startsWith("rank_")) return key.slice(5).toUpperCase();
  return label.slice(0, 1);
}
function formatTime(ts: number) {
  const d = new Date(ts);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function RankSeal({ rank }: { rank: string }) {
  return (
    <View style={styles.rankSeal}>
      <Text style={styles.rankSealText}>{rank}</Text>
    </View>
  );
}

export default function CharacterScreen() {
  const router = useRouter();
  const toast = useToast();
  const [data, setData] = useState<CharacterData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [billRows, setBillRows] = useState<SettlementRecord[] | null>(null);
  const [billHasMore, setBillHasMore] = useState(false);
  const [billNext, setBillNext] = useState<number | null>(null);
  const [billKind, setBillKind] = useState("all");
  const [billLoading, setBillLoading] = useState(false);

  const loadBill = useCallback(async (opts: { reset: boolean; before?: number | null; kind: string }) => {
    try {
      const d = bill({
        limit: 30,
        before: opts.before ?? null,
        kinds: opts.kind === "all" ? undefined : opts.kind.split(","),
      });
      setBillRows((prev) => (opts.reset ? d.settlements : [...(prev ?? []), ...d.settlements]));
      setBillHasMore(d.hasMore);
      setBillNext(d.nextBefore);
    } catch (e) {
      if (opts.reset) setBillRows([]);
      setError(e instanceof Error ? e.message : "账本没能取出来。");
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      try {
        setData(characterPanel() as CharacterData);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "档案没能取出来。");
      }
      setBillRows(null);
      void loadBill({ reset: true, kind: billKind });
    }, [billKind, loadBill]),
  );

  function changeFilter(kind: string) {
    setBillKind(kind);
    setBillRows(null);
    haptic("select");
  }

  function loadMoreBill() {
    if (!billHasMore || billNext == null || billLoading) return;
    setBillLoading(true);
    void loadBill({ reset: false, before: billNext, kind: billKind }).finally(() => setBillLoading(false));
  }

  async function exportBill(format: "csv" | "md") {
    try {
      const text = exportBills(format);
      const name = `ngplus-settlements-${new Date().toISOString().slice(0, 10)}.${format}`;
      const file = new File(Paths.cache, name);
      file.writeSync(text);
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(file.uri, { mimeType: format === "csv" ? "text/csv" : "text/markdown", dialogTitle: "导出月账单" });
      } else {
        toast(`已保存到 ${file.uri}`);
      }
      haptic("success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "导出失败", "err");
    }
  }

  if (!data) {
    return (
      <Screen title="角色面板" subtitle="协会卷宗室 · 与结算记录同源">
        {error ? <ErrorBar text={error} /> : <Loading text="正在翻你的冒险者档案……" />}
      </Screen>
    );
  }

  const levelProgress = 1 - data.xpToNextLevel / Math.max(1, data.nextLevelXpRequired);
  const rankIdx = data.ranks.findIndex((r) => r.rank === data.rankBadge.current);
  const rankTitles = data.titles.filter((t) => !t.startsWith("ach_"));

  return (
    <Screen title="角色面板" subtitle="协会卷宗室 · 与结算记录同源" dust>
      <Card>
        <Text style={styles.kicker}>冒险者档案</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: S.lg, marginTop: S.sm }}>
          <RankSeal rank={data.rankBadge.current} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: S.sm }}>
              <Text style={styles.level}>Lv.{data.totalLevel}</Text>
              <Text style={styles.metaSmall}>距下一级 {data.xpToNextLevel} XP</Text>
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: S.sm, marginTop: S.sm }}>
              <ProgressBar ratio={levelProgress} />
              <Text style={styles.metaSmall}>{Math.round(levelProgress * 100)}%</Text>
            </View>
            <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: S.sm }}>
              <Text style={styles.meta}>金币</Text>
              <Text style={styles.gold}>{data.gold}</Text>
            </View>
          </View>
        </View>
        <View style={{ flexDirection: "row", gap: 5, marginTop: S.md }}>
          {data.ranks.map((r, i) => {
            const active = r.rank === data.rankBadge.current;
            const passed = !active && rankIdx >= 0 && i < rankIdx;
            return (
              <View key={r.rank} style={[styles.rankChip, active ? styles.rankChipActive : passed ? styles.rankChipPassed : null]}>
                <Text style={[styles.rankChipText, active ? { color: C.onGold } : passed ? { color: C.gold } : { color: C.faint }]}>{r.rank}</Text>
              </View>
            );
          })}
        </View>
        <Text style={styles.metaSmall}>
          {data.rankBadge.next ? `下一次突破：${data.rankBadge.current} → ${data.rankBadge.next.rank}（还需 ${data.rankBadge.next.levelsNeeded} 级）` : "已达最高评级 S · 突破圆满"}
        </Text>
        <View style={{ flexDirection: "row", justifyContent: "flex-end", borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border, paddingTop: S.sm }}>
          <Button variant="gold" small onPress={() => router.push("/shop")}>协会商店 →</Button>
        </View>
      </Card>

      <Card>
        <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" }}>
          <Text style={styles.cardTitle}>本周悬赏</Text>
          <Text style={[styles.metaMono, { color: data.weeklyBoss.claimed ? C.gold : C.faint }]}>
            {data.weeklyBoss.claimed ? "已达成" : `${data.weeklyBoss.progress}/${data.weeklyBoss.target}`}
          </Text>
        </View>
        <Text style={styles.bossName}>{data.weeklyBoss.name}</Text>
        <Text style={styles.meta}>{data.weeklyBoss.desc}</Text>
        <ProgressBar ratio={data.weeklyBoss.progress / Math.max(1, data.weeklyBoss.target)} color={C.gold} />
        <Text style={styles.hint}>奖励：{data.weeklyBoss.reward.gold} 金币 + 道具 ×{data.weeklyBoss.reward.item_count}（达标自动入袋）</Text>
      </Card>

      <Card>
        <Text style={styles.cardTitle}>属性星图</Text>
        <View style={{ alignItems: "center" }}>
          <RadarChart centerLabel={`Lv.${data.totalLevel}`} values={ATTR_ORDER.map((k) => ({ key: k, level: data.attrs[k]?.level ?? 1 }))} size={250} />
        </View>
        <View style={{ gap: 7 }}>
          {ATTR_ORDER.map((k) => {
            const a = data.attrs[k];
            if (!a) return null;
            const required = a.level * 100 + 50;
            return (
              <View key={k} style={{ flexDirection: "row", alignItems: "center", gap: S.sm }}>
                <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: A[k] }} />
                <Text style={styles.attrName}>{ATTR_LABEL[k]}</Text>
                <Text style={styles.attrLevel}>Lv.{a.level}</Text>
                <ProgressBar ratio={1 - a.xpToNext / required} color={A[k]} />
                <Text style={styles.attrGap}>差 {a.xpToNext}</Text>
              </View>
            );
          })}
        </View>
      </Card>

      <Card>
        <Text style={styles.cardTitle}>称号</Text>
        {rankTitles.length === 0 ? (
          <Text style={styles.meta}>还没有称号。完成委托、保持连击，协会会为你授勋。</Text>
        ) : (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: S.sm }}>
            {data.titles.map((t) => {
              const label = titleDisplay(t);
              return (
                <View key={t} style={styles.titleSeal}>
                  <View style={styles.titleCircle}>
                    <Text style={styles.titleCircleText}>{titleSeal(t, label)}</Text>
                  </View>
                  <Text style={styles.titleName} numberOfLines={1}>{label}</Text>
                </View>
              );
            })}
          </View>
        )}
      </Card>

      <Card>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
          <Text style={styles.cardTitle}>图鉴</Text>
          <Text style={styles.metaMono}>{data.achievementSummary.owned}/{data.achievementSummary.total}</Text>
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: S.sm }}>
          {data.achievements.map((a) => (
            <View key={a.key} style={[styles.ach, a.owned ? styles.achOwned : null]}>
              <Text style={[styles.achName, { color: a.owned ? C.gold : C.muted }]}>
                {a.owned ? "✦ " : ""}
                {a.name}
              </Text>
              <Text style={styles.achDesc}>{a.desc}</Text>
            </View>
          ))}
        </View>
      </Card>

      <Card>
        <Text style={styles.cardTitle}>技能树</Text>
        <Text style={styles.meta}>已点亮 {data.skillSummary.owned}/{data.skillSummary.total} 项——晨型人、连击铁律、签到酬勤……点亮后一直在结算里生效。</Text>
        <View style={{ flexDirection: "row", justifyContent: "flex-end", borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border, paddingTop: S.sm }}>
          <Button variant="gold" small onPress={() => router.push("/skills")}>查看技能树 →</Button>
        </View>
      </Card>

      <Card>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between", gap: S.sm }}>
          <Text style={styles.cardTitle}>月账单</Text>
          <View style={{ flexDirection: "row", gap: S.md }}>
            <Pressable onPress={() => void exportBill("csv")}><Text style={styles.link}>导出 CSV</Text></Pressable>
            <Pressable onPress={() => void exportBill("md")}><Text style={styles.link}>导出 Markdown</Text></Pressable>
          </View>
        </View>
        <Text style={styles.metaMono}>
          本月 +{data.monthSummary.xp} XP · {data.monthSummary.gold >= 0 ? "+" : ""}{data.monthSummary.gold} 金币 · {data.monthSummary.count} 笔
        </Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
          {BILL_FILTERS.map((f) => (
            <Pressable key={f.key} onPress={() => changeFilter(f.key)} style={[styles.filter, billKind === f.key ? styles.filterActive : null]}>
              <Text style={[styles.filterText, { color: billKind === f.key ? C.gold : C.muted }]}>{f.label}</Text>
            </Pressable>
          ))}
        </View>
        {billRows === null ? <Text style={styles.meta}>正在对账……</Text> : null}
        {billRows !== null && billRows.length === 0 ? <Text style={styles.meta}>这个筛选下还没有记录。</Text> : null}
        {billRows?.map((s) => (
          <View key={s.id} style={styles.billRow}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", gap: S.sm }}>
              <Text style={styles.billTitle}>{s.questTitle ?? KIND_LABEL[s.kind] ?? s.kind}</Text>
              <Text style={styles.billTime}>{formatTime(s.createdAt)}</Text>
            </View>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <Text style={styles.billXp}>{s.xpAwarded >= 0 ? `+${s.xpAwarded}` : s.xpAwarded} XP / {s.goldAwarded >= 0 ? `+${s.goldAwarded}` : s.goldAwarded} 金币</Text>
              <Text style={styles.meta}>{KIND_LABEL[s.kind] ?? s.kind}</Text>
              {Object.entries(s.attrSplit).map(([k, v]) => (
                <Text key={k} style={[styles.metaMono, { color: v < 0 ? C.dangerText : C.muted }]}>{ATTR_LABEL[k] ?? k} {v >= 0 ? `+${v}` : v}</Text>
              ))}
            </View>
            {s.kind === "review_adjustment" && typeof s.adjustments?.reason === "string" ? (
              <Text style={styles.billReason}>复核理由：{s.adjustments.reason as string}</Text>
            ) : null}
            {s.kind === "purchase" && typeof s.adjustments?.item_key === "string" ? (
              <Text style={styles.meta}>购入：{itemDisplay(s.adjustments.item_key as string)}</Text>
            ) : null}
            {s.kind === "gift" && typeof s.adjustments?.item_key === "string" ? (
              <Text style={styles.meta}>送出：{itemDisplay(s.adjustments.item_key as string)}{s.adjustments?.stage_up ? "（交情更进一步）" : ""}</Text>
            ) : null}
          </View>
        ))}
        {billHasMore ? (
          <Button variant="outline" small onPress={loadMoreBill} loading={billLoading}>加载更早</Button>
        ) : null}
        {error ? <ErrorBar text={error} /> : null}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  kicker: { fontFamily: Fonts.mono, fontSize: 10, color: C.faint, letterSpacing: 2 },
  rankSeal: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: C.danger,
    borderWidth: 3,
    borderColor: C.goldLine,
    alignItems: "center",
    justifyContent: "center",
    transform: [{ rotate: "-8deg" }],
  },
  rankSealText: { fontFamily: Fonts.display, fontSize: 42, color: C.gold },
  level: { fontFamily: Fonts.display, fontSize: 30, color: C.gold },
  meta: { fontFamily: Fonts.body, fontSize: 11, color: C.muted, lineHeight: 17 },
  metaSmall: { fontFamily: Fonts.mono, fontSize: 10, color: C.muted },
  metaMono: { fontFamily: Fonts.mono, fontSize: 10, color: C.muted },
  gold: { fontFamily: Fonts.mono, fontSize: 16, color: C.gold, fontWeight: "700" },
  rankChip: { flex: 1, height: 30, borderRadius: 8, backgroundColor: C.surface2, alignItems: "center", justifyContent: "center" },
  rankChipActive: { backgroundColor: C.gold },
  rankChipPassed: { borderWidth: 1, borderColor: C.goldLine },
  rankChipText: { fontFamily: Fonts.mono, fontSize: 12, fontWeight: "700" },
  cardTitle: { fontFamily: Fonts.display, fontSize: 18, color: C.gold },
  bossName: { fontFamily: Fonts.body, fontSize: 14, color: C.fg },
  hint: { fontFamily: Fonts.body, fontSize: 10, color: C.faint },
  attrName: { fontFamily: Fonts.body, fontSize: 12, color: C.fg, width: 32 },
  attrLevel: { fontFamily: Fonts.mono, fontSize: 10, color: C.muted, width: 34 },
  attrGap: { fontFamily: Fonts.mono, fontSize: 9, color: C.muted, width: 46, textAlign: "right" },
  titleSeal: { flexDirection: "row", alignItems: "center", gap: S.sm, width: "47%", borderRadius: R.tile, borderWidth: 1, borderColor: C.goldLine, backgroundColor: C.goldSoft, padding: S.sm },
  titleCircle: { width: 30, height: 30, borderRadius: 15, borderWidth: 1, borderColor: C.goldLine, alignItems: "center", justifyContent: "center" },
  titleCircleText: { fontFamily: Fonts.display, fontSize: 12, color: C.gold },
  titleName: { flex: 1, fontFamily: Fonts.display, fontSize: 12, color: C.fg },
  ach: { width: "47%", borderRadius: R.tile, borderWidth: 1, borderColor: C.border, backgroundColor: C.surface2, padding: S.sm },
  achOwned: { borderColor: C.goldLine, backgroundColor: C.goldSoft },
  achName: { fontFamily: Fonts.display, fontSize: 12 },
  achDesc: { fontFamily: Fonts.body, fontSize: 9, color: C.faint, lineHeight: 14, marginTop: 2 },
  link: { fontFamily: Fonts.body, fontSize: 10, color: C.muted },
  filter: { borderWidth: 1, borderColor: C.border, borderRadius: 99, paddingHorizontal: 9, paddingVertical: 2 },
  filterActive: { borderColor: C.goldLine, backgroundColor: C.goldSoft },
  filterText: { fontFamily: Fonts.body, fontSize: 10 },
  billRow: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border, paddingBottom: S.sm, gap: 2 },
  billTitle: { flex: 1, fontFamily: Fonts.body, fontSize: 12, color: C.fg },
  billTime: { fontFamily: Fonts.mono, fontSize: 9, color: C.faint },
  billXp: { fontFamily: Fonts.mono, fontSize: 10, color: C.gold },
  billReason: { fontFamily: Fonts.body, fontSize: 10, color: C.gold },
});
