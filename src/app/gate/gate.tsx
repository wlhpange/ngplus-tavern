"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * 第一幕 · 推门（onboarding-script.md §2；星穹秘契 §6.4 门开动效）。
 * 紫墨门厅 + 门楣吊灯 + 门缝金光，一句"叮——您已解锁「二周目」"。
 * 没有注册、没有登录、没有协议勾选、没有"教程"字样。
 */
export default function Gate() {
  const router = useRouter();
  const [pushing, setPushing] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    // 已经完成冷启动的用户不该再看到这一幕
    fetch("/api/onboarding/state")
      .then((r) => r.json())
      .then((d) => {
        if (d.onboarded) {
          router.replace("/");
          return;
        }
        setChecking(false);
      })
      .catch(() => setChecking(false));
  }, [router]);

  function pushDoor() {
    if (pushing) return;
    setPushing(true);
    // §6.4：门开 --dur-door(700ms) 后去第二幕：协会虚位以待
    setTimeout(() => router.push("/masters?first=1"), 700);
  }

  if (checking) {
    return (
      <main className="flex h-dvh items-center justify-center bg-bg text-muted">
        <p className="font-numeric text-fs-sm">……</p>
      </main>
    );
  }

  return (
    <main className="relative flex h-dvh flex-col items-center justify-center overflow-hidden bg-bg text-fg">
      {/* 紫墨渐晕：书库深处的光（§3.5 材质声明） */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 120% 80% at 50% -10%, color-mix(in oklch, var(--accent-2) 12%, transparent), transparent 60%)",
        }}
      />

      {/* 顶部徽记 */}
      <p className="mb-8 flex items-center gap-2 rounded-full border border-gold-line bg-surface px-3 py-1 font-numeric text-fs-micro tracking-[0.2em] text-gold">
        <span aria-hidden className="h-1 w-1 rounded-full bg-gold" />
        NG+ · 二周目协会
      </p>

      <p className="mb-3 max-w-[20rem] text-center font-display text-fs-h1 leading-snug">
        叮 —— 您已解锁「二周目」
      </p>
      <p className="mb-12 text-center font-display text-fs-body leading-relaxed text-muted">
        这间协会，专为重新开始的人生服务。
      </p>

      {/* 门（§6.4）：金线外框 + 门楣吊灯 + 木纹门板 + 磨砂窗 + 门缝金光；--dur-door 700ms 开合 */}
      <button
        onClick={pushDoor}
        aria-label="推开协会的门"
        className={`group relative h-72 w-44 transition-all duration-700 ease-out ${
          pushing ? "translate-x-[-6px] rotate-y-12 opacity-0" : "hover:scale-[1.02]"
        }`}
        style={{ perspective: "600px" }}
      >
        {/* 门楣吊灯 */}
        <span
          aria-hidden
          className="absolute -top-4 left-1/2 h-2.5 w-2.5 -translate-x-1/2 rounded-full bg-gold shadow-glow-gold"
        />
        {/* 外框 */}
        <span
          aria-hidden
          className="absolute inset-0 rounded-t-[5rem] border border-gold-line"
          style={{
            background: "linear-gradient(to bottom, var(--surface-2), var(--bg))",
            boxShadow:
              "0 0 40px color-mix(in oklch, var(--gold) 16%, transparent)",
          }}
        />
        {/* 木纹门板（内缩 8px，细竖纹） */}
        <span
          aria-hidden
          className="absolute inset-x-2 bottom-2 top-9 rounded-t-[4rem] border border-border"
          style={{
            background:
              "repeating-linear-gradient(90deg, color-mix(in oklch, var(--border) 55%, transparent) 0 1px, transparent 1px 22px), linear-gradient(to bottom, var(--surface), var(--bg))",
          }}
        />
        {/* 磨砂窗：内里透出暖光 */}
        <span
          aria-hidden
          className="absolute left-1/2 top-16 h-20 w-24 -translate-x-1/2 rounded-tile border border-border-strong backdrop-blur-[2px]"
          style={{
            background:
              "radial-gradient(ellipse at 50% 60%, color-mix(in oklch, var(--gold) 26%, transparent), color-mix(in oklch, var(--surface-3) 70%, transparent) 75%)",
          }}
        />
        {/* 门牌 */}
        <span className="absolute left-1/2 top-[8.5rem] -translate-x-1/2 whitespace-nowrap rounded-chip border border-gold-line bg-bg/80 px-2.5 py-0.5 font-numeric text-fs-micro tracking-widest text-gold">
          二周目协会
        </span>
        {/* 门把手 */}
        <span
          aria-hidden
          className="absolute right-4 top-1/2 h-2.5 w-2.5 rounded-full bg-gold shadow-glow-gold"
        />
        {/* 门缝透出的金光 */}
        <span
          aria-hidden
          className="absolute inset-y-3 right-0 w-[3px] rounded-full"
          style={{ background: "color-mix(in oklch, var(--gold) 60%, transparent)" }}
        />
      </button>

      <p className="mt-10 flex items-center gap-3 font-numeric text-fs-sm tracking-widest text-gold">
        <span aria-hidden className="text-faint">——</span>
        <span className="animate-pulse">{pushing ? "门开了……" : "🚪 推开它"}</span>
        <span aria-hidden className="text-faint">——</span>
      </p>
      <p className="mt-3 text-fs-micro text-faint">不用注册，也不用填任何东西</p>
    </main>
  );
}
