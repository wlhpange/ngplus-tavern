"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import BottomNav from "@/components/BottomNav";
import LetterField, { LETTER_INPUT } from "@/components/LetterField";
import { toast } from "@/components/Toast";
import { playCue, setSoundEnabled, soundEnabled } from "@/lib/audio";
import { petEnabled, setPetEnabled } from "@/lib/pet";
import { registerSecretTap } from "@/lib/secret";

interface ConfigState {
  /** P4 内容尺度设置 */
  rp?: { enabled: boolean };
  /** P12 聊天（酒馆）模式专用会长；null/undefined = 跟随任务会长 */
  chatMasterId?: string | null;
  /** P12 可选会长列表 */
  masters?: { id: string; name: string }[];
}

/** R18 开关的解锁状态（本机记忆）：连点标题区解锁一次后保持 */
const ADULT_UNLOCK_KEY = "ngplus.adult.unlocked";

export default function SettingsClient() {
  const [state, setState] = useState<ConfigState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  /** 本机偏好（localStorage） */
  const [sound, setSound] = useState(true);
  const [pet, setPet] = useState(true);
  /** P4 R18 内容开关（存数据库） */
  const [rpEnabled, setRpEnabled] = useState(false);
  /** P9 冒险者卡 */
  const [upName, setUpName] = useState("");
  const [upBrief, setUpBrief] = useState("");
  const [upDesc, setUpDesc] = useState("");
  /** R18 开关是"暗门"：连点标题小字解锁后显示，解锁状态记在本机 */
  const [adultUnlocked, setAdultUnlocked] = useState(false);
  const secretTaps = useRef<number[]>([]);

  const applyState = useCallback((d: ConfigState) => {
    setState(d);
    setRpEnabled(d.rp?.enabled ?? false);
  }, []);

  const load = useCallback(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d: ConfigState) => applyState(d))
      .catch(() => toast("没能读到设置。", "err"))
      .finally(() => setLoaded(true));
  }, [applyState]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    setSound(soundEnabled());
    setPet(petEnabled());
  }, []);

  // R18"暗门"：读取本机解锁状态（连点标题小字解锁过就显示）
  useEffect(() => {
    setAdultUnlocked(window.localStorage.getItem(ADULT_UNLOCK_KEY) === "1");
  }, []);

  /** 彩蛋：连点设置页标题区（「设置」+ 小字）若干下，解锁R18 开关 */
  function secretTap() {
    const { taps, unlocked } = registerSecretTap(secretTaps.current, Date.now());
    secretTaps.current = taps;
    if (!unlocked || adultUnlocked) return;
    setAdultUnlocked(true);
    window.localStorage.setItem(ADULT_UNLOCK_KEY, "1");
    playCue("scroll");
    toast("……协会的暗门，开了。");
  }

  /** 重新藏起R18 开关（设置本身不变，只是隐藏入口） */
  function hideAdult() {
    setAdultUnlocked(false);
    window.localStorage.removeItem(ADULT_UNLOCK_KEY);
  }

  useEffect(() => {
    fetch("/api/user-persona")
      .then((r) => r.json())
      .then((d: { persona?: { name?: string; brief?: string; description?: string } }) => {
        setUpName(d.persona?.name ?? "");
        setUpBrief(d.persona?.brief ?? "");
        setUpDesc(d.persona?.description ?? "");
      })
      .catch(() => {});
  }, []);

  function toggleSound() {
    const next = !sound;
    setSound(next);
    setSoundEnabled(next);
    if (next) playCue("button");
  }

  function togglePet() {
    const next = !pet;
    setPet(next);
    setPetEnabled(next);
  }

  function toggleRp() {
    post({ action: "saveRp", rpEnabled: !rpEnabled });
  }

  async function saveUserPersona() {
    setBusy("userPersona");
    try {
      const res = await fetch("/api/user-persona", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: upName, brief: upBrief, description: upDesc }),
      });
      const d = await res.json();
      if (!res.ok || d.error) {
        toast(d.error ?? "保存失败。", "err");
        return;
      }
      toast("冒险者卡已记下");
    } catch {
      toast("网络不通，保存失败。", "err");
    } finally {
      setBusy(null);
    }
  }

  async function post(body: Record<string, unknown>) {
    setBusy(String(body.action));
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = (await res.json()) as ConfigState & { error?: string };
      if (!res.ok || d.error) {
        toast(d.error ?? "没办成，请稍后再试。", "err");
        return;
      }
      applyState(d);
      toast("已记下");
    } catch {
      toast("网络不通，请稍后再试。", "err");
    } finally {
      setBusy(null);
    }
  }

  /** 设置首页的入口行（外部二级页） */
  function NavRow({
    href,
    title,
    hint,
  }: {
    href: string;
    title: string;
    hint: string;
  }) {
    return (
      <Link
        href={href}
        className="flex w-full items-center justify-between gap-3 border-b border-border py-2.5"
      >
        <span className="text-fs-sm shrink-0">{title}</span>
        <span className="text-fs-micro text-faint truncate">{hint} ›</span>
      </Link>
    );
  }

  return (
    <main className="mx-auto flex h-dvh max-w-md flex-col bg-bg text-fg">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
        <div
          role="button"
          tabIndex={0}
          aria-label="设置"
          onClick={secretTap}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              secretTap();
            }
          }}
          className="cursor-default select-none text-left"
        >
          <h1 className="font-display text-fs-h1 leading-tight">设置</h1>
          <p className="font-numeric text-fs-micro text-muted tracking-wide">
            协会章程 · 会长与酒馆的规矩都在这
          </p>
        </div>
        </div>
        <Link
          href="/character"
          className="rounded-btn px-2 py-1.5 text-fs-meta text-muted transition-colors hover:text-fg"
        >
          返回面板
        </Link>
      </header>

      <div className="flex-1 space-y-6 overflow-y-auto px-4 py-4">
        {!loaded && (
          <p className="text-muted mt-8 text-center text-sm">正在翻开协会章程……</p>
        )}

        {/* 协会：入口 + 低频开关集中在这里 */}
        <section className="rounded-card border border-border bg-surface p-4">
          <h2 className="mb-2 font-display text-fs-h2">协会</h2>

          <NavRow href="/masters" title="更换会长" hint="各自好感 · 各自记忆书" />
          <NavRow href="/worldbook" title="世界书" hint="角色设定 · 会长专属" />
          <NavRow href="/memory" title="记忆书" hint="长期记忆 · 永久 / 每段对话" />
          <NavRow href="/settings/model" title="模型与渠道" hint="DeepSeek / Go / 本地" />
          <NavRow href="/settings/image" title="生图" hint="OpenAI 兼容接口 · 模型 / 尺寸 / 画风" />

          {/* P12 聊天模式会长：与任务会长解耦；相同则共享记忆书 */}
          <label className="flex w-full items-center justify-between gap-3 border-b border-border py-2.5">
            <span className="text-fs-sm shrink-0">聊天模式会长</span>
            <select
              className="border-border-strong bg-surface-2 text-fg rounded-btn max-w-[55%] border px-2 py-1 text-fs-micro outline-none disabled:opacity-40"
              disabled={busy !== null || !loaded}
              value={state?.chatMasterId ?? ""}
              onChange={(e) =>
                post({ action: "saveChatMaster", chatMasterId: e.target.value || null })
              }
            >
              <option value="" className="bg-surface text-fg">
                跟随任务会长
              </option>
              {(state?.masters ?? []).map((m) => (
                <option key={m.id} value={m.id} className="bg-surface text-fg">
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <p className="text-fs-micro text-faint mt-1 leading-relaxed">
            酒馆（聊天）模式用哪位会长。任务模式与历史归属不受影响；两者相同时共享同一本记忆书。
          </p>

          <button
            type="button"
            onClick={toggleSound}
            aria-pressed={sound}
            className="mt-3 flex w-full items-center justify-between border-t border-border pt-2.5"
          >
            <span className="text-fs-sm">音效</span>
            <span
              className={`rounded-full border px-2 py-0.5 font-numeric text-fs-micro ${
                sound ? "border-gold-line bg-gold-soft text-gold" : "border-border text-faint"
              }`}
            >
              {sound ? "开" : "关"}
            </span>
          </button>

          <button
            type="button"
            onClick={togglePet}
            aria-pressed={pet}
            className="mt-3 flex w-full items-center justify-between border-t border-border pt-2.5"
          >
            <span className="text-fs-sm">对话页像素小人</span>
            <span
              className={`rounded-full border px-2 py-0.5 font-numeric text-fs-micro ${
                pet ? "border-gold-line bg-gold-soft text-gold" : "border-border text-faint"
              }`}
            >
              {pet ? "开" : "关"}
            </span>
          </button>

          {/* P4 R18 内容开关：默认隐藏的"暗门"，连点标题区解锁后才出现；
              但若已开启则始终显示，保证能关掉 */}
          {(adultUnlocked || rpEnabled) && (
            <>
              <button
                type="button"
                onClick={toggleRp}
                aria-pressed={rpEnabled}
                className="mt-3 flex w-full items-center justify-between border-t border-border pt-2.5"
              >
                <span className="text-fs-sm">R18 内容</span>
                <span
                  className={`rounded-full border px-2 py-0.5 font-numeric text-fs-micro ${
                    rpEnabled ? "border-danger bg-surface-2 text-danger-text" : "border-border text-faint"
                  }`}
                >
                  {rpEnabled ? "开" : "关"}
                </span>
              </button>
              <p className="text-fs-micro text-faint mt-1 leading-relaxed">
                开启后，聊天模式注入 Evening-Truth 系解禁准则；配图提炼也会如实定格、不审查。
                {adultUnlocked && (
                  <button
                    type="button"
                    onClick={hideAdult}
                    className="text-faint underline decoration-dotted underline-offset-2 hover:text-muted"
                  >
                    收起
                  </button>
                )}
              </p>
            </>
          )}
        </section>

        {/* P9 冒险者卡：会长卡是"会长是谁"，这张是"你是谁"（两模式共用） */}
        <section className="border-border bg-surface rounded-card border p-4">
          <h2 className="mb-2 font-display text-fs-h2">冒险者卡</h2>
          <p className="text-fs-micro text-muted mb-3 leading-relaxed">
            关于「你」自己的设定。会长在任务与聊天两个模式里都会知道这些。
          </p>
          <div className="space-y-3">
            <LetterField label="称呼">
              <input
                className={LETTER_INPUT}
                placeholder="会长怎么称呼你"
                maxLength={40}
                value={upName}
                onChange={(e) => setUpName(e.target.value)}
              />
            </LetterField>
            <LetterField label="一句话">
              <input
                className={LETTER_INPUT}
                placeholder="例如：一个想重新开始的夜班程序员"
                maxLength={120}
                value={upBrief}
                onChange={(e) => setUpBrief(e.target.value)}
              />
            </LetterField>
            <label className="block">
              <span className="font-numeric text-fs-micro tracking-widest text-muted">背景</span>
              <textarea
                className="border-border-strong bg-surface-2 text-fg rounded-btn mt-1 min-h-20 w-full border px-3 py-2 text-fs-sm leading-relaxed outline-none"
                placeholder="想告诉会长的关于你自己的事"
                maxLength={1000}
                value={upDesc}
                onChange={(e) => setUpDesc(e.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={busy !== null}
              onClick={saveUserPersona}
              className="border-accent-line text-accent hover:bg-accent-soft rounded-btn w-full border py-2 text-fs-sm transition-colors disabled:opacity-40"
            >
              {busy === "userPersona" ? "保存中…" : "保存冒险者卡"}
            </button>
          </div>
        </section>

        <p className="px-1 text-fs-micro leading-relaxed text-muted">
          两个渠道的 Key 从服务端环境变量读取（见 `.env.example`），这里只做本地设置。
        </p>
      </div>

      <BottomNav />
    </main>
  );
}
