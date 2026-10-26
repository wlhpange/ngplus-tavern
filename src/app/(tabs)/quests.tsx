import { useCallback, useState } from "react";
import { useFocusEffect, useRouter } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { C, Fonts, R, S } from "@/constants/theme";
import { ATTR_LABEL } from "@/weblib/labels";
import { Button, Card, Chip, Empty, ErrorBar, Loading, Screen, haptic } from "@/components/ui";
import { ConfirmDialog } from "@/components/Dialogs";
import { useToast } from "@/components/Toast";
import { playCue } from "@/lib/audio";
import { questBoard, repeatQuest, sendChat } from "@/lib/service";

interface Quest {
  id: string;
  checkin?: number;
  title: string;
  description: string | null;
  type: "daily" | "once" | "weekly" | "mainline" | "mainline_milestone";
  primaryAttr: string;
  primaryWeight: number;
  secondaryAttr: string | null;
  secondaryWeight: number | null;
  attrReason: string | null;
  difficulty: number;
  status: string;
  streak: number;
  parentQuestId?: string | null;
  deadline: number | null;
  createdAt: number;
  completedAt: number | null;
}
type Mainline = Quest & { milestones: Quest[] };

const TYPE_LABEL: Record<string, string> = { daily: "日常", weekly: "每周", once: "一次性", mainline: "主线", mainline_milestone: "里程碑" };
const GROUPS = [
  { status: "proposed", label: "待接受", hint: "会长的提议，去对话里确认", color: C.muted },
  { status: "active", label: "进行中", hint: "", color: C.accent },
  { status: "overdue", label: "已逾期", hint: "连击衰减中", color: C.dangerText },
  { status: "completed", label: "已完成", hint: "", color: C.gold },
];

function formatDate(ts: number) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function Stars({ difficulty }: { difficulty: number }) {
  return (
    <View style={{ flexDirection: "row", gap: 1 }}>
      {[0, 1, 2].map((i) => {
        const filled = difficulty >= i + 1;
        const half = !filled && difficulty >= i + 0.5;
        return (
          <Text key={i} style={{ color: filled ? C.gold : half ? C.gold : C.faint, opacity: half ? 0.55 : 1, fontSize: 11 }}>
            ★
          </Text>
        );
      })}
    </View>
  );
}

function QuestCard({ q, onRepeat, onDispute, onGo, repeating }: { q: Quest; onRepeat: () => void; onDispute: () => void; onGo: () => void; repeating: boolean }) {
  const done = q.status === "completed";
  const typeTone = q.type === "mainline" ? "gold" : q.type === "daily" ? "accent" : "default";
  return (
    <Card>
      {done ? (
        <View style={styles.seal}>
          <Text style={styles.sealText}>契</Text>
        </View>
      ) : null}
      <View style={{ paddingRight: done ? 40 : 0, gap: 3 }}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: S.sm }}>
          <Text style={styles.questTitle}>{q.title}</Text>
          <View style={[styles.typeBadge, q.checkin ? { borderColor: C.goldLine, backgroundColor: C.goldSoft } : null]}>
            <Text style={[styles.typeText, q.checkin ? { color: C.gold } : q.type === "mainline" ? { color: C.gold } : q.type === "daily" ? { color: C.accent } : { color: C.muted }]}>
              {q.checkin ? "签到" : TYPE_LABEL[q.type] ?? q.type}
            </Text>
          </View>
        </View>
        {q.description ? <Text style={styles.questDesc}>{q.description}</Text> : null}
      </View>
      <View style={styles.metaRow}>
        <Text style={styles.metaStrong}>
          {ATTR_LABEL[q.primaryAttr] ?? q.primaryAttr} ×{q.primaryWeight.toFixed(1)}
        </Text>
        {q.secondaryAttr ? (
          <Text style={styles.meta}>
            ｜ {ATTR_LABEL[q.secondaryAttr] ?? q.secondaryAttr} ×{(q.secondaryWeight ?? 0).toFixed(1)}
          </Text>
        ) : null}
        <Stars difficulty={q.difficulty} />
        <Text style={styles.meta}>{q.difficulty.toFixed(1)}</Text>
        {q.type === "daily" && q.streak > 0 ? (
          <Text style={{ fontFamily: Fonts.mono, fontSize: 10, color: q.streak >= 7 ? C.gold : C.flame }}>连击 ×{q.streak}</Text>
        ) : null}
        {q.deadline ? <Text style={[styles.meta, { marginLeft: "auto" }]}>截止 {formatDate(q.deadline)}</Text> : null}
        {done && q.completedAt ? <Text style={[styles.meta, { marginLeft: "auto" }]}>完成于 {formatDate(q.completedAt)}</Text> : null}
      </View>
      {q.status === "proposed" || q.status === "active" || q.status === "overdue" ? (
        <Button variant={q.status === "active" ? "gold" : "primary"} small onPress={onGo}>
          {q.status === "proposed" ? "去对话里接受 →" : q.status === "active" ? "去汇报战果 →" : "去补上战果 →"}
        </Button>
      ) : null}
      {done ? (
        <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border, paddingTop: S.sm, gap: S.sm }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Button variant="outline" small onPress={onRepeat} loading={repeating}>
              再来一次
            </Button>
            <Text style={styles.hint}>确认后直接进入「进行中」</Text>
          </View>
          {q.attrReason ? <Text style={styles.reason}>属性映射：{q.attrReason}</Text> : null}
          <Pressable onPress={onDispute} style={{ alignSelf: "flex-end" }}>
            <Text style={styles.dispute}>对结算有异议？</Text>
          </Pressable>
        </View>
      ) : null}
    </Card>
  );
}

