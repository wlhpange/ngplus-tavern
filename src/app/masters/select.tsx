"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import BottomNav from "@/components/BottomNav";
import ConfirmDialog from "@/components/ConfirmDialog";
import Avatar from "@/components/Avatar";
import ChatText from "@/components/ChatText";
import ImportTranslateDialog from "@/components/ImportTranslateDialog";
import PetDesigner, { defaultDescriptor } from "@/components/PetDesigner";
import PixelPet from "@/components/PixelPet";
import type { PetDescriptor } from "@/lib/petCatalog";

interface PendingImport {
  card: unknown;
  name: string;
  fields: number;
  entries: number;
}

/** /api/masters/forge 返回的完整人格卡（用于回填表单 + 落库时携带） */
interface ForgedCard {
  name?: string;
  self_intro?: string;
  description?: string;
  personality?: string[];
  scenario?: string;
  first_mes?: string;
  tags?: string[];
  [key: string]: unknown;
}

interface MasterItem {
  id: string;
  name: string;
  /** 头像 URL（卡 PNG / 上传）；null = 首字兜底 */
  avatar?: string | null;
  /** 像素小人形象参数；null = 未设置 */
  sprite?: PetDescriptor | null;
  selfIntro: string;
  backstory: string;
  tags?: string[];
  isOfficial?: boolean;
  isCustom?: boolean;
}

/**
 * 新增会长的落库入口。
 * V2.0：风格字段已下线，新增表单不再涉及它。
 */

