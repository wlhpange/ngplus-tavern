"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS: { href: string; label: string; icon: string; center?: boolean }[] = [
  { href: "/quests", label: "委托", icon: "⚑" },
  { href: "/character", label: "面板", icon: "◈" },
  { href: "/", label: "对话", icon: "✦", center: true },
  { href: "/shop", label: "商店", icon: "◆" },
  { href: "/settings", label: "设置", icon: "⚙" },
];

/**
 * 星穹秘契底部导航（DESIGN.md §7.2）：bg 88% + 毛玻璃 + 1px 顶部分割线；
 * 中央「会长对话」是唯一金色实心圆钮——对话是所有玩法的入口。
 */
export default function BottomNav() {
  const pathname = usePathname();
  return (
    <nav className="mx-auto flex w-full max-w-md items-end border-t border-border bg-[color-mix(in_oklch,var(--bg)_88%,transparent)] pb-[env(safe-area-inset-bottom)] backdrop-blur-md">
      {TABS.map((t) => {
        const active =
          t.href === "/"
            ? pathname === "/"
            : pathname === t.href || pathname.startsWith(`${t.href}/`);
        if (t.center) {
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-label="会长对话"
              className="flex flex-1 flex-col items-center"
            >
              <span
                className={`-mt-5 flex h-12 w-12 items-center justify-center rounded-full bg-gold text-lg text-on-gold shadow-glow-gold transition-transform active:translate-y-px ${
                  active ? "" : "opacity-90"
                }`}
              >
                {t.icon}
              </span>
              <span
                className={`mt-0.5 pb-1.5 text-fs-micro tracking-wide ${
                  active ? "text-gold" : "text-muted"
                }`}
              >
                {t.label}
              </span>
            </Link>
          );
        }
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`flex min-h-[44px] flex-1 flex-col items-center gap-0.5 py-2 text-fs-micro tracking-wide ${
              active ? "text-accent" : "text-muted"
            }`}
          >
            <span className="text-base leading-none">{t.icon}</span>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
