"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import BottomNav from "@/components/BottomNav";
import ConfirmDialog from "@/components/ConfirmDialog";
import PromptDialog from "@/components/PromptDialog";
import { toast } from "@/components/Toast";

/**
 * 世界书管理（P6：书册 + 多对多分配）。
 * - 一本世界书可挂给多位会长（如"协会通史"共享）
 * - 一位会长可挂多本
 * - 全局书唯一、始终生效，不可删除
 * - 支持增/改/删条目、新建/改名/删除书册、挂载/卸载到会长、独立世界书 JSON 追加导入
 */

interface MasterOption {
  id: string;
  name: string;
  isOfficial: boolean;
}

interface Book {
  id: string;
  name: string;
  entryCount: number;
}

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
}

interface Stats {
  constantTokens: number;
  totalTokens: number;
  count: number;
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
}

const EMPTY_DRAFT: Draft = {
  keys: "",
  secondaryKeys: "",
  content: "",
  enabled: true,
  constant: false,
  selective: false,
  insertionOrder: 100,
  position: "before",
  depth: 4,
  role: "system",
};

const POSITION_LABEL: Record<Entry["position"], string> = {
  before: "正文前",
  after: "正文后",
  at_depth: "按深度",
};

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
  };
}

function splitKeys(s: string): string[] {
  return s
    .split(/[,，\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export default function WorldBookClient({ masters }: { masters: MasterOption[] }) {
  const [books, setBooks] = useState<Book[] | null>(null);
  const [activeBook, setActiveBook] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [usedBy, setUsedBy] = useState<{ id: string; name: string }[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [importJson, setImportJson] = useState("");
  const [busy, setBusy] = useState(false);
  const [newBookName, setNewBookName] = useState("");
  const [assignOpen, setAssignOpen] = useState(false);
  /** P9 复制世界书：来源/目标会长 */
  const [cloneFrom, setCloneFrom] = useState("");
  const [cloneTo, setCloneTo] = useState("");
  /** 应用内弹窗（替代原生 prompt/confirm） */
  const [promptState, setPromptState] = useState<{
    title: string;
    label?: string;
    value: string;
    busy?: boolean;
    onSubmit: (v: string) => void;
  } | null>(null);
  const [confirmState, setConfirmState] = useState<{
    title: string;
    description?: string;
    confirmLabel?: string;
    onConfirm: () => void;
  } | null>(null);

  const book = books?.find((b) => b.id === activeBook) ?? null;

  const loadBooks = useCallback(async (): Promise<Book[]> => {
    const d = await fetch("/api/worldbook").then((r) => r.json());
    const list: Book[] = d.books ?? [];
    setBooks(list);
    return list;
  }, []);

  const loadBook = useCallback(async (bookId: string) => {
    setEntries(null);
    const d = await fetch(`/api/worldbook?bookId=${encodeURIComponent(bookId)}`).then((r) =>
      r.json(),
    );
    setEntries(d.entries ?? []);
    setUsedBy(d.usedBy ?? []);
    setStats(d.stats ?? null);
  }, []);

  useEffect(() => {
    loadBooks().then((list) => {
      if (list.length > 0) setActiveBook(list[0].id);
      else setActiveBook(null);
    });
  }, [loadBooks]);

  useEffect(() => {
    if (activeBook) loadBook(activeBook);
  }, [activeBook, loadBook]);

  async function post(body: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    try {
      const res = await fetch("/api/worldbook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (!res.ok || d.error) {
        toast(d.error ?? "操作失败", "err");
        return false;
      }
      return true;
    } catch {
      toast("网络不通，操作失败。", "err");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function createNewBook() {
    if (!newBookName.trim()) return;
    const ok = await post({ action: "createBook", name: newBookName.trim() });
    if (ok) {
      setNewBookName("");
      toast("已新建世界书");
      const list = await loadBooks();
      const created = list.find((b) => b.name === newBookName.trim());
      if (created) setActiveBook(created.id);
    }
  }

  async function renameCurrent() {
    if (!book) return;
    const target = book;
    setPromptState({
      title: "世界书改名",
      value: target.name,
      onSubmit: async (name) => {
        setPromptState(null);
        if (!name) return;
        if (await post({ action: "renameBook", bookId: target.id, name })) {
          toast("已改名");
          loadBooks();
        }
      },
    });
  }

  async function deleteCurrent() {
    if (!book) return;
    const target = book;
    setConfirmState({
      title: "删除世界书？",
      description: `「${target.name}」的条目与分配都会一并删除。`,
      confirmLabel: "删除",
      onConfirm: async () => {
        setConfirmState(null);
        if (await post({ action: "deleteBook", bookId: target.id })) {
          const list = await loadBooks();
          setActiveBook(list[0]?.id ?? null);
        }
      },
    });
  }

  async function toggleAssign(masterId: string) {
    if (!book) return;
    const assigned = usedBy.some((u) => u.id === masterId);
    const ok = await post({
      action: assigned ? "unassign" : "assign",
      masterId,
      bookId: book.id,
    });
    if (ok) loadBook(book.id);
  }

  async function saveDraft() {
    if (!draft || !book) return;
    if (!draft.content.trim()) {
      toast("内容不能为空。", "err");
      return;
    }
    const ok = await post({
      action: "upsertEntry",
      bookId: book.id,
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
      },
    });
    if (ok) {
      setDraft(null);
      toast("已保存");
      loadBook(book.id);
    }
  }

  async function removeEntry(id: string) {
    if (!book) return;
    const bookId = book.id;
    setConfirmState({
      title: "删除这条世界书条目？",
      confirmLabel: "删除",
      onConfirm: async () => {
        setConfirmState(null);
        if (await post({ action: "deleteEntry", id })) loadBook(bookId);
      },
    });
  }

  async function importBook() {
    if (!book || !importJson.trim()) return;
    if (await post({ action: "import", bookId: book.id, json: importJson })) {
      setImportJson("");
      toast("已追加导入");
      loadBook(book.id);
    }
  }

  /** P9 把来源会长的世界书整本复制给目标会长 */
  async function cloneBooks() {
    if (!cloneFrom || !cloneTo || cloneFrom === cloneTo) return;
    const ok = await post({ action: "cloneFromMaster", masterId: cloneTo, fromMasterId: cloneFrom });
    if (ok) {
      toast("已复制");
      setCloneFrom("");
      setCloneTo("");
      loadBooks();
    }
  }

  /**
   * 条目编辑/新增表单。
   * 编辑时贴在所编辑条目正下方（不再跑到列表最底部）；新增时贴在底部。
   */
  function renderDraftForm() {
    if (!draft) return null;
    return (
      <div className="border-gold-line bg-surface rounded-card border p-4">
        <p className="font-display text-fs-h3 mb-2">{draft.id ? "编辑条目" : "新增条目"}</p>
        <div className="space-y-2.5">
          <label className="block">
            <span className="text-fs-micro text-muted">触发关键词（逗号分隔，留空=只靠常驻）</span>
            <input
              className="border-border-strong bg-surface-2 text-fg rounded-btn mt-1 w-full border px-3 py-2 text-fs-sm outline-none"
              value={draft.keys}
              onChange={(e) => setDraft({ ...draft, keys: e.target.value })}
            />
          </label>
          <label className="block">
            <span className="text-fs-micro text-muted">内容</span>
            <textarea
              className="border-border-strong bg-surface-2 text-fg rounded-btn mt-1 min-h-24 w-full border px-3 py-2 text-fs-sm leading-relaxed outline-none"
              value={draft.content}
              onChange={(e) => setDraft({ ...draft, content: e.target.value })}
            />
          </label>
          <div className="flex flex-wrap gap-3 text-fs-sm">
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={draft.constant}
                onChange={(e) => setDraft({ ...draft, constant: e.target.checked })}
              />
              常驻
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
              />
              启用
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={draft.selective}
                onChange={(e) => setDraft({ ...draft, selective: e.target.checked })}
              />
              需两把钥匙
            </label>
          </div>
          {draft.selective && (
            <input
              className="border-border-strong bg-surface-2 text-fg rounded-btn w-full border px-3 py-2 text-fs-sm outline-none"
              placeholder="次级关键词（逗号分隔）"
              value={draft.secondaryKeys}
              onChange={(e) => setDraft({ ...draft, secondaryKeys: e.target.value })}
            />
          )}
          <div className="flex gap-2">
            <label className="flex-1">
              <span className="text-fs-micro text-muted">位置</span>
              <select
                className="border-border-strong bg-surface-2 text-fg rounded-btn mt-1 w-full border px-2 py-2 text-fs-sm outline-none"
                value={draft.position}
                onChange={(e) =>
                  setDraft({ ...draft, position: e.target.value as Entry["position"] })
                }
              >
                <option value="before">正文前</option>
                <option value="after">正文后</option>
                <option value="at_depth">按深度</option>
              </select>
            </label>
            <label className="w-20">
              <span className="text-fs-micro text-muted">顺序</span>
              <input
                type="number"
                className="border-border-strong bg-surface-2 text-fg rounded-btn mt-1 w-full border px-2 py-2 text-fs-sm outline-none"
                value={draft.insertionOrder}
                onChange={(e) => setDraft({ ...draft, insertionOrder: Number(e.target.value) })}
              />
            </label>
            {draft.position === "at_depth" && (
              <label className="w-20">
                <span className="text-fs-micro text-muted">深度</span>
                <input
                  type="number"
                  className="border-border-strong bg-surface-2 text-fg rounded-btn mt-1 w-full border px-2 py-2 text-fs-sm outline-none"
                  value={draft.depth}
                  onChange={(e) => setDraft({ ...draft, depth: Number(e.target.value) })}
                />
              </label>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              className="bg-accent text-on-accent rounded-btn flex-1 py-2 text-fs-sm font-medium disabled:opacity-40"
              onClick={saveDraft}
            >
              保存
            </button>
            <button
              type="button"
              className="border-border-strong rounded-btn flex-1 border py-2 text-fs-sm"
              onClick={() => setDraft(null)}
            >
              取消
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <main className="bg-bg text-fg font-body mx-auto flex h-dvh max-w-md flex-col">
      <header className="border-border flex items-center justify-between border-b px-4 py-3">
        <div>
          <h1 className="font-display text-fs-h1 leading-tight">世界书</h1>
          <p className="text-fs-micro text-muted">贴在角色卡上的设定册 · 一本可挂给多位会长</p>
        </div>
        <Link
          href="/settings"
          className="text-fs-meta text-muted hover:text-fg rounded-btn px-2 py-1.5 transition-colors"
        >
          返回设置
        </Link>
      </header>

      {/* 书册选择 */}
      <div className="border-border flex flex-wrap gap-1.5 border-b px-4 py-2">
        {books === null && <span className="text-fs-meta text-muted">加载中……</span>}
        {books?.map((b) => (
          <button
            key={b.id}
            type="button"
            onClick={() => setActiveBook(b.id)}
            className={`rounded-pill px-3 py-1 text-fs-meta transition-colors ${
              activeBook === b.id
                ? "bg-accent text-on-accent font-medium"
                : "text-muted hover:text-fg"
            }`}
          >
            {b.name}
            <span className="text-fs-micro opacity-70"> {b.entryCount}</span>
          </button>
        ))}
        <Link
          href="/masters"
          className="text-fs-micro text-muted hover:text-fg ml-auto self-center"
        >
          导入角色卡 →
        </Link>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {book && (
          <div className="border-border bg-surface rounded-card flex items-center gap-2 border p-3">
            <span className="text-fs-sm">{book.name}</span>
            <button
              type="button"
              className="text-fs-micro text-muted hover:text-fg ml-auto"
              onClick={renameCurrent}
            >
              改名
            </button>
            <button
              type="button"
              className="text-fs-micro text-muted hover:text-danger-text"
              onClick={deleteCurrent}
            >
              删除
            </button>
          </div>
        )}

        {/* 挂载：这本书给哪些会长用 */}
        {book && (
          <div className="border-border bg-surface rounded-card border p-3">
            <button
              type="button"
              className="flex w-full items-center justify-between"
              onClick={() => setAssignOpen((v) => !v)}
            >
              <span className="text-fs-sm">挂给会长</span>
              <span className="text-fs-micro text-faint">
                {usedBy.length ? usedBy.map((u) => u.name).join("、") : "未挂载"} ▾
              </span>
            </button>
            {assignOpen && (
              <div className="mt-2 flex flex-wrap gap-2">
                {masters.map((m) => {
                  const on = usedBy.some((u) => u.id === m.id);
                  return (
                    <button
                      key={m.id}
                      type="button"
                      disabled={busy}
                      onClick={() => toggleAssign(m.id)}
                      className={`rounded-pill border px-3 py-1 text-fs-meta transition-colors disabled:opacity-40 ${
                        on
                          ? "border-accent-line bg-accent-soft text-accent"
                          : "border-border text-muted hover:text-fg"
                      }`}
                    >
                      {on ? "✓ " : ""}
                      {m.name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* P9 token 预算可视化：常驻条目每回合都注入，给出固定占用 */}
        {stats && (
          <p className="text-fs-micro text-faint leading-relaxed">
            共 {stats.count} 条 · 常驻约 {stats.constantTokens} tokens（每回合固定占用）·
            全部启用条目约 {stats.totalTokens} tokens（命中时注入，超预算自动截断）
          </p>
        )}

        {entries === null && book && (
          <p className="text-muted mt-6 text-center text-sm">正在翻设定册……</p>
        )}
        {entries !== null && entries.length === 0 && !draft && (
          <p className="text-muted mt-6 text-center text-sm">这本还是空的。加一条吧。</p>
        )}

        {entries?.map((e) => (
          <Fragment key={e.id}>
          <article className="border-border bg-surface rounded-card border p-3">
            <div className="flex items-center gap-2">
              <span className="rounded-full border border-border px-1.5 font-numeric text-fs-micro text-fg">
                {e.constant ? "常驻" : e.keys.length ? e.keys.join(" / ") : "无关键词"}
              </span>
              <span className="text-fs-micro text-faint">{POSITION_LABEL[e.position]}</span>
              {!e.enabled && <span className="text-fs-micro text-danger-text">已停用</span>}
              <span className="text-fs-micro text-faint ml-auto">#{e.insertionOrder}</span>
            </div>
            <p className="text-fs-sm text-fg mt-1.5 line-clamp-3 whitespace-pre-wrap">
              {e.content}
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                className="border-accent-line text-accent hover:bg-accent-soft rounded-btn flex-1 border py-1 text-fs-micro transition-colors"
                onClick={() => setDraft(toDraft(e))}
              >
                编辑
              </button>
              <button
                type="button"
                className="text-muted hover:text-danger-text rounded-btn flex-1 py-1 text-fs-micro transition-colors"
                onClick={() => removeEntry(e.id)}
              >
                删除
              </button>
            </div>
          </article>
          {/* 编辑表单紧贴在所编辑的这条下方，不再跑到列表最底部 */}
          {draft?.id === e.id && renderDraftForm()}
          </Fragment>
        ))}

        {/* 新增条目：表单贴底部；编辑表单则贴在所编辑条目下方（见上） */}
        {draft && !draft.id && renderDraftForm()}
        {!draft && book && (
          <button
            type="button"
            className="border-accent-line text-accent hover:bg-accent-soft rounded-btn w-full border border-dashed py-2 text-fs-sm transition-colors"
            onClick={() => setDraft({ ...EMPTY_DRAFT })}
          >
            + 新增条目
          </button>
        )}

        {/* 新建世界书 */}
        <div className="border-border bg-surface rounded-card border p-4">
          <p className="font-display text-fs-h3 text-muted">新建世界书</p>
          <div className="mt-2 flex gap-2">
            <input
              className="border-border-strong bg-surface-2 text-fg rounded-btn flex-1 border px-3 py-2 text-fs-sm outline-none"
              placeholder="例如：协会通史（可挂给多位会长）"
              value={newBookName}
              onChange={(e) => setNewBookName(e.target.value)}
            />
            <button
              type="button"
              disabled={busy || !newBookName.trim()}
              className="border-accent-line text-accent hover:bg-accent-soft rounded-btn border px-3 text-fs-sm transition-colors disabled:opacity-40"
              onClick={createNewBook}
            >
              新建
            </button>
          </div>
        </div>

        {/* P9：把某位会长的世界书整本复制给另一位会长 */}
        <div className="border-border bg-surface rounded-card border p-4">
          <p className="font-display text-fs-h3 text-muted">复制某位会长的世界书</p>
          <p className="text-fs-micro text-muted mt-0.5 leading-relaxed">
            把「来源」会长挂载的所有世界书整本复制给「目标」会长（原书不动）。
          </p>
          <div className="mt-2 flex items-center gap-2">
            <select
              className="border-border-strong bg-surface-2 text-fg rounded-btn min-w-0 flex-1 border px-2 py-2 text-fs-sm outline-none"
              value={cloneFrom}
              onChange={(e) => setCloneFrom(e.target.value)}
            >
              <option value="">来源会长…</option>
              {masters.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            <span className="text-fs-micro text-muted">→</span>
            <select
              className="border-border-strong bg-surface-2 text-fg rounded-btn min-w-0 flex-1 border px-2 py-2 text-fs-sm outline-none"
              value={cloneTo}
              onChange={(e) => setCloneTo(e.target.value)}
            >
              <option value="">目标会长…</option>
              {masters.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            disabled={busy || !cloneFrom || !cloneTo || cloneFrom === cloneTo}
            className="border-accent-line text-accent hover:bg-accent-soft rounded-btn mt-2 w-full border py-2 text-fs-sm transition-colors disabled:opacity-40"
            onClick={cloneBooks}
          >
            复制
          </button>
        </div>

        {/* 追加导入 */}
        {book && (
          <div className="border-border bg-surface rounded-card border p-4">
            <p className="font-display text-fs-h3 text-muted">追加导入世界书</p>
            <p className="text-fs-micro text-muted mt-0.5 leading-relaxed">
              粘贴独立世界书 JSON（lorebook_v3 或含 entries 的对象/数组），追加到「{book.name}」。
            </p>
            <textarea
              className="border-border-strong bg-surface-2 text-fg rounded-btn mt-2 min-h-20 w-full border px-3 py-2 text-fs-sm outline-none"
              placeholder='{"entries":[{"keys":["钟楼"],"content":"…"}]}'
              value={importJson}
              onChange={(e) => setImportJson(e.target.value)}
            />
            <button
              type="button"
              disabled={busy || !importJson.trim()}
              className="border-accent-line text-accent hover:bg-accent-soft rounded-btn mt-2 w-full border py-2 text-fs-sm transition-colors disabled:opacity-40"
              onClick={importBook}
            >
              追加
            </button>
          </div>
        )}
      </div>

      <BottomNav />

      {promptState && (
        <PromptDialog
          title={promptState.title}
          label={promptState.label}
          initialValue={promptState.value}
          busy={promptState.busy}
          onSubmit={promptState.onSubmit}
          onCancel={() => setPromptState(null)}
        />
      )}
      {confirmState && (
        <ConfirmDialog
          title={confirmState.title}
          description={confirmState.description}
          confirmLabel={confirmState.confirmLabel}
          onConfirm={confirmState.onConfirm}
          onCancel={() => setConfirmState(null)}
        />
      )}
    </main>
  );
}
