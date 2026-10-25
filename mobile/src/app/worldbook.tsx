import { useCallback, useEffect, useState } from "react";
import { useFocusEffect, useRouter } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { C, Fonts, R, S } from "@/constants/theme";
import { Button, Card, Chip, Empty, ErrorBar, Field, Input, Loading, MultiInput, Screen, haptic } from "@/components/ui";
import { PromptDialog, ConfirmDialog } from "@/components/Dialogs";
import { useToast } from "@/components/Toast";
import { mastersData, worldBookAction, worldBookDetail, worldBooks } from "@/lib/service";

interface Book { id: string; name: string; entryCount: number }
interface Entry {
  id: string;
  keys: string[];
  secondaryKeys: string[];
  content: string;
  enabled: boolean;
  constant: boolean;
  selective: boolean;
  insertionOrder: number;
  position: "before" | "after" | "at_depth";
  depth: number;
  role: "system" | "user" | "assistant";
  extensions: Record<string, unknown>;
}
interface Draft {
  id?: string;
  keys: string;
  secondaryKeys: string;
  content: string;
  enabled: boolean;
  constant: boolean;
  selective: boolean;
  insertionOrder: number;
  position: Entry["position"];
  depth: number;
  role: Entry["role"];
  probability: string;
  extensions: Record<string, unknown>;
}
const EMPTY: Draft = { keys: "", secondaryKeys: "", content: "", enabled: true, constant: false, selective: false, insertionOrder: 100, position: "before", depth: 4, role: "system", probability: "", extensions: {} };
const POSITIONS: { key: Entry["position"]; label: string }[] = [
  { key: "before", label: "正文前" },
  { key: "after", label: "正文后" },
  { key: "at_depth", label: "按深度" },
];

function splitKeys(s: string) {
  return s.split(/[,，\n]/).map((x) => x.trim()).filter(Boolean);
}
function toDraft(e: Entry): Draft {
  return {
    id: e.id,
    keys: e.keys.join("，"),
    secondaryKeys: e.secondaryKeys.join("，"),
    content: e.content,
    enabled: e.enabled,
    constant: e.constant,
    selective: e.selective,
    insertionOrder: e.insertionOrder,
    position: e.position,
    depth: e.depth,
    role: e.role,
    probability: typeof e.extensions?.probability === "number" ? String(e.extensions.probability) : "",
    extensions: e.extensions ?? {},
  };
}