export default function QuestsScreen() {
  const router = useRouter();
  const toast = useToast();
  const [quests, setQuests] = useState<Quest[] | null>(null);
  const [mainlines, setMainlines] = useState<Mainline[]>([]);
  const [older, setOlder] = useState(0);
  const [showAllCompleted, setShowAllCompleted] = useState(false);
  const [confirming, setConfirming] = useState<Quest | null>(null);
  const [repeating, setRepeating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    try {
      const d = questBoard();
      setQuests(d.quests as Quest[]);
      setMainlines(d.mainlines as Mainline[]);
      setOlder(d.olderCompletedCount);
      setError(null);
    } catch (e) {
      setQuests([]);
      setError(e instanceof Error ? e.message : "告示板没能翻出来。");
    }
  }, []);

  useFocusEffect(useCallback(() => load(), [load]));

  function goChat() {
    router.push("/");
  }

  async function handleRepeat(q: Quest) {
    if (repeating) return;
    setRepeating(q.id);
    setActionMsg(null);
    try {
      repeatQuest(q.id);
      setConfirming(null);
      setActionMsg(`「${q.title}」重新挂上了，直接进行中。`);
      haptic("success");
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "重挂没能办成，稍后再试。");
    } finally {
      setRepeating(null);
    }
  }

  function handleDispute(q: Quest) {
    playCue("dispute");
    haptic("medium");
    toast("已把异议递给会长，正在复核……");
    void sendChat({ message: `我对「${q.title}」的结算有异议：属性归属好像不对，你复核一下。`, mode: "quest" }).catch((e) => {
      toast(e instanceof Error ? e.message : "异议没能递到会长手里。", "err");
    });
    router.push("/");
  }

  const completed = quests?.filter((q) => q.status === "completed") ?? [];

  return (
    <Screen title="委托告示板" subtitle="数据来自协会账本，与结算记录一致">
      {quests === null ? <Loading text="正在翻告示板……" /> : null}
      {quests !== null ? (
        <Text style={styles.stats}>
          本月完成 {completed.length} 件 · 进行中 {quests.filter((q) => q.status === "active").length} 件 · 待接受{" "}
          {quests.filter((q) => q.status === "proposed").length} 件
          {quests.some((q) => q.status === "overdue") ? ` · 逾期 ${quests.filter((q) => q.status === "overdue").length} 件` : ""}
        </Text>
      ) : null}
      {actionMsg ? (
        <View style={styles.okBar}>
          <Text style={styles.okText}>{actionMsg}</Text>
        </View>
      ) : null}
      {error ? <ErrorBar text={error} /> : null}

      {mainlines.length > 0 ? (
        <View style={{ gap: S.sm }}>
          <Text style={styles.groupTitle}>主线</Text>
          {mainlines.map((m) => {
            const done = m.milestones.filter((x) => x.status === "completed").length;
            const total = m.milestones.length;
            return (
              <Card key={m.id} gold>
                <View style={{ flexDirection: "row", alignItems: "flex-start", gap: S.sm }}>
                  <Text style={styles.questTitle}>{m.title}</Text>
                  <View style={styles.typeBadgeGold}>
                    <Text style={styles.typeTextGold}>{m.status === "completed" ? "已达成" : "主线"}</Text>
                  </View>
                </View>
                {m.description ? <Text style={styles.questDesc}>{m.description}</Text> : null}
                <View style={{ flexDirection: "row", alignItems: "center", gap: S.sm }}>
                  <View style={styles.track}>
                    <View style={[styles.fill, { width: `${total > 0 ? Math.round((done / total) * 100) : 0}%` }]} />
                  </View>
                  <Text style={styles.metaGold}>{done}/{total} 里程碑</Text>
                </View>
                {m.milestones.map((q) => (
                  <View key={q.id} style={styles.milestone}>
                    <View style={[styles.dot, { backgroundColor: q.status === "completed" ? C.gold : q.status === "active" ? C.accent : C.faint }]} />
                    <Text style={{ flex: 1, fontFamily: Fonts.body, fontSize: 12, color: C.fg }} numberOfLines={1}>
                      {q.title}
                    </Text>
                    <Stars difficulty={q.difficulty} />
                    {q.status === "completed" ? (
                      <Pressable onPress={() => handleDispute(q)}>
                        <Text style={styles.disputeSmall}>异议</Text>
                      </Pressable>
                    ) : (
                      <Text style={styles.disputeSmall}>{q.status === "active" ? "去汇报 →" : q.status === "proposed" ? "待接受" : q.status === "overdue" ? "去补上 →" : ""}</Text>
                    )}
                  </View>
                ))}
                {m.status === "proposed" ? <Button variant="outline" small onPress={goChat}>去对话里接受主线 →</Button> : null}
              </Card>
            );
          })}
        </View>
      ) : null}

      {quests !== null && GROUPS.map((g) => {
        const all = quests.filter((q) => q.status === g.status);
        if (!all.length) return null;
        const capped = g.status === "completed" && !showAllCompleted;
        const list = capped ? all.slice(0, 8) : all;
        return (
          <View key={g.status} style={{ gap: S.sm }}>
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: S.sm }}>
              <View style={[styles.dot, { backgroundColor: g.color }]} />
              <Text style={[styles.groupTitle, { color: g.color }]}>{g.label}</Text>
              <Text style={styles.groupCount}>{all.length} 件{g.hint ? ` · ${g.hint}` : ""}</Text>
            </View>
            {list.map((q) => (
              <QuestCard
                key={q.id}
                q={q}
                repeating={repeating === q.id}
                onRepeat={() => setConfirming(q)}
                onDispute={() => handleDispute(q)}
                onGo={goChat}
              />
            ))}
            {capped && all.length > list.length ? (
              <Button variant="outline" small onPress={() => setShowAllCompleted(true)}>
                显示全部 {all.length} 件已完成
              </Button>
            ) : null}
            {g.status === "completed" && older > 0 ? (
              <Button variant="outline" small onPress={() => router.push("/archive")}>
                更早的完成记录 · {older} 件 → 档案室
              </Button>
            ) : null}
          </View>
        );
      })}

      {quests !== null && quests.length === 0 && mainlines.length === 0 ? <Empty text="告示板还空着。去和会长聊聊，挂第一件委托吧。" /> : null}

      <ConfirmDialog
        visible={!!confirming}
        title={`再来一次「${confirming?.title ?? ""}」？`}
        description="按同样的属性与难度重挂一件，确认后直接进入「进行中」，不用再去对话里接受。"
        confirmLabel="挂上"
        busy={!!repeating}
        onConfirm={() => confirming && void handleRepeat(confirming)}
        onCancel={() => setConfirming(null)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  stats: { fontFamily: Fonts.mono, fontSize: 10, color: C.faint },
  okBar: { borderRadius: R.tile, borderWidth: 1, borderColor: C.goldLine, backgroundColor: C.goldSoft, paddingHorizontal: S.md, paddingVertical: 8 },
  okText: { fontFamily: Fonts.body, fontSize: 12, color: C.gold },
  groupTitle: { fontFamily: Fonts.display, fontSize: 17, color: C.gold },
  groupCount: { fontFamily: Fonts.mono, fontSize: 10, color: C.faint },
  questTitle: { flex: 1, fontFamily: Fonts.display, fontSize: 16, color: C.fg, lineHeight: 22 },
  questDesc: { fontFamily: Fonts.body, fontSize: 12, color: C.muted, lineHeight: 18 },
  typeBadge: { borderWidth: 1, borderColor: C.borderStrong, borderRadius: 99, paddingHorizontal: 7, paddingVertical: 1, marginTop: 2 },
  typeBadgeGold: { borderWidth: 1, borderColor: C.goldLine, backgroundColor: C.goldSoft, borderRadius: 99, paddingHorizontal: 7, paddingVertical: 1 },
  typeText: { fontFamily: Fonts.mono, fontSize: 9, letterSpacing: 1 },
  typeTextGold: { fontFamily: Fonts.mono, fontSize: 9, letterSpacing: 1, color: C.gold },
  metaRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 2 },
  metaStrong: { fontFamily: Fonts.mono, fontSize: 10, color: C.fg },
  meta: { fontFamily: Fonts.mono, fontSize: 10, color: C.muted },
  metaGold: { fontFamily: Fonts.mono, fontSize: 10, color: C.gold },
  seal: {
    position: "absolute",
    right: 12,
    top: 12,
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: C.danger,
    borderWidth: 1,
    borderColor: C.goldLine,
    alignItems: "center",
    justifyContent: "center",
    transform: [{ rotate: "-8deg" }],
    zIndex: 2,
  },
  sealText: { fontFamily: Fonts.display, fontSize: 13, color: C.gold },
  hint: { fontFamily: Fonts.body, fontSize: 9, color: C.faint },
  reason: { fontFamily: Fonts.body, fontSize: 10, color: C.faint, lineHeight: 16 },
  dispute: { fontFamily: Fonts.body, fontSize: 10, color: C.muted },
  disputeSmall: { fontFamily: Fonts.body, fontSize: 9, color: C.muted },
  track: { flex: 1, height: 5, borderRadius: 3, backgroundColor: C.surface3, overflow: "hidden" },
  fill: { height: "100%", backgroundColor: C.gold },
  milestone: { flexDirection: "row", alignItems: "center", gap: S.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border, paddingVertical: 5 },
  dot: { width: 6, height: 6, borderRadius: 3 },
});
