"use client";

/**
 * P12 记忆书管理页（二级页）。
 *
 * 两级 scope：
 * - 「永久记忆」：会长级，任务管线写入，一位会长自始至终只有一本；
 * - 「某段对话」：酒馆聊天每段对话各有一本私有记忆，互不共享（聊天时还会带上永久记忆）。
 *
 * 条目由 AI 在对局中自动生成，这里可以像世界书一样增删改、启用/停用、勾选批量删除。
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import BottomNav from "@/components/BottomNav";
import ConfirmDialog from "@/components/ConfirmDialog";
import { toast } from "@/components/Toast";

interface MasterOption {
  id: string;
  name: string;
}

interface SessionOption {
  id: string;
  title: string;
  messageCount: number;
}

interface MemoryItem {
  id: string;
  masterId: string | null;
  sessionId: string | null;
  category: string;
  content: string;
  enabled: boolean;
  createdAt: number;
}

interface CategoryOption {
  id: string;
  label: string;
}

/** 查看范围："" = 会长级永久记忆；其余 = 某段酒馆对话 id */
const PERMANENT = "";

export default function MemoryClient({
  masters,
  defaultMasterId,
}: {
  masters: MasterOption[];
  defaultMasterId: string | null;
}) {
  const [masterId, setMasterId] = useState<string>(defaultMasterId ?? masters[0]?.id ?? "");
  const [scope, setScope] = useState<string>(PERMANENT);
  const [sessions, setSessions] = useState<SessionOption[]>([]);
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [newCategory, setNewCategory] = useState("story");
  const [newContent, setNewContent] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmBatch, setConfirmBatch] = useState(false);

  const load = useCallback((mid: string, sid: string) => {
    if (!mid) return;
    setLoading(true);
    const q = new URLSearchParams({ masterId: mid });
    if (sid) q.set("sessionId", sid);
    fetch(`/api/memory?${q.toString()}`)
      .then((r) => r.json())
      .then(
        (d: {
          memories?: MemoryItem[];
          categories?: CategoryOption[];
          sessions?: SessionOption[];
        }) => {
          setItems(d.memories ?? []);
          setSelected(new Set());
          if (d.sessions) setSessions(d.sessions);
          if (d.categories?.length) {
            setCategories(d.categories);
            setNewCategory((c) =>
              d.categories!.some((x) => x.id === c) ? c : d.categories![0].id,
            );
          }
        },
      )
      .catch(() => toast("没能翻开记忆书，稍后再试。", "err"))
      .finally(() => setLoading(false));
  }, []);

  // 切会长回到「永久记忆」
  useEffect(() => {
    setScope(PERMANENT);
  }, [masterId]);

  useEffect(() => {
    if (masterId) load(masterId, scope);
  }, [masterId, scope, load]);

  async function act(body: Record<string, unknown>): Promise<boolean> {
    setBusy(String(body.action) + String(body.id ?? ""));
    try {
      const res = await fetch("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = (await res.json()) as { error?: string };
      if (!res.ok || d.error) {
        toast(d.error ?? "操作失败。", "err");
        return false;
      }
      load(masterId, scope);
      return true;
    } catch {
      toast("网络不通，操作失败。", "err");
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function addEntry() {
    const content = newContent.trim();
    if (!content) return;
    const ok = await act({
      action: "add",
      masterId,
      sessionId: scope || null,
      category: newCategory,
      content,
    });
    if (ok) setNewContent("");
  }

  async function deleteSelected() {
    if (selected.size === 0) return;
    setBusy("deleteMany");
    try {
      const res = await fetch("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "deleteMany", ids: [...selected] }),
      });
      const d = (await res.json()) as { error?: string; deleted?: number };
      if (!res.ok || d.error) {
        toast(d.error ?? "批量删除失败。", "err");
        return;
      }
      toast(`已删除 ${d.deleted ?? 0} 条`);
      load(masterId, scope);
    } catch {
      toast("网络不通，批量删除失败。", "err");
    } finally {
      setBusy(null);
    }
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected((prev) =>
      prev.size === items.length ? new Set() : new Set(items.map((m) => m.id)),
    );
  }

  const labelOf = (id: string) => categories.find((c) => c.id === id)?.label ?? id;
  const masterName = masters.find((m) => m.id === masterId)?.name ?? "会长";
  const sessionTitle = sessions.find((s) => s.id === scope)?.title;
  const isPermanent = scope === PERMANENT;

  return (
    <main className="bg-bg text-fg font-body mx-auto flex h-dvh max-w-md flex-col">
      <header className="border-border flex items-center justify-between border-b px-4 py-3">
        <div>
          <h1 className="font-display text-fs-h1 leading-tight">记忆书</h1>
          <p className="text-fs-micro text-muted">会长与冒险者长期记住的事 · AI 自动整理、可改</p>
        </div>
        <Link
          href="/settings"
          className="text-fs-meta text-muted hover:text-fg rounded-btn px-2 py-1.5 transition-colors"
        >
          返回设置
        </Link>
      </header>

      {/* 会长 + 查看范围 */}
      <div className="border-border flex gap-2 border-b px-4 py-2">
        <label className="min-w-0 flex-1">
          <span className="font-numeric text-fs-micro tracking-widest text-muted">会长</span>
          <select
            className="border-border-strong bg-surface-2 text-fg rounded-btn mt-1 w-full border px-2 py-1.5 text-fs-sm outline-none"
            value={masterId}
            onChange={(e) => setMasterId(e.target.value)}
          >
            {masters.map((m) => (
              <option key={m.id} value={m.id} className="bg-surface text-fg">
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-0 flex-1">
          <span className="font-numeric text-fs-micro tracking-widest text-muted">查看范围</span>
          <select
            className="border-border-strong bg-surface-2 text-fg rounded-btn mt-1 w-full border px-2 py-1.5 text-fs-sm outline-none"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
          >
            <option value={PERMANENT} className="bg-surface text-fg">
              永久记忆（会长）
            </option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id} className="bg-surface text-fg">
                对话：{s.title}（{s.messageCount} 条）
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* 工具条：全选 / 批量删除 */}
      <div className="border-border flex items-center gap-2 border-b px-4 py-1.5">
        <button
          type="button"
          disabled={loading || items.length === 0}
          onClick={toggleSelectAll}
          className="text-fs-micro text-muted hover:text-fg transition-colors disabled:opacity-40"
        >
          {selected.size === items.length && items.length > 0 ? "取消全选" : "全选"}
        </button>
        <span className="text-fs-micro text-faint">
          {isPermanent ? `${masterName} · 永久记忆` : `对话「${sessionTitle ?? ""}」`} · {items.length} 条
        </span>
        {selected.size > 0 && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => setConfirmBatch(true)}
            className="text-fs-micro text-danger-text ml-auto transition-colors disabled:opacity-40"
          >
            删除选中 {selected.size} 条
          </button>
        )}
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto px-4 py-3">
        {!isPermanent && (
          <p className="border-border bg-surface-2 text-fs-micro text-faint rounded-tile border px-3 py-1.5 leading-relaxed">
            每段酒馆对话的记忆互相独立；删除这段对话时，它的记忆会一起消失。聊天时会同时带上这位会长的永久记忆。
          </p>
        )}

        {loading && <p className="text-muted mt-6 text-center text-sm">正在翻记忆书……</p>}
        {!loading && items.length === 0 && (
          <p className="text-muted mt-6 text-center text-sm">
            {isPermanent
              ? `${masterName} 的永久记忆还是空的。多聊聊，或先在下面手动添一条。`
              : "这段对话还没有自己的记忆。多聊几轮，或先在下面手动添一条。"}
          </p>
        )}

        {items.map((m) => (
          <article
            key={m.id}
            className={`border-border bg-surface rounded-card border p-3 ${
              m.enabled ? "" : "opacity-60"
            }`}
          >
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={selected.has(m.id)}
                onChange={() => toggleSelect(m.id)}
                aria-label="选择这条记忆"
              />
              <span className="rounded-full border border-gold-line bg-gold-soft px-2 py-0.5 font-numeric text-fs-micro text-gold">
                {labelOf(m.category)}
              </span>
              {!m.enabled && <span className="text-fs-micro text-danger-text">已停用</span>}
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => act({ action: "toggle", id: m.id, enabled: !m.enabled })}
                className="text-fs-micro text-muted hover:text-fg ml-auto transition-colors disabled:opacity-40"
              >
                {m.enabled ? "停用" : "启用"}
              </button>
            </div>
            {editingId === m.id ? (
              <div className="mt-2 flex items-center gap-2">
                <input
                  className="border-border-strong bg-surface-2 text-fg rounded-btn min-w-0 flex-1 border px-2 py-1 text-fs-sm outline-none"
                  value={editingText}
                  maxLength={160}
                  onChange={(e) => setEditingText(e.target.value)}
                />
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={async () => {
                    const ok = await act({ action: "update", id: m.id, content: editingText });
                    if (ok) setEditingId(null);
                  }}
                  className="text-fs-micro text-accent shrink-0"
                >
                  保存
                </button>
                <button
                  type="button"
                  onClick={() => setEditingId(null)}
                  className="text-fs-micro text-faint shrink-0"
                >
                  取消
                </button>
              </div>
            ) : (
              <p className="text-fs-sm text-fg mt-1.5 leading-relaxed break-words">{m.content}</p>
            )}
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => {
                  setEditingId(m.id);
                  setEditingText(m.content);
                }}
                className="border-accent-line text-accent hover:bg-accent-soft rounded-btn flex-1 border py-1 text-fs-micro transition-colors disabled:opacity-40"
              >
                编辑
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => act({ action: "delete", id: m.id })}
                className="text-muted hover:text-danger-text rounded-btn flex-1 py-1 text-fs-micro transition-colors disabled:opacity-40"
              >
                删除
              </button>
            </div>
          </article>
        ))}

        {/* 手动添加一条 */}
        {!loading && (
          <div className="border-border border-t pt-3">
            <div className="flex items-center gap-2">
              <select
                className="border-border-strong bg-surface-2 text-fg rounded-btn shrink-0 border px-2 py-1 text-fs-micro outline-none"
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
              >
                {categories.map((c) => (
                  <option key={c.id} value={c.id} className="bg-surface text-fg">
                    {c.label}
                  </option>
                ))}
              </select>
              <input
                className="border-border-strong bg-surface-2 text-fg rounded-btn min-w-0 flex-1 border px-3 py-1.5 text-fs-sm outline-none placeholder:text-faint"
                placeholder={isPermanent ? "手动加一条永久记忆……" : "手动加一条对话记忆……"}
                maxLength={160}
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) void addEntry();
                }}
              />
              <button
                type="button"
                disabled={busy !== null || !newContent.trim()}
                onClick={() => void addEntry()}
                className="border-accent-line text-accent hover:bg-accent-soft rounded-btn shrink-0 border px-3 py-1.5 text-fs-micro transition-colors disabled:opacity-40"
              >
                添加
              </button>
            </div>
          </div>
        )}

      </div>

      <BottomNav />

      {confirmBatch && (
        <ConfirmDialog
          title="删除选中的记忆？"
          description={`将删除 ${selected.size} 条，删掉后无法恢复。`}
          confirmLabel="删除"
          busy={busy !== null}
          onConfirm={() => {
            setConfirmBatch(false);
            void deleteSelected();
          }}
          onCancel={() => setConfirmBatch(false)}
        />
      )}
    </main>
  );
}