export default function MastersPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  /** 第二幕（冷启动选人）：带 ?first=1 进来 */
  const isFirstArrival = searchParams.get("first") === "1";
  const [masters, setMasters] = useState<MasterItem[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [intimacyLabel, setIntimacyLabel] = useState("初识");
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  /** V2.0 AI 生成：按用户已填的任意字段补全（不落库，先回填表单让用户确认） */
  const [generating, setGenerating] = useState(false);
  const [forgeMsg, setForgeMsg] = useState<string | null>(null);
  /** AI 锻造结果：落库时随表单提交，保留 speech / backstory 等丰富字段 */
  const [forgedPersona, setForgedPersona] = useState<Record<string, unknown> | null>(null);
  /** 新增会长 · 手填卡字段 */
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newPersonality, setNewPersonality] = useState("");
  const [newScenario, setNewScenario] = useState("");
  const [newFirstMes, setNewFirstMes] = useState("");
  const [newTags, setNewTags] = useState("");
  const [creating, setCreating] = useState(false);
  /** 新增会长 · 可选头像（先上传拿到文件名，落库时带上） */
  const [newAvatarFile, setNewAvatarFile] = useState<string | null>(null);
  const [newAvatarPreview, setNewAvatarPreview] = useState<string | null>(null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  /** 点「设置/更换头像」的目标会长 id（配合一个隐藏 file input 复用） */
  const [avatarTarget, setAvatarTarget] = useState<string | null>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  /** 导入卡 PNG 的临时头像文件名（预览时已存好，落库后回填到会长） */
  const cardAvatarRef = useRef<string | null>(null);
  /** 像素小人形象：正在编辑的会长 id + 草稿 */
  const [spriteEditorFor, setSpriteEditorFor] = useState<string | null>(null);
  const [spriteDraft, setSpriteDraft] = useState<PetDescriptor | null>(null);
  const [spriteSaving, setSpriteSaving] = useState(false);
  /** P5：正在导入角色卡 */
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  /** P11 导入翻译确认弹窗 */
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  /** P11 正在翻译（进度浮层） */
  const [translating, setTranslating] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  const [elapsed, setElapsed] = useState(0);
  const jobRef = useRef<string | null>(null);
  /** P1：正在归档（软删除）的自定义会长 */
  const [deleting, setDeleting] = useState<string | null>(null);
  /** 归档会长前的应用内确认弹窗 */
  const [removeTarget, setRemoveTarget] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    fetch("/api/masters")
      .then((r) => r.json())
      .then((d) => {
        setMasters(d.masters ?? []);
        setActiveId(d.activeMasterId ?? null);
        if (d.intimacyLabel) setIntimacyLabel(d.intimacyLabel);
      })
      .catch(() => setMasters([]));
  }, []);

  async function choose(id: string) {
    if (switching || id === activeId) return;
    setSwitching(id);
    setError(null);
    try {
      const res = await fetch("/api/masters/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ masterId: id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "交接仪式出了点状况。");
        return;
      }
      setActiveId(id);
      if (data.intimacyLabel) setIntimacyLabel(data.intimacyLabel);
      // 冷启动第二幕结束：标记完成，下次直接进对话（幂等）
      if (isFirstArrival) {
        await fetch("/api/onboarding/complete", { method: "POST" }).catch(() => {});
      }
    } catch {
      setError("网络不通，没能完成交接。");
    } finally {
      setSwitching(null);
    }
  }

  /** 上传头像（新增会长表单用） */
  async function uploadNewAvatar(file: File) {
    if (avatarUploading) return;
    setAvatarUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/assets/upload?kind=avatar", { method: "POST", body: form });
      const d = await res.json();
      if (!res.ok || d.error) {
        setError(d.error ?? "头像上传失败。");
        return;
      }
      setNewAvatarFile(d.file as string);
      setNewAvatarPreview(`/api/assets/avatar/${d.file}`);
    } catch {
      setError("网络不通，头像没传上。");
    } finally {
      setAvatarUploading(false);
    }
  }

  /** 把（已上传 / 导入预览得到的）头像回填到某位会长 */
  async function assignAvatar(masterId: string, file: string | null) {
    if (!file) return;
    try {
      await fetch("/api/masters/avatar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ masterId, file }),
      });
    } catch {
      /* 头像回填失败不阻断导入 / 新增 */
    }
  }

  /** 按角色卡描述自动生成像素小人形象（后台跑、不阻塞；完成后刷新列表让小人出现） */
  function ensureSprite(masterId: string) {
    void (async () => {
      try {
        await fetch("/api/masters/sprite/auto", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ masterId }),
        });
        const fresh = await fetch("/api/masters").then((r) => r.json());
        setMasters(fresh.masters ?? []);
      } catch {
        /* 自动形象失败不阻断导入 / 新增 */
      }
    })();
  }

  /** 保存手动调好的形象 */
  async function saveSprite(masterId: string, sprite: PetDescriptor) {
    if (spriteSaving) return;
    setSpriteSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/masters/sprite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ masterId, sprite }),
      });
      const d = await res.json();
      if (!res.ok || d.error) {
        setError(d.error ?? "保存形象失败。");
        return;
      }
      setMasters((prev) =>
        (prev ?? []).map((m) => (m.id === masterId ? { ...m, sprite: d.sprite as PetDescriptor } : m)),
      );
      setSpriteEditorFor(null);
    } catch {
      setError("网络不通，形象没保存。");
    } finally {
      setSpriteSaving(false);
    }
  }

  /** 清除某位会长的头像（回落名字首字） */
  async function clearAvatar(masterId: string) {
    if (avatarUploading) return;
    setAvatarUploading(true);
    setError(null);
    try {
      await fetch("/api/masters/avatar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ masterId, file: null }),
      });
      const fresh = await fetch("/api/masters").then((r) => r.json());
      setMasters(fresh.masters ?? []);
    } catch {
      setError("网络不通，头像没清掉。");
    } finally {
      setAvatarUploading(false);
    }
  }

  /** 给某位已有会长上传并设置头像 */
  async function changeAvatar(masterId: string, file: File) {
    if (avatarUploading) return;
    setAvatarUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const up = await fetch("/api/assets/upload?kind=avatar", { method: "POST", body: form });
      const ud = await up.json();
      if (!up.ok || ud.error) {
        setError(ud.error ?? "头像上传失败。");
        return;
      }
      await assignAvatar(masterId, ud.file as string);
      const fresh = await fetch("/api/masters").then((r) => r.json());
      setMasters(fresh.masters ?? []);
    } catch {
      setError("网络不通，头像没换成。");
    } finally {
      setAvatarUploading(false);
      setAvatarTarget(null);
    }
  }

  /** 新增会长 · 手填卡字段 → 落库 → 上岗 */
  async function createByFields() {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/masters/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          card: {
            name: newName,
            description: newDescription,
            personality: newPersonality,
            scenario: newScenario,
            firstMes: newFirstMes,
            greetings: "",
            tags: newTags,
            avatar: newAvatarFile,
          },
          // 若用过 AI 生成，携带完整人格（保留 speech / backstory 等丰富字段）；
          // 表单里能看到的字段以当前填写为准（服务端会用表单值覆盖）。
          persona: forgedPersona,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setError(data.error ?? "新增失败。");
        return;
      }
      resetForm();
      await choose(data.masterId);
      await ensureSprite(data.masterId);
      const fresh = await fetch("/api/masters").then((r) => r.json());
      setMasters(fresh.masters ?? []);
    } catch {
      setError("网络不通，没能新增。");
    } finally {
      setCreating(false);
    }
  }

  function resetForm() {
    setInviteOpen(false);
    setNewName("");
    setNewDescription("");
    setNewPersonality("");
    setNewScenario("");
    setNewFirstMes("");
    setNewTags("");
    setForgeMsg(null);
    setForgedPersona(null);
    setNewAvatarFile(null);
    setNewAvatarPreview(null);
  }

  /**
   * AI 生成（V2.0）：把用户在名字/描述/性格/场景/开场白/标签里已填的内容发给
   * /api/masters/forge，按这些内容补全整张卡。已填的框原样保留，只补空框；
   * 结果回填表单，用户确认后再点「创建这位会长」落库上岗。
   */
  async function generateByAi() {
    if (generating || creating) return;
    setGenerating(true);
    setError(null);
    setForgeMsg(null);
    try {
      const res = await fetch("/api/masters/forge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName,
          description: newDescription,
          personality: newPersonality,
          scenario: newScenario,
          firstMes: newFirstMes,
          tags: newTags,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setError(data.error ?? "AI 没能生成，请再试一次。");
        return;
      }
      const card = data.card as ForgedCard;
      // 只补空框：用户写过的内容原样保留
      if (!newName.trim()) setNewName(card.name ?? "");
      if (!newDescription.trim())
        setNewDescription(card.description ?? card.self_intro ?? "");
      if (!newPersonality.trim()) setNewPersonality((card.personality ?? []).join("，"));
      if (!newScenario.trim()) setNewScenario(card.scenario ?? "");
      if (!newFirstMes.trim()) setNewFirstMes(card.first_mes ?? "");
      if (!newTags.trim()) setNewTags((card.tags ?? []).join("，"));
      setForgedPersona(card);
      setForgeMsg("已根据你填的内容补全，检查一下，没问题就点「创建这位会长」。");
    } catch {
      setError("网络不通，AI 没能生成。");
    } finally {
      setGenerating(false);
    }
  }

  /** P1 归档（软删除）自定义会长：官方与在任者不可删 */
  async function remove(id: string) {
    if (deleting || switching) return;
    setDeleting(id);
    setError(null);
    try {
      const res = await fetch("/api/masters/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ masterId: id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "删除失败。");
        return;
      }
      setMasters((prev) => (prev ?? []).filter((m) => m.id !== id));
    } catch {
      setError("网络不通，没能删除。");
    } finally {
      setDeleting(null);
    }
  }

  /** P5/P11 导入角色卡（.json / .png）：先预览，若有外语则弹窗询问是否翻译 */
  async function importCard(file: File) {
    if (importing) return;
    setImporting(true);
    setError(null);
    setImportMsg(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/masters/import?preview=1", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok || data.error) {
        setError(data.error ?? "导入失败。");
        return;
      }
      const pv = data.preview;
      // 酒馆式：PNG 卡的整张图已在预览时存好，落库成功后回填为头像
      cardAvatarRef.current = pv?.avatarFile ?? null;
      if (pv?.needed) {
        // 有外语提示词 → 弹窗询问
        setPendingImport({ card: pv.card, name: pv.name, fields: pv.fields, entries: pv.entries });
        return;
      }
      // 无需翻译，直接落库
      await commitImport(pv?.card, false);
    } catch {
      setError("网络不通，导入失败。");
    } finally {
      setImporting(false);
    }
  }

  /** 落库（可带翻译） */
  async function commitImport(card: unknown, translate: boolean, signal?: AbortSignal) {
    try {
      const res = await fetch("/api/masters/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ card, translate }),
        signal,
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setError(data.error ?? "导入失败。");
        return;
      }
      const t = data.translated;
      const extra =
        translate && t && (t.fields || t.entries)
          ? `（已翻译 ${t.fields} 处字段${t.entries ? `、${t.entries} 条世界书` : ""}）`
          : "";
      setImportMsg(
        `已请来「${data.name}」（${data.spec}），世界书词条 ${data.worldBookEntries ?? 0} 条${extra}`,
      );
      const mid = (data.masterId ?? data.id) as string | undefined;
      if (mid && cardAvatarRef.current) {
        await assignAvatar(mid, cardAvatarRef.current);
        cardAvatarRef.current = null;
      }
      if (mid) await ensureSprite(mid);
      const fresh = await fetch("/api/masters").then((r) => r.json());
      setMasters(fresh.masters ?? []);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        setImportMsg("已取消翻译，角色卡未导入。");
        return;
      }
      setError("网络不通，导入失败。");
    }
  }

  /** 弹窗选择后继续导入 */
  async function onTranslateChoice(translate: boolean) {
    const pending = pendingImport;
    setPendingImport(null);
    if (!pending) return;
    if (!translate) {
      // 保持原文：直接落库
      setImporting(true);
      await commitImport(pending.card, false);
      setImporting(false);
      return;
    }
    // 翻译：启动后台任务 + 轮询进度
    setTranslating(true);
    setProgress({ done: 0, total: 0 });
    try {
      const startRes = await fetch("/api/masters/import/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ card: pending.card }),
      });
      const startData = await startRes.json();
      if (!startRes.ok || startData.error) {
        setError(startData.error ?? "启动翻译失败。");
        return;
      }
      const jobId: string = startData.jobId;
      jobRef.current = jobId;
      // 轮询
      for (;;) {
        await new Promise((r) => setTimeout(r, 700));
        if (jobRef.current === null) return; // 用户取消
        const d = await fetch(`/api/masters/import/translate?jobId=${jobId}`).then((r) => r.json());
        if (d.error) {
          setError(d.error);
          return;
        }
        setProgress({ done: d.done ?? 0, total: d.total ?? 0 });
        if (d.status === "done") {
          const res = d.result ?? {};
          setImportMsg(
            `已请来「${res.name}」（v2/v3），世界书词条 ${res.worldBookEntries ?? 0} 条（已翻译）`,
          );
          const mid = res.masterId as string | undefined;
          if (mid && cardAvatarRef.current) {
            await assignAvatar(mid, cardAvatarRef.current);
            cardAvatarRef.current = null;
          }
          if (mid) await ensureSprite(mid);
          const fresh = await fetch("/api/masters").then((r) => r.json());
          setMasters(fresh.masters ?? []);
          return;
        }
        if (d.status === "cancelled") {
          setImportMsg("已取消翻译，角色卡未导入。");
          return;
        }
        if (d.status === "error") {
          setError(d.error ?? "翻译失败。");
          return;
        }
      }
    } catch {
      setError("网络不通，翻译失败。");
    } finally {
      jobRef.current = null;
      setTranslating(false);
    }
  }

  /** 取消正在进行的翻译 */
  async function cancelImport() {
    const jobId = jobRef.current;
    jobRef.current = null; // 让轮询退出
    setTranslating(false);
    if (jobId) {
      await fetch("/api/masters/import/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, action: "cancel" }),
      }).catch(() => {});
    }
  }

  // P11 翻译进度计时
  useEffect(() => {
    if (!translating) {
      setElapsed(0);
      return;
    }
    const start = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [translating]);

  /** 第二幕"不选也行"：默认薇拉执掌（persona §5 零配置兜底） */
  async function keepDefault() {
    if (switching) return;
    await fetch("/api/onboarding/complete", { method: "POST" }).catch(() => {});
    router.push("/");
  }

  /** 冷启动第二幕 = 从推门进来；更换会长 = 已有档案后再来 */
  const isFirstPick = isFirstArrival || activeId === null;

  /** 任意一栏有内容 → 「AI 生成」按钮亮起可点 */
  const hasSomeField = Boolean(
    newName.trim() ||
      newDescription.trim() ||
      newPersonality.trim() ||
      newScenario.trim() ||
      newFirstMes.trim() ||
      newTags.trim(),
  );

  return (
    <main className="mx-auto flex h-dvh max-w-md flex-col bg-bg text-fg">
      <header className="border-b border-border px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="font-display text-fs-h1 leading-tight">
              {isFirstPick ? "这间协会在等它的主人" : "更换会长"}
            </h1>
            <p className="mt-0.5 text-fs-micro leading-relaxed text-muted">
              {isFirstPick
                ? "你想让它落在谁手里？不选也没关系——协会默认由薇拉执掌。"
                : `换人是游戏内事件：记忆保留；每位会长各有自己的好感（当前：${intimacyLabel}）`}
            </p>
          </div>
          {/* 日常入口在设置页（低频重操作），这里给一条退路 */}
          {!isFirstPick && (
            <button
              type="button"
              onClick={() => router.push("/settings")}
              className="rounded-btn shrink-0 border border-border-strong px-3 py-1.5 text-fs-sm text-fg transition-colors hover:bg-surface-2"
            >
              返回设置
            </button>
          )}
        </div>
      </header>

      <div className="relative flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {error && (
          <div className="rounded-tile border border-danger bg-surface-2 px-4 py-3 text-fs-body text-danger-text">
            {error}
          </div>
        )}
        {masters === null && (
          <p className="mt-10 text-center text-fs-sm text-muted">
            候选人们正在赶来……
          </p>
        )}
        {masters?.map((m) => {
          const isActive = m.id === activeId;
          return (
            <article
              key={m.id}
              className={`relative rounded-card border p-4 bg-surface transition-colors duration-200 ${
                isActive
                  ? "border-gold-line"
                  : "border-border hover:border-border-strong"
              }`}
              style={isActive ? { boxShadow: "var(--inset-gold)" } : undefined}
            >
              {isActive && (
                <span className="absolute right-3 top-3 rotate-3 rounded-full border border-gold-line bg-gold-soft px-2 py-0.5 font-numeric text-fs-micro text-gold">
                  现任
                </span>
              )}
              <div className="flex items-center gap-3">
                {/* 头像圆章：现任金淡底金描边，其余 surface-3 底 + 宋体首字；有卡图则直接显示 */}
                <Avatar
                  src={m.avatar}
                  name={m.name}
                  className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full font-display text-lg ${
                    isActive
                      ? "border border-gold-line bg-gold-soft text-gold"
                      : "bg-surface-3 text-fg"
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <span className="font-display text-fs-h3">{m.name}</span>
                  {/* 用 div 包 ChatText：它内部是 div+markdown 的 <p>，套在外层 <p> 里会非法嵌套（hydration 报错） */}
                  <div className="mt-0.5 text-fs-sm leading-relaxed text-fg">
                    <ChatText text={m.selfIntro} />
                  </div>
                </div>
                {m.sprite && <PixelPet descriptor={m.sprite} display={56} className="ml-auto shrink-0" />}
              </div>
              {m.backstory && (
                <div className="mt-2 text-fs-micro leading-relaxed text-muted line-clamp-3">
                  <ChatText text={m.backstory} />
                </div>
              )}
              {!isActive && (
                <button
                  className="mt-3 w-full rounded-btn border border-accent-line py-2 text-fs-sm text-accent transition-colors hover:bg-accent-soft disabled:opacity-40"
                  disabled={switching !== null}
                  onClick={() => choose(m.id)}
                >
                  {isFirstPick ? `请 ${m.name} 执掌协会` : `换成 ${m.name}`}
                </button>
              )}
              {isActive && (
                <button
                  className="mt-3 w-full rounded-btn border border-gold-line py-2 text-fs-sm text-gold opacity-70"
                  disabled
                >
                  当前会长
                </button>
              )}
              {/* 头像：酒馆式一张图即头像（任何会长都可设置 / 更换 / 清除） */}
              <div className="mt-2 flex items-center justify-center gap-4 text-fs-micro">
                <button
                  type="button"
                  className="text-muted hover:text-fg py-1 transition-colors disabled:opacity-40"
                  disabled={avatarUploading || switching !== null}
                  onClick={() => {
                    setAvatarTarget(m.id);
                    avatarInputRef.current?.click();
                  }}
                >
                  {avatarUploading && avatarTarget === m.id
                    ? "正在上传……"
                    : m.avatar
                      ? "更换头像"
                      : "设置头像"}
                </button>
                {m.avatar && (
                  <button
                    type="button"
                    className="text-muted hover:text-danger-text py-1 transition-colors disabled:opacity-40"
                    disabled={avatarUploading || switching !== null}
                    onClick={() => void clearAvatar(m.id)}
                  >
                    清除头像
                  </button>
                )}
              </div>
              {/* 像素小人形象：AI 按卡描述生成过，也可手动改 */}
              <div className="mt-1 flex items-center justify-center">
                <button
                  type="button"
                  className="text-muted hover:text-fg py-1 text-fs-micro transition-colors"
                  onClick={() => {
                    setSpriteEditorFor((v) => (v === m.id ? null : m.id));
                    setSpriteDraft(m.sprite ?? defaultDescriptor());
                  }}
                >
                  {m.sprite ? "修改形象" : "生成形象"}
                </button>
              </div>
              {spriteEditorFor === m.id && spriteDraft && (
                <div className="border-border mt-2 space-y-2 border-t pt-3">
                  <PetDesigner
                    value={spriteDraft}
                    onChange={setSpriteDraft}
                    display={128}
                    showAnimationSwitch
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="bg-accent text-on-accent rounded-btn flex-1 py-1.5 text-fs-sm font-medium transition-transform active:scale-95 disabled:opacity-40"
                      disabled={spriteSaving}
                      onClick={() => void saveSprite(m.id, spriteDraft)}
                    >
                      {spriteSaving ? "保存中……" : "保存形象"}
                    </button>
                    <button
                      type="button"
                      className="border-border-strong text-muted hover:text-fg rounded-btn border px-3 py-1.5 text-fs-sm transition-colors"
                      onClick={() => setSpriteEditorFor(null)}
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}
              {/* P1：自己请来的会长可删除（归档，不动历史）；官方与在任者不可删 */}
              {!isActive && m.isCustom && (
                <button
                  type="button"
                  className="text-muted hover:text-danger-text mt-2 w-full py-1 text-center text-fs-micro transition-colors disabled:opacity-40"
                  disabled={deleting !== null || switching !== null}
                  onClick={() => setRemoveTarget({ id: m.id, name: m.name })}
                >
                  {deleting === m.id ? "正在归档……" : "删除这位会长"}
                </button>
              )}
            </article>
          );
        })}

        {/* 新增会长：手填卡字段（与导入卡同一套字段）+ 可选 AI 一键生成 */}
        {masters !== null && (
          <div className="rounded-card border border-dashed border-border-strong bg-surface p-4">
            <button
              type="button"
              className="flex w-full items-center gap-3 text-left"
              onClick={() => setInviteOpen((v) => !v)}
              disabled={generating}
            >
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-dashed border-border text-lg text-muted">
                ✎
              </span>
              <div className="flex-1">
                <p className="font-display text-fs-h3 text-muted">新增会长</p>
                <p className="mt-0.5 text-fs-micro leading-relaxed text-muted">
                  填一张会长卡：名字、描述、性格、场景、开场白。填不动就让 AI 按你写的补全。
                </p>
              </div>
            </button>
            {inviteOpen && (
              <div className="mt-3 space-y-2.5">
                <input
                  className="border-border-strong bg-surface-2 text-fg placeholder:text-faint focus:border-accent w-full rounded-btn border px-3 py-2 text-fs-sm outline-none transition-colors"
                  placeholder="名字（40 字以内）"
                  maxLength={40}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
                {/* 可选头像（酒馆式：一张图即头像） */}
                <div className="flex items-center gap-3">
                  <Avatar
                    src={newAvatarPreview}
                    name={newName || "?"}
                    className="border-border-strong bg-surface-3 text-muted flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-dashed text-fs-body"
                  />
                  <label className="border-border-strong text-muted hover:text-fg rounded-btn cursor-pointer border px-3 py-1.5 text-fs-micro transition-colors">
                    {avatarUploading
                      ? "上传中……"
                      : newAvatarFile
                        ? "更换头像"
                        : "上传头像（可选）"}
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      disabled={avatarUploading}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void uploadNewAvatar(f);
                        e.target.value = "";
                      }}
                    />
                  </label>
                  {newAvatarFile && (
                    <button
                      type="button"
                      className="text-fs-micro text-muted hover:text-danger-text transition-colors"
                      onClick={() => {
                        setNewAvatarFile(null);
                        setNewAvatarPreview(null);
                      }}
                    >
                      移除
                    </button>
                  )}
                </div>
                <textarea
                  className="border-border-strong bg-surface-2 text-fg placeholder:text-faint focus:border-accent min-h-20 w-full rounded-btn border px-3 py-2 text-fs-sm leading-relaxed outline-none transition-colors"
                  placeholder="描述（ta 是谁、什么来历）"
                  maxLength={2000}
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                />
                <input
                  className="border-border-strong bg-surface-2 text-fg placeholder:text-faint focus:border-accent w-full rounded-btn border px-3 py-2 text-fs-sm outline-none transition-colors"
                  placeholder="性格（逗号分隔，如：爽朗、精明、护短）"
                  maxLength={400}
                  value={newPersonality}
                  onChange={(e) => setNewPersonality(e.target.value)}
                />
                <textarea
                  className="border-border-strong bg-surface-2 text-fg placeholder:text-faint focus:border-accent min-h-16 w-full rounded-btn border px-3 py-2 text-fs-sm leading-relaxed outline-none transition-colors"
                  placeholder="场景（此刻你们在哪里、在做什么）"
                  maxLength={800}
                  value={newScenario}
                  onChange={(e) => setNewScenario(e.target.value)}
                />
                <textarea
                  className="border-border-strong bg-surface-2 text-fg placeholder:text-faint focus:border-accent min-h-16 w-full rounded-btn border px-3 py-2 text-fs-sm leading-relaxed outline-none transition-colors"
                  placeholder="开场白（ta 见你第一句话）"
                  maxLength={800}
                  value={newFirstMes}
                  onChange={(e) => setNewFirstMes(e.target.value)}
                />
                <input
                  className="border-border-strong bg-surface-2 text-fg placeholder:text-faint focus:border-accent w-full rounded-btn border px-3 py-2 text-fs-sm outline-none transition-colors"
                  placeholder="标签（逗号分隔，可留空）"
                  maxLength={200}
                  value={newTags}
                  onChange={(e) => setNewTags(e.target.value)}
                />
                {/* AI 生成：按上面任意已填的栏补全其余（只补空框，不覆盖你写的） */}
                <div className="border-t border-border pt-2.5">
                  <button
                    type="button"
                    className="border-accent-line text-accent hover:bg-accent-soft flex w-full items-center justify-center gap-2 rounded-btn border py-2 text-fs-sm transition-colors disabled:border-border disabled:text-faint disabled:opacity-60"
                    disabled={generating || creating || !hasSomeField}
                    onClick={generateByAi}
                  >
                    {generating ? (
                      <>
                        <span className="vn-typing" aria-hidden>
                          <i />
                          <i />
                          <i />
                        </span>
                        AI 正在锻造人格卡……
                      </>
                    ) : (
                      "✦ AI 生成（按你填的内容补全其余）"
                    )}
                  </button>
                  <p className="text-fs-micro text-faint mt-1.5 leading-relaxed">
                    上面任意一栏填了字就能生成：只填名字就按名字起，只填场景就按场景起，
                    多填几栏会一起参考。你写过的框保持不变，AI 只补空着的。
                  </p>
                  {forgeMsg && (
                    <p className="text-success mt-1.5 text-fs-micro leading-relaxed">
                      {forgeMsg}
                    </p>
                  )}
                </div>

                <button
                  type="button"
                  className="bg-accent text-on-accent w-full rounded-btn py-2 text-fs-sm font-medium transition-transform active:scale-95 disabled:opacity-40"
                  disabled={
                    creating || !newName.trim() || (!newDescription.trim() && !newFirstMes.trim())
                  }
                  onClick={createByFields}
                >
                  {creating ? "正在落库……" : "创建这位会长"}
                </button>
              </div>
            )}
          </div>
        )}

        {/* P5 导入角色卡：把酒馆生态的卡请进协会（V1–V3，.json / .png） */}
        {masters !== null && (
          <div className="rounded-card border border-dashed border-border-strong bg-surface p-4">
            <p className="font-display text-fs-h3 text-muted">导入角色卡</p>
            <p className="mt-0.5 text-fs-micro leading-relaxed text-muted">
              支持酒馆的 Character Card（.json / .png，V1–V3）；卡里的世界书会一并导入。
            </p>
            <label className="border-accent-line text-accent hover:bg-accent-soft mt-3 flex w-full cursor-pointer items-center justify-center rounded-btn border py-2 text-fs-sm transition-colors">
              {importing ? "正在导入……" : "选择角色卡文件"}
              <input
                type="file"
                accept=".json,.png,application/json,image/png"
                className="hidden"
                disabled={importing}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void importCard(f);
                  e.target.value = "";
                }}
              />
            </label>
            {importMsg && (
              <p className="text-success mt-2 text-fs-micro leading-relaxed">{importMsg}</p>
            )}
          </div>
        )}
      </div>

      {isFirstPick && masters !== null && (
        <div className="border-t border-border px-4 py-3">
          <button
            className="w-full py-1 text-center text-fs-micro text-muted transition-colors hover:text-fg disabled:opacity-40"
            disabled={switching !== null}
            onClick={keepDefault}
          >
            先不选，直接进门（协会默认由薇拉执掌）
          </button>
        </div>
      )}

      <BottomNav />

      {/* §6.5 交接瞬间：全局禁用浮层（bg 72% + blur + 金徽记），aria-busy 标注。
          用 fixed 铺满视口，避免落在滚动容器里只能遮住可见区、且底下的列表还能滑。 */}
      {switching !== null && (
        <div
          aria-busy="true"
          className="fixed inset-0 z-50 flex touch-none flex-col items-center justify-center gap-3 backdrop-blur-sm"
          style={{ background: "color-mix(in oklch, var(--bg) 72%, transparent)" }}
        >
          <span
            aria-hidden
            className="flex h-12 w-12 items-center justify-center rounded-full border border-gold-line font-display text-gold shadow-glow-gold"
          >
            ✦
          </span>
          <p className="font-numeric text-fs-sm tracking-widest text-gold">
            交接仪式进行中……
          </p>
        </div>
      )}

      {/* P11 导入翻译确认弹窗 */}
      {pendingImport && (
        <ImportTranslateDialog
          cardName={pendingImport.name}
          fields={pendingImport.fields}
          entries={pendingImport.entries}
          onChoose={onTranslateChoice}
          onCancel={() => setPendingImport(null)}
        />
      )}

      {/* P11 翻译进度浮层：真进度条 + 耗时 + 取消 */}
      {translating && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-6"
          style={{ background: "color-mix(in oklch, var(--bg) 78%, transparent)" }}
        >
          <div className="border-gold-line bg-surface rounded-card w-full max-w-sm border p-4 text-center">
            <p className="text-fs-body">正在翻译角色卡……</p>
            <p className="text-gold font-numeric text-fs-sm mt-1">
              {progress.total > 0 ? `${progress.done} / ${progress.total} 段` : "准备中……"} · {elapsed}s
            </p>
            {/* 进度条 */}
            <div className="bg-surface-3 mt-3 h-2 w-full overflow-hidden rounded-full">
              <div
                className="bg-gold h-full rounded-full transition-all duration-300"
                style={{
                  width:
                    progress.total > 0
                      ? `${Math.min(100, Math.round((progress.done / progress.total) * 100))}%`
                      : "10%",
                }}
              />
            </div>
            <p className="text-fs-micro text-faint mt-2 leading-relaxed">
              逐段忠实翻译（含世界书）。用较快的模型会明显更快。
            </p>
            <button
              type="button"
              className="border-border-strong text-muted hover:text-fg rounded-btn mt-3 w-full border py-2 text-fs-sm transition-colors"
              onClick={cancelImport}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* 复用式头像选择器（点卡片上的「设置/更换头像」触发） */}
      <input
        ref={avatarInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          const id = avatarTarget;
          if (f && id) void changeAvatar(id, f);
        }}
      />
      {/* 归档会长确认（应用内弹窗） */}
      {removeTarget && (
        <ConfirmDialog
          title="删除这位会长？"
          description={`「${removeTarget.name}」的交接记录会留在协会卷宗里，但 ta 的酒馆聊天记录会一并删除。`}
          confirmLabel="删除"
          busy={deleting !== null}
          onConfirm={() => {
            const t = removeTarget;
            setRemoveTarget(null);
            void remove(t.id);
          }}
          onCancel={() => setRemoveTarget(null)}
        />
      )}
    </main>
  );
}