export default function WorldBookScreen() {
  const router = useRouter();
  const toast = useToast();
  const [books, setBooks] = useState<Book[] | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [usedBy, setUsedBy] = useState<{ id: string; name: string }[]>([]);
  const [stats, setStats] = useState<{ constantTokens: number; totalTokens: number; count: number } | null>(null);
  const [masters, setMasters] = useState<{ id: string; name: string }[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [newBookName, setNewBookName] = useState("");
  const [importJson, setImportJson] = useState("");
  const [assignOpen, setAssignOpen] = useState(false);
  const [cloneFrom, setCloneFrom] = useState("");
  const [cloneTo, setCloneTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmEntry, setConfirmEntry] = useState<string | null>(null);

  const loadBooks = useCallback(() => {
    try {
      const list = worldBooks() as Book[];
      setBooks(list);
      setMasters(mastersData().masters.map((m) => ({ id: m.id, name: m.name })));
      setActive((prev) => (prev && list.some((b) => b.id === prev) ? prev : list[0]?.id ?? null));
      setError(null);
      return list;
    } catch (e) {
      setBooks([]);
      setError(e instanceof Error ? e.message : "世界书没能取出来。");
      return [];
    }
  }, []);

  const loadBook = useCallback((bookId: string) => {
    try {
      const d = worldBookDetail(bookId);
      setEntries(d.entries as Entry[]);
      setUsedBy(d.usedBy);
      setStats(d.stats);
    } catch (e) {
      setError(e instanceof Error ? e.message : "世界书没能取出来。");
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      const list = loadBooks();
      if (list.length) {
        setActive((prev) => (prev && list.some((b) => b.id === prev) ? prev : list[0].id));
      }
    }, [loadBooks]),
  );

  useEffect(() => {
    if (active) loadBook(active);
  }, [active, loadBook]);

  function pickBook(id: string) {
    setActive(id);
    setDraft(null);
    setEntries(null);
    loadBook(id);
    haptic("select");
  }

  function post(body: Record<string, unknown>): boolean {
    setBusy(true);
    try {
      worldBookAction(body);
      haptic("success");
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
      return false;
    } finally {
      setBusy(false);
    }
  }

  function createNewBook() {
    if (!newBookName.trim()) return;
    if (post({ action: "createBook", name: newBookName.trim() })) {
      toast("已新建世界书", "ok");
      setNewBookName("");
      loadBooks();
    }
  }

  function toggleAssign(masterId: string) {
    if (!active) return;
    const assigned = usedBy.some((u) => u.id === masterId);
    if (post({ action: assigned ? "unassign" : "assign", masterId, bookId: active })) loadBook(active);
  }

  function saveDraft() {
    if (!draft || !active) return;
    if (!draft.content.trim()) {
      toast("内容不能为空。", "err");
      return;
    }
    if (
      post({
        action: "upsertEntry",
        bookId: active,
        entry: {
          id: draft.id,
          keys: splitKeys(draft.keys),
          secondaryKeys: splitKeys(draft.secondaryKeys),
          content: draft.content,
          enabled: draft.enabled,
          constant: draft.constant,
          selective: draft.selective,
          insertionOrder: Number(draft.insertionOrder) || 100,
          position: draft.position,
          depth: Number(draft.depth) || 4,
          role: draft.role,
          extensions: {
            ...draft.extensions,
            ...(draft.probability.trim() && Number(draft.probability) >= 0 && Number(draft.probability) <= 1
              ? { probability: Number(draft.probability) }
              : {}),
          },
        },
      })
    ) {
      setDraft(null);
      toast("已保存", "ok");
      loadBook(active);
    }
  }

  function cloneBooks() {
    if (!cloneFrom || !cloneTo || cloneFrom === cloneTo) return;
    if (post({ action: "cloneFromMaster", masterId: cloneTo, fromMasterId: cloneFrom })) {
      toast("已复制", "ok");
      setCloneFrom("");
      setCloneTo("");
      loadBooks();
    }
  }

  function importBook() {
    if (!active || !importJson.trim()) return;
    if (post({ action: "import", bookId: active, json: importJson })) {
      setImportJson("");
      toast("已追加导入", "ok");
      loadBook(active);
    }
  }

  const activeBook = books?.find((b) => b.id === active);
  const form = draft ? (
    <Card gold>
      <Text style={styles.formTitle}>{draft.id ? "编辑条目" : "新增条目"}</Text>
      <Field label="触发关键词（逗号分隔，留空 = 只靠常驻）">
        <Input value={draft.keys} onChangeText={(v) => setDraft({ ...draft, keys: v })} />
      </Field>
      <Field label="内容">
        <MultiInput value={draft.content} onChangeText={(v) => setDraft({ ...draft, content: v })} style={{ minHeight: 100 }} />
      </Field>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: S.sm }}>
        <Chip label="常驻" active={draft.constant} onPress={() => setDraft({ ...draft, constant: !draft.constant })} tone="gold" />
        <Chip label="启用" active={draft.enabled} onPress={() => setDraft({ ...draft, enabled: !draft.enabled })} tone="gold" />
        <Chip label="需两把钥匙" active={draft.selective} onPress={() => setDraft({ ...draft, selective: !draft.selective })} tone="gold" />
      </View>
      {draft.selective ? (
        <Field label="次级关键词（逗号分隔）">
          <Input value={draft.secondaryKeys} onChangeText={(v) => setDraft({ ...draft, secondaryKeys: v })} />
        </Field>
      ) : null}
      <View style={{ flexDirection: "row", gap: S.md, alignItems: "flex-end", flexWrap: "wrap" }}>
        <View style={{ width: 88 }}>
          <Field label="触发概率">
            <Input keyboardType="numeric" placeholder="1" value={draft.probability} onChangeText={(v) => setDraft({ ...draft, probability: v })} />
          </Field>
        </View>
        <View style={{ flex: 1, minWidth: 180 }}>
          <Text style={styles.label}>位置</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
            {POSITIONS.map((p) => (
              <Chip key={p.key} label={p.label} active={draft.position === p.key} onPress={() => setDraft({ ...draft, position: p.key })} tone="gold" />
            ))}
          </View>
        </View>
        <View style={{ width: 70 }}>
          <Field label="顺序">
            <Input keyboardType="numeric" value={String(draft.insertionOrder)} onChangeText={(v) => setDraft({ ...draft, insertionOrder: Number(v) || 0 })} />
          </Field>
        </View>
        {draft.position === "at_depth" ? (
          <View style={{ width: 70 }}>
            <Field label="深度">
              <Input keyboardType="numeric" value={String(draft.depth)} onChangeText={(v) => setDraft({ ...draft, depth: Number(v) || 0 })} />
            </Field>
          </View>
        ) : null}
      </View>
      <View style={{ flexDirection: "row", gap: S.sm }}>
        <Button variant="primary" onPress={saveDraft} style={{ flex: 1 }} disabled={busy}>保存</Button>
        <Button variant="outline" onPress={() => setDraft(null)} style={{ flex: 1 }}>取消</Button>
      </View>
    </Card>
  ) : null;

  return (
    <Screen title="世界书" subtitle="贴在角色卡上的设定册 · 一本可挂给多位会长" back onBack={() => router.push("/settings")}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {books === null ? <Text style={styles.meta}>加载中……</Text> : null}
        {books?.map((b) => (
          <Chip key={b.id} label={`${b.name} ${b.entryCount}`} active={active === b.id} onPress={() => pickBook(b.id)} tone="accent" />
        ))}
        <Pressable onPress={() => router.push("/masters")} style={{ marginLeft: "auto", justifyContent: "center" }}>
          <Text style={styles.meta}>导入角色卡 →</Text>
        </Pressable>
      </View>
      {error ? <ErrorBar text={error} /> : null}

      {activeBook ? (
        <Card>
          <View style={{ flexDirection: "row", alignItems: "center", gap: S.sm }}>
            <Text style={{ flex: 1, fontFamily: Fonts.body, fontSize: 13, color: C.fg }}>{activeBook.name}</Text>
            <Pressable onPress={() => setRenameOpen(true)}><Text style={styles.meta}>改名</Text></Pressable>
            <Pressable onPress={() => setConfirmDelete(true)}><Text style={[styles.meta, { color: C.dangerText }]}>删除</Text></Pressable>
          </View>
          <Pressable style={styles.assignHead} onPress={() => setAssignOpen((v) => !v)}>
            <Text style={styles.meta}>挂给会长</Text>
            <Text style={styles.meta}>{usedBy.length ? usedBy.map((u) => u.name).join("、") : "未挂载"} ▾</Text>
          </Pressable>
          {assignOpen ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {masters.map((m) => {
                const on = usedBy.some((u) => u.id === m.id);
                return <Chip key={m.id} label={`${on ? "✓ " : ""}${m.name}`} active={on} onPress={() => toggleAssign(m.id)} tone="accent" />;
              })}
            </View>
          ) : null}
        </Card>
      ) : null}

      {stats ? (
        <Text style={styles.stats}>
          共 {stats.count} 条 · 常驻约 {stats.constantTokens} tokens（每回合固定占用）· 全部启用条目约 {stats.totalTokens} tokens（命中时注入，超预算自动截断）
        </Text>
      ) : null}

      {entries === null && activeBook ? <Loading text="正在翻设定册……" /> : null}
      {entries !== null && entries.length === 0 && !draft ? <Empty text="这本还是空的。加一条吧。" /> : null}

      {entries?.map((e) => (
        <View key={e.id} style={{ gap: S.sm }}>
          <Card>
            <View style={{ flexDirection: "row", alignItems: "center", gap: S.sm, flexWrap: "wrap" }}>
              <View style={styles.keyBadge}>
                <Text style={styles.keyText}>{e.constant ? "常驻" : e.keys.length ? e.keys.join(" / ") : "无关键词"}</Text>
              </View>
              <Text style={styles.meta}>{POSITIONS.find((p) => p.key === e.position)?.label}</Text>
              {!e.enabled ? <Text style={[styles.meta, { color: C.dangerText }]}>已停用</Text> : null}
              <Text style={[styles.meta, { marginLeft: "auto" }]}>#{e.insertionOrder}</Text>
            </View>
            <Text style={{ fontFamily: Fonts.body, fontSize: 12, color: C.fg, lineHeight: 18 }} numberOfLines={3}>
              {e.content}
            </Text>
            <View style={{ flexDirection: "row", gap: S.sm }}>
              <Button variant="outline" small onPress={() => setDraft(toDraft(e))} style={{ flex: 1 }}>编辑</Button>
              <Button variant="ghost" small onPress={() => setConfirmEntry(e.id)} style={{ flex: 1 }}>
                <Text style={{ color: C.dangerText }}>删除</Text>
              </Button>
            </View>
          </Card>
          {draft?.id === e.id ? form : null}
        </View>
      ))}

      {draft && !draft.id ? form : null}
      {!draft && activeBook ? (
        <Button variant="outline" onPress={() => setDraft({ ...EMPTY })}>+ 新增条目</Button>
      ) : null}

      <Card>
        <Text style={styles.formTitle}>新建世界书</Text>
        <View style={{ flexDirection: "row", gap: S.sm }}>
          <Input placeholder="例如：协会通史（可挂给多位会长）" value={newBookName} onChangeText={setNewBookName} style={{ flex: 1 }} />
          <Button variant="outline" onPress={createNewBook} disabled={!newBookName.trim() || busy}>新建</Button>
        </View>
      </Card>

      <Card>
        <Text style={styles.formTitle}>复制某位会长的世界书</Text>
        <Text style={styles.hint}>把「来源」会长挂载的所有世界书整本复制给「目标」会长（原书不动）。</Text>
        <View style={{ flexDirection: "row", gap: S.sm }}>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>来源</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5, marginTop: 3 }}>
              {masters.map((m) => <Chip key={m.id} label={m.name} active={cloneFrom === m.id} onPress={() => setCloneFrom(m.id)} tone="gold" />)}
            </View>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>目标</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5, marginTop: 3 }}>
              {masters.map((m) => <Chip key={m.id} label={m.name} active={cloneTo === m.id} onPress={() => setCloneTo(m.id)} tone="gold" />)}
            </View>
          </View>
        </View>
        <Button variant="outline" onPress={cloneBooks} disabled={!cloneFrom || !cloneTo || cloneFrom === cloneTo || busy}>复制</Button>
      </Card>

      {activeBook ? (
        <Card>
          <Text style={styles.formTitle}>追加导入世界书</Text>
          <Text style={styles.hint}>粘贴独立世界书 JSON（lorebook_v3 或含 entries 的对象/数组），追加到「{activeBook.name}」。</Text>
          <MultiInput placeholder='{"entries":[{"keys":["钟楼"],"content":"…"}]}' value={importJson} onChangeText={setImportJson} style={{ minHeight: 80 }} />
          <Button variant="outline" onPress={importBook} disabled={!importJson.trim() || busy}>追加</Button>
        </Card>
      ) : null}

      <PromptDialog visible={renameOpen} title="世界书改名" initialValue={activeBook?.name ?? ""} onSubmit={(v) => {
        setRenameOpen(false);
        if (v && active) {
          if (post({ action: "renameBook", bookId: active, name: v })) { toast("已改名", "ok"); loadBooks(); }
        }
      }} onCancel={() => setRenameOpen(false)} />
      <ConfirmDialog visible={confirmDelete} title="删除世界书？" description={`「${activeBook?.name ?? ""}」的条目与分配都会一并删除。`} confirmLabel="删除" danger onConfirm={() => {
        setConfirmDelete(false);
        if (active && post({ action: "deleteBook", bookId: active })) {
          const list = loadBooks();
          setActive(list[0]?.id ?? null);
          if (list[0]) loadBook(list[0].id); else setEntries([]);
        }
      }} onCancel={() => setConfirmDelete(false)} />
      <ConfirmDialog visible={!!confirmEntry} title="删除这条世界书条目？" confirmLabel="删除" danger onConfirm={() => {
        const id = confirmEntry;
        setConfirmEntry(null);
        if (id && post({ action: "deleteEntry", id })) active && loadBook(active);
      }} onCancel={() => setConfirmEntry(null)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  meta: { fontFamily: Fonts.mono, fontSize: 10, color: C.muted },
  label: { fontFamily: Fonts.body, fontSize: 10, color: C.muted },
  hint: { fontFamily: Fonts.body, fontSize: 10, color: C.faint, lineHeight: 16 },
  stats: { fontFamily: Fonts.body, fontSize: 10, color: C.faint, lineHeight: 16 },
  formTitle: { fontFamily: Fonts.display, fontSize: 16, color: C.gold },
  assignHead: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 },
  keyBadge: { borderWidth: 1, borderColor: C.border, borderRadius: 99, paddingHorizontal: 7, paddingVertical: 1 },
  keyText: { fontFamily: Fonts.mono, fontSize: 9, color: C.fg },
});
