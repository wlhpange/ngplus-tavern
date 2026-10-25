import { useCallback, useEffect, useState } from "react";
import { useRouter } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { C, Fonts, S } from "@/constants/theme";
import { ATTR_LABEL } from "@/weblib/labels";
import { Button, Card, Empty, ErrorBar, Input, Loading, Screen, haptic } from "@/components/ui";
import { ConfirmDialog } from "@/components/Dialogs";
import { useToast } from "@/components/Toast";
import { questArchive, repeatQuest } from "@/lib/service";

interface Quest {
  id: string;
  title: string;
  description: string | null;
  type: string;
  primaryAttr: string;
  primaryWeight: number;
  secondaryAttr: string | null;
  secondaryWeight: number | null;
  difficulty: number;
  status: string;
  completedAt: number | null;
}
const TYPE_LABEL: Record<string, string> = { daily: "日常", weekly: "每周", once: "一次性", mainline: "主线", mainline_milestone: "里程碑" };
const PAGE = 50;

function monthLabel(ts: number) { const d = new Date(ts); return `${d.getFullYear()}年${d.getMonth() + 1}月`; }
function monthKey(ts: number) { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth()}`; }
function formatDate(ts: number) { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()}`; }

export default function ArchiveScreen() {
  const router = useRouter();
  const toast = useToast();
  const [quests, setQuests] = useState<Quest[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [confirming, setConfirming] = useState<Quest | null>(null);
  const [repeating, setRepeating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback((opts: { reset: boolean; before?: number | null; q: string }) => {
    if (opts.reset) {
      setQuests(null);
      setError(null);
    }
    try {
      const d = questArchive({ before: opts.before ?? null, q: opts.q, limit: PAGE });
      setQuests((prev) => (opts.reset ? (d.quests as Quest[]) : [...(prev ?? []), ...(d.quests as Quest[])]));
      setHasMore(d.hasMore);
      setNextBefore(d.nextBefore);
    } catch (e) {
      if (opts.reset) setQuests([]);
      setError(e instanceof Error ? e.message : "档案没能取出来。");
    }
  }, []);

  useEffect(() => {
    load({ reset: true, q: query });
  }, [load, query]);

  function loadMore() {
    if (!hasMore || nextBefore == null || loadingMore) return;
    setLoadingMore(true);
    load({ reset: false, before: nextBefore, q: query });
    setLoadingMore(false);
  }

  function repeat(q: Quest) {
    if (repeating) return;
    setRepeating(q.id);
    try {
      repeatQuest(q.id);
      setConfirming(null);
      setMessage(`「${q.title}」重新挂上了，直接进行中。`);
      toast("已重挂到告示板", "ok");
      haptic("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "重挂没能办成。");
    } finally {
      setRepeating(null);
    }
  }

  const rows: React.ReactNode[] = [];
  let lastMonth = "";
  for (const q of quests ?? []) {
    const ts = q.completedAt ?? 0;
    const mk = monthKey(ts);
    if (mk !== lastMonth) {
      rows.push(<Text key={`m_${mk}`} style={styles.month}>{monthLabel(ts)}</Text>);
      lastMonth = mk;
    }
    rows.push(
      <Card key={q.id}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: S.sm }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.title} numberOfLines={2}>{q.title}</Text>
            <Text style={styles.meta}>{TYPE_LABEL[q.type] ?? q.type} · 完成于 {formatDate(ts)} · 难度 {q.difficulty.toFixed(1)}</Text>
          </View>
          {q.type !== "mainline" && q.type !== "mainline_milestone" ? (
            <Button variant="outline" small onPress={() => setConfirming(q)} loading={repeating === q.id}>再来一次</Button>
          ) : null}
        </View>
        <Text style={styles.attr}>
          {ATTR_LABEL[q.primaryAttr] ?? q.primaryAttr} ×{q.primaryWeight.toFixed(1)}
          {q.secondaryAttr ? ` ｜ ${ATTR_LABEL[q.secondaryAttr] ?? q.secondaryAttr} ×${(q.secondaryWeight ?? 0).toFixed(1)}` : ""}
        </Text>
      </Card>,
    );
  }

  return (
    <Screen title="委托档案室" subtitle="更早的完成记录都在这里，按月归档" back onBack={() => router.push("/quests")}>
      <Input value={search} onChangeText={setSearch} placeholder="搜委托标题……" />
      {message ? <Text style={styles.ok}>{message}</Text> : null}
      {error ? <ErrorBar text={error} /> : null}
      {quests === null ? <Loading text="正在翻档案室……" /> : null}
      {rows}
      {quests !== null && quests.length === 0 ? <Empty text={query ? "没找到这个标题的委托。" : "档案室还空着。"} /> : null}
      {quests !== null && hasMore ? <Button variant="outline" small onPress={loadMore} loading={loadingMore}>加载更早</Button> : null}
      {quests !== null && !hasMore && quests.length > 0 ? <Text style={styles.end}>到这里就是最早的记录了</Text> : null}
      <ConfirmDialog
        visible={!!confirming}
        title={`再来一次「${confirming?.title ?? ""}」？`}
        description="按同样的属性与难度重挂一件，确认后直接进入「进行中」，不用再去对话里接受。"
        confirmLabel="挂上"
        busy={!!repeating}
        onConfirm={() => confirming && repeat(confirming)}
        onCancel={() => setConfirming(null)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  month: { fontFamily: Fonts.display, fontSize: 17, color: C.gold, marginTop: S.sm },
  title: { fontFamily: Fonts.display, fontSize: 15, color: C.fg },
  meta: { fontFamily: Fonts.mono, fontSize: 9, color: C.muted },
  attr: { fontFamily: Fonts.mono, fontSize: 10, color: C.faint },
  ok: { fontFamily: Fonts.body, fontSize: 11, color: C.gold },
  end: { fontFamily: Fonts.body, fontSize: 10, color: C.faint, textAlign: "center" },
});
