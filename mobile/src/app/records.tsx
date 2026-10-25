import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { C, Fonts, S } from "@/constants/theme";
import { SettlementCard, type SettlementCardData } from "@/components/SettlementCard";
import { Button, Chip, Empty, ErrorBar, Input, Loading, Screen, haptic } from "@/components/ui";
import { PromptDialog } from "@/components/Dialogs";
import { records } from "@/lib/service";

interface ApiMessage { id: string; role: "user" | "master"; content: string; sender: string; createdAt: number }
type RecordItem = { type: "message"; message: ApiMessage } | { type: "settlement"; settlement: SettlementCardData };
type Kind = "all" | "chat" | "settlement";
const KIND_TABS: { key: Kind; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "chat", label: "对话" },
  { key: "settlement", label: "结算" },
];
const PAGE = 40;

function monthLabel(ts: number) { const d = new Date(ts); return `${d.getFullYear()}年${d.getMonth() + 1}月`; }
function dayLabel(ts: number) {
  const d = new Date(ts);
  const w = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
  return `${d.getMonth() + 1}月${d.getDate()}日 周${w}`;
}
function monthKey(ts: number) { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth()}`; }
function dayKey(ts: number) { const d = new Date(ts); return `${monthKey(ts)}-${d.getDate()}`; }
function itemTime(it: RecordItem) { return it.type === "message" ? it.message.createdAt : it.settlement.createdAt; }
function parseDateStart(v: string): number | null {
  const m = v.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

export default function RecordsScreen() {
  const router = useRouter();
  const [items, setItems] = useState<RecordItem[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [kind, setKind] = useState<Kind>("all");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [dateBefore, setDateBefore] = useState<number | null>(null);
  const [dateLabel, setDateLabel] = useState("");
  const [dateDialog, setDateDialog] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback((opts: { reset: boolean; before?: number | null; q: string; kind: Kind }) => {
    const my = ++seq.current;
    if (opts.reset) {
      setItems(null);
      setError(null);
    }
    try {
      const d = records({ before: opts.before ?? null, limit: PAGE, q: opts.q, kind: opts.kind });
      if (my !== seq.current) return;
      const batch: RecordItem[] = d.items.map((it) =>
        it.type === "message"
          ? { type: "message", message: { id: it.id, role: it.role, content: it.content, sender: it.sender, createdAt: it.createdAt } }
          : { type: "settlement", settlement: it.settlement as SettlementCardData },
      );
      setItems((prev) => (opts.reset ? batch : [...(prev ?? []), ...batch]));
      setHasMore(d.hasMore);
      setNextBefore(d.nextBefore);
    } catch (e) {
      if (my !== seq.current) return;
      if (opts.reset) setItems([]);
      setError(e instanceof Error ? e.message : "记录没能取出来。");
    }
  }, []);

  useEffect(() => {
    load({ reset: true, before: dateBefore, q: query, kind });
  }, [load, query, kind, dateBefore]);

  function loadMore() {
    if (!hasMore || nextBefore == null || loadingMore) return;
    setLoadingMore(true);
    load({ reset: false, before: nextBefore, q: query, kind });
    setLoadingMore(false);
  }

  const rows = useMemo(() => {
    const out: React.ReactNode[] = [];
    let lastMonth = "";
    let lastDay = "";
    for (const it of items ?? []) {
      const ts = itemTime(it);
      const mk = monthKey(ts);
      if (mk !== lastMonth) {
        out.push(<Text key={`m_${mk}`} style={styles.month}>{monthLabel(ts)}</Text>);
        lastMonth = mk;
        lastDay = "";
      }
      const dk = dayKey(ts);
      if (dk !== lastDay) {
        out.push(
          <View key={`d_${dk}`} style={styles.dayRow}>
            <View style={styles.line} />
            <Text style={styles.day}>{dayLabel(ts)}</Text>
            <View style={styles.line} />
          </View>,
        );
        lastDay = dk;
      }
      if (it.type === "settlement") {
        out.push(<SettlementCard key={`s_${it.settlement.id}`} s={it.settlement} />);
        continue;
      }
      const m = it.message;
      out.push(
        <View key={m.id} style={{ flexDirection: m.role === "user" ? "row-reverse" : "row", alignItems: "flex-start", gap: 6 }}>
          {m.role === "master" ? (
            <View style={styles.senderDot}><Text style={styles.senderInitial}>{(m.sender || "会").slice(0, 1)}</Text></View>
          ) : null}
          <View style={{ maxWidth: "82%" }}>
            {m.role === "master" ? <Text style={styles.sender}>{m.sender || "会长"}</Text> : null}
            <View style={m.role === "user" ? styles.userBubble : styles.masterBubble}>
              <Text style={styles.msgText}>{m.content}</Text>
            </View>
          </View>
        </View>,
      );
    }
    return out;
  }, [items]);

  return (
    <Screen title="聊天记录" subtitle="三天之前的对话都在这里，按月归档" back onBack={() => router.push("/")}>
      <Input
        value={search}
        onChangeText={setSearch}
        placeholder="输入即搜：委托名、会长说过的话……"
      />
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        {KIND_TABS.map((t) => <Chip key={t.key} label={t.label} active={kind === t.key} onPress={() => setKind(t.key)} tone="gold" />)}
        <Pressable onPress={() => setDateDialog(true)} style={styles.dateBtn}>
          <Text style={styles.meta}>跳到 {dateLabel || "某天"}</Text>
        </Pressable>
        {dateBefore != null ? (
          <Pressable onPress={() => { setDateBefore(null); setDateLabel(""); }}>
            <Text style={[styles.meta, { color: C.accent }]}>回最新</Text>
          </Pressable>
        ) : null}
        {query ? (
          <Pressable onPress={() => { setSearch(""); setQuery(""); }}>
            <Text style={styles.meta}>清除搜索：{query}</Text>
          </Pressable>
        ) : null}
      </View>
      {error ? <ErrorBar text={error} /> : null}
      {items === null ? <Loading text="正在翻档案室……" /> : null}
      {rows}
      {items !== null && items.length === 0 ? (
        <Empty text={query || kind !== "all" || dateBefore != null ? "没有找到匹配的记录。换个关键词或筛选试试。" : "档案室还是空的。"} />
      ) : null}
      {items !== null && hasMore ? (
        <Button variant="outline" small onPress={loadMore} loading={loadingMore}>加载更早</Button>
      ) : null}
      {items !== null && !hasMore && items.length > 0 ? <Text style={styles.end}>到这里就是协会最早的记录了</Text> : null}

      <PromptDialog
        visible={dateDialog}
        title="跳到某一天"
        label="日期（YYYY-MM-DD）"
        initialValue={dateLabel}
        placeholder="2026-10-25"
        confirmLabel="跳转"
        onSubmit={(v) => {
          const ts = parseDateStart(v);
          if (ts == null) {
            haptic("error");
            return;
          }
          setDateDialog(false);
          setDateLabel(v.trim());
          setDateBefore(ts);
          haptic("select");
        }}
        onCancel={() => setDateDialog(false)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  month: { fontFamily: Fonts.display, fontSize: 17, color: C.gold, marginTop: S.sm },
  dayRow: { flexDirection: "row", alignItems: "center", gap: S.sm, paddingVertical: 2 },
  line: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: C.border },
  day: { fontFamily: Fonts.mono, fontSize: 9, color: C.faint, letterSpacing: 1.5 },
  senderDot: { width: 24, height: 24, borderRadius: 12, backgroundColor: C.surface3, alignItems: "center", justifyContent: "center", marginTop: 2 },
  senderInitial: { fontFamily: Fonts.display, fontSize: 10, color: C.muted },
  sender: { fontFamily: Fonts.mono, fontSize: 9, color: C.muted, letterSpacing: 1, marginBottom: 2 },
  userBubble: { borderRadius: 16, borderBottomRightRadius: 5, borderWidth: 1, borderColor: C.accentLine, backgroundColor: C.accentSoft, paddingHorizontal: 13, paddingVertical: 8 },
  masterBubble: { borderRadius: 16, borderTopLeftRadius: 5, borderWidth: StyleSheet.hairlineWidth, borderColor: C.border, backgroundColor: C.surface, paddingHorizontal: 13, paddingVertical: 8 },
  msgText: { fontFamily: Fonts.body, fontSize: 12, lineHeight: 19, color: C.fg },
  meta: { fontFamily: Fonts.mono, fontSize: 10, color: C.muted },
  dateBtn: { borderWidth: 1, borderColor: C.border, borderRadius: 99, paddingHorizontal: 9, paddingVertical: 3 },
  end: { fontFamily: Fonts.body, fontSize: 10, color: C.faint, textAlign: "center" },
});
