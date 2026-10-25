import { useCallback, useEffect, useState } from "react";
import { useFocusEffect, useRouter } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { C, Fonts, R, S } from "@/constants/theme";
import { Button, Card, Chip, Empty, ErrorBar, Input, Loading, Screen, haptic } from "@/components/ui";
import { ConfirmDialog } from "@/components/Dialogs";
import { useToast } from "@/components/Toast";
import { mastersData, memoryAction, memoryData } from "@/lib/service";

interface MemoryItem { id: string; masterId: string | null; sessionId: string | null; category: string; content: string; enabled: boolean; createdAt: number }
interface Category { id: string; label: string }
interface Session { id: string; title: string; messageCount: number }

export default function MemoryScreen() {
  const router = useRouter();
  const toast = useToast();
  const [masters, setMasters] = useState<{ id: string; name: string }[]>([]);
  const [masterId, setMasterId] = useState("");
  const [scope, setScope] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [items, setItems] = useState<MemoryItem[] | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [newCategory, setNewCategory] = useState("story");
  const [newContent, setNewContent] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmBatch, setConfirmBatch] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    try {
      const ms = mastersData();
      setMasters(ms.masters.map((m) => ({ id: m.id, name: m.name })));
      setMasterId(ms.activeMasterId ?? ms.masters[0]?.id ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "会长列表没能取出来。");
    }
  }, []);

  const load = useCallback((mid: string, sid: string) => {
    if (!mid) return;
    setError(null);
    try {
      const d = memoryData(mid, sid || null);
      setItems(d.memories as MemoryItem[]);
      setCategories(d.categories);
      setSessions(d.sessions);
      setSelected(new Set());
      if (d.categories.length && !d.categories.some((c) => c.id === newCategory)) setNewCategory(d.categories[0].id);
    } catch (e) {
      setItems([]);
      setError(e instanceof Error ? e.message : "没能翻开记忆书。");
    }
  }, [newCategory]);

  useEffect(() => {
    setScope("");
  }, [masterId]);

  useEffect(() => {
    if (masterId) load(masterId, scope);
  }, [masterId, scope, load]);

  useFocusEffect(useCallback(() => {
    if (masterId) load(masterId, scope);
  }, [masterId, scope, load]));

  function act(body: Record<string, unknown>): boolean {
    setBusy(String(body.action) + String(body.id ?? ""));
    try {
      memoryAction(body);
      load(masterId, scope);
      haptic("success");
      return true;
    } catch (e) {
      toast(e instanceof Error ? e.message : "操作失败。", "err");
      return false;
    } finally {
      setBusy(null);
    }
  }

  function addEntry() {
    const content = newContent.trim();
    if (!content) return;
    if (act({ action: "add", masterId, sessionId: scope || null, category: newCategory, content })) setNewContent("");
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function deleteSelected() {
    if (selected.size === 0) return;
    try {
      memoryAction({ action: "deleteMany", ids: [...selected] });
      toast(`已删除 ${selected.size} 条`, "ok");
      load(masterId, scope);
      haptic("success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "批量删除失败。", "err");
    }
  }

  const masterName = masters.find((m) => m.id === masterId)?.name ?? "会长";
  const sessionTitle = sessions.find((s) => s.id === scope)?.title;
  const isPermanent = scope === "";
  const labelOf = (id: string) => categories.find((c) => c.id === id)?.label ?? id;

  return (
    <Screen title="记忆书" subtitle="会长与冒险者长期记住的事 · AI 自动整理、可改" back onBack={() => router.push("/settings")}>
      {error ? <ErrorBar text={error} /> : null}
      <View style={{ flexDirection: "row", gap: S.sm }}>
        <View style={{ flex: 1 }}>
          <Text style={styles.label}>会长</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5, marginTop: 3 }}>
            {masters.map((m) => <Chip key={m.id} label={m.name} active={masterId === m.id} onPress={() => setMasterId(m.id)} tone="gold" />)}
          </View>
        </View>
      </View>
      <View>
        <Text style={styles.label}>查看范围</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5, marginTop: 3 }}>
          <Chip label="永久记忆（会长）" active={scope === ""} onPress={() => setScope("")} tone="accent" />
          {sessions.map((s) => <Chip key={s.id} label={`对话：${s.title}（${s.messageCount}）`} active={scope === s.id} onPress={() => setScope(s.id)} tone="accent" />)}
        </View>
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", gap: S.sm }}>
        <Pressable
          onPress={() => setSelected(selected.size === (items?.length ?? 0) ? new Set() : new Set((items ?? []).map((m) => m.id)))}
          disabled={!items?.length}
        >
          <Text style={styles.meta}>{selected.size === (items?.length ?? 0) && (items?.length ?? 0) > 0 ? "取消全选" : "全选"}</Text>
        </Pressable>
        <Text style={styles.meta}>
          {isPermanent ? `${masterName} · 永久记忆` : `对话「${sessionTitle ?? ""}」`} · {items?.length ?? 0} 条
        </Text>
        {selected.size > 0 ? (
          <Pressable style={{ marginLeft: "auto" }} onPress={() => setConfirmBatch(true)}>
            <Text style={[styles.meta, { color: C.dangerText }]}>删除选中 {selected.size} 条</Text>
          </Pressable>
        ) : null}
      </View>

      {!isPermanent ? (
        <View style={styles.notice}>
          <Text style={styles.hint}>每段酒馆对话的记忆互相独立；删除这段对话时，它的记忆会一起消失。聊天时会同时带上这位会长的永久记忆。</Text>
        </View>
      ) : null}

      {items === null ? <Loading text="正在翻记忆书……" /> : null}
      {items !== null && items.length === 0 ? (
        <Empty text={isPermanent ? `${masterName} 的永久记忆还是空的。多聊聊，或先在下面手动添一条。` : "这段对话还没有自己的记忆。多聊几轮，或先在下面手动添一条。"} />
      ) : null}

      {items?.map((m) => (
        <Card key={m.id} style={!m.enabled ? { opacity: 0.6 } : undefined}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: S.sm }}>
            <Pressable onPress={() => toggleSelect(m.id)} style={[styles.check, selected.has(m.id) ? styles.checkOn : null]}>
              {selected.has(m.id) ? <Text style={{ color: C.onGold, fontSize: 10 }}>✓</Text> : null}
            </Pressable>
            <View style={styles.catBadge}><Text style={styles.catText}>{labelOf(m.category)}</Text></View>
            {!m.enabled ? <Text style={[styles.meta, { color: C.dangerText }]}>已停用</Text> : null}
            <Pressable style={{ marginLeft: "auto" }} onPress={() => act({ action: "toggle", id: m.id, enabled: !m.enabled })} disabled={busy !== null}>
              <Text style={styles.meta}>{m.enabled ? "停用" : "启用"}</Text>
            </Pressable>
          </View>
          {editingId === m.id ? (
            <View style={{ flexDirection: "row", gap: S.sm, alignItems: "center" }}>
              <Input value={editingText} onChangeText={setEditingText} maxLength={160} style={{ flex: 1 }} autoFocus />
              <Pressable onPress={() => { if (act({ action: "update", id: m.id, content: editingText })) setEditingId(null); }}>
                <Text style={{ color: C.accent, fontSize: 11 }}>保存</Text>
              </Pressable>
              <Pressable onPress={() => setEditingId(null)}><Text style={styles.meta}>取消</Text></Pressable>
            </View>
          ) : (
            <Text style={{ fontFamily: Fonts.body, fontSize: 12, lineHeight: 19, color: C.fg }}>{m.content}</Text>
          )}
          <View style={{ flexDirection: "row", gap: S.sm }}>
            <Button variant="outline" small style={{ flex: 1 }} onPress={() => { setEditingId(m.id); setEditingText(m.content); }}>编辑</Button>
            <Button variant="ghost" small style={{ flex: 1 }} onPress={() => act({ action: "delete", id: m.id })}>
              <Text style={{ color: C.dangerText }}>删除</Text>
            </Button>
          </View>
        </Card>
      ))}

      {items !== null ? (
        <Card>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5 }}>
            {categories.map((c) => <Chip key={c.id} label={c.label} active={newCategory === c.id} onPress={() => setNewCategory(c.id)} tone="gold" />)}
          </View>
          <View style={{ flexDirection: "row", gap: S.sm, alignItems: "center" }}>
            <Input
              placeholder={isPermanent ? "手动加一条永久记忆……" : "手动加一条对话记忆……"}
              maxLength={160}
              value={newContent}
              onChangeText={setNewContent}
              style={{ flex: 1 }}
              onSubmitEditing={addEntry}
            />
            <Button variant="outline" small onPress={addEntry} disabled={!newContent.trim() || busy !== null}>添加</Button>
          </View>
        </Card>
      ) : null}

      <ConfirmDialog
        visible={confirmBatch}
        title="删除选中的记忆？"
        description={`将删除 ${selected.size} 条，删掉后无法恢复。`}
        confirmLabel="删除"
        danger
        onConfirm={() => { setConfirmBatch(false); deleteSelected(); }}
        onCancel={() => setConfirmBatch(false)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  label: { fontFamily: Fonts.mono, fontSize: 9, color: C.muted, letterSpacing: 1 },
  meta: { fontFamily: Fonts.mono, fontSize: 10, color: C.muted },
  hint: { fontFamily: Fonts.body, fontSize: 10, color: C.faint, lineHeight: 16 },
  notice: { borderWidth: StyleSheet.hairlineWidth, borderColor: C.border, borderRadius: R.tile, backgroundColor: C.surface2, padding: S.sm },
  check: { width: 18, height: 18, borderRadius: 5, borderWidth: 1, borderColor: C.borderStrong, alignItems: "center", justifyContent: "center" },
  checkOn: { backgroundColor: C.gold, borderColor: C.gold },
  catBadge: { borderWidth: 1, borderColor: C.goldLine, backgroundColor: C.goldSoft, borderRadius: 99, paddingHorizontal: 7, paddingVertical: 1 },
  catText: { fontFamily: Fonts.mono, fontSize: 9, color: C.gold },
});
