"use client";

import { useCallback, useEffect, useState } from "react";
import BottomNav from "@/components/BottomNav";
import { playCue } from "@/lib/audio";

interface ShopItem {
  key: string;
  name: string;
  type: "consumable" | "gift";
  price: number;
  desc: string;
  count: number;
  unlocked: boolean;
  unlockHint: string | null;
  /** V3 每日事件：旅商折扣（当天某件礼物打折） */
  discount: { ratio: number; priceAfter: number } | null;
}

interface ShopData {
  gold: number;
  intimacy: { stage: number; label: string; points: number } | null;
  items: ShopItem[];
}

const TYPE_SECTIONS: { type: ShopItem["type"]; label: string; hint: string }[] = [
  { type: "consumable", label: "道具", hint: "买了就进你的抽屉，到点自动生效" },
  { type: "gift", label: "给会长的礼物", hint: "送出去就是你们的共同回忆" },
];

/** 道具/礼物图标位 44×44：单色描边线框（§7.9） */
function ItemArt({ item }: { item: ShopItem }) {
  return (
    <span
      aria-hidden
      className="text-muted border-border flex h-11 w-11 shrink-0 items-center justify-center rounded-tile border"
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.4">
        {item.type === "consumable" ? (
          <path d="M7 4h8a3 3 0 0 1 3 3v13H9a2 2 0 0 1-2-2V4Zm0 0a2 2 0 0 0-2 2v2h4M10 9h5M10 13h5" strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <path d="M4 9h16v11H4zM4 9l2-4h12l2 4M12 5v4M9 13h6" strokeLinecap="round" strokeLinejoin="round" />
        )}
      </svg>
    </span>
  );
}

export default function ShopClient() {
  const [data, setData] = useState<ShopData | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedText, setSavedText] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/shop")
      .then((r) => r.json())
      .then((d) =>
        setData({
          gold: d.gold ?? 0,
          intimacy: d.intimacy ?? null,
          items: d.items ?? [],
        }),
      )
      .catch(() => setData({ gold: 0, intimacy: null, items: [] }));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function flash(text: string) {
    setSavedText(text);
    setError(null);
    setTimeout(() => setSavedText(null), 2000);
  }

  async function post(itemKey: string, action: "buy" | "gift" = "buy") {
    setBusy(itemKey + (action === "gift" ? ":gift" : ""));
    setError(null);
    try {
      const res = await fetch("/api/shop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemKey, action }),
      });
      const d = (await res.json()) as {
        error?: string;
        receipt?: { name?: string; stageUp?: boolean; intimacyLabel?: string };
      };
      if (!res.ok || d.error) {
        setError(d.error ?? "协会那边没办成，请稍后再试。");
      } else if (action === "gift") {
        playCue("gift");
        flash(
          d.receipt?.stageUp
            ? `他收下了「${d.receipt.name}」。你们的交情到了「${d.receipt.intimacyLabel}」`
            : "他收下了",
        );
      } else {
        playCue("purchase");
        flash("记上了，货已入袋");
      }
      load();
    } catch {
      setError("协会那边没办成，请稍后再试。");
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="bg-bg text-fg mx-auto flex h-dvh max-w-md flex-col">
      <header className="border-border border-b px-4 py-3">
        <div className="flex items-baseline justify-between">
          <h1 className="font-display text-fs-h1 leading-tight">协会商店</h1>
          <p className="text-gold font-numeric text-fs-h3 font-semibold tabular-nums">
            {data?.gold ?? "…"} <span className="text-fs-micro">金币</span>
          </p>
        </div>
        <p className="text-muted font-numeric text-fs-micro tracking-wide">
          只有仪式感的消耗，没有数值的捷径——买不到经验，也买不到通融
        </p>
        {data?.intimacy && (
          <p className="text-faint text-fs-micro mt-1 tracking-wide">
            交情：{data.intimacy.label}
          </p>
        )}
      </header>

      <div className="flex-1 space-y-6 overflow-y-auto px-4 py-4">
        {data === null && (
          <p className="text-muted mt-10 text-center text-fs-sm">
            正在翻商品架子……
          </p>
        )}
        {data !== null &&
          TYPE_SECTIONS.map((section) => {
            const list = data.items.filter((i) => i.type === section.type);
            if (!list.length) return null;
            return (
              <section key={section.type}>
                <h2 className="font-display text-fs-h2 mb-1">{section.label}</h2>
                <p className="text-muted mb-2.5 text-fs-micro">{section.hint}</p>
                <div className="space-y-2.5">
                  {list.map((item) => {
                    const locked = !item.unlocked;
                    const owned = item.count > 0;
                    const effPrice = item.discount ? item.discount.priceAfter : item.price;
                    const afford = !locked && data.gold >= effPrice;
                    const isGift = item.type === "gift";
                    const buyLabel = locked
                      ? item.unlockHint ?? "未解锁"
                      : !afford
                        ? "金币不够"
                        : owned
                          ? isGift
                            ? "买一份"
                            : "再买一份"
                          : "买下";
                    return (
                      <article
                        key={item.key}
                        className={`flex gap-3 rounded-card border p-3.5 transition-colors duration-200 ${
                          locked
                            ? "border-border bg-surface opacity-60"
                            : "border-border bg-surface hover:border-border-strong hover:bg-surface-2"
                        }`}
                        style={{
                          boxShadow:
                            "inset 0 0 0 1px color-mix(in oklch, var(--gold) 10%, transparent)",
                        }}
                      >
                        <ItemArt item={item} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-2">
                            <h3 className="font-display text-fs-h3 leading-snug">
                              {item.name}
                            </h3>
                            <span className="text-gold font-numeric text-fs-sm shrink-0 text-right font-semibold tabular-nums">
                              {item.discount ? (
                                <>
                                  {effPrice} <span className="text-fs-micro">金币</span>
                                  <span className="text-faint ml-1 text-fs-micro line-through">
                                    {item.price}
                                  </span>
                                </>
                              ) : (
                                <>
                                  {item.price} <span className="text-fs-micro">金币</span>
                                </>
                              )}
                            </span>
                          </div>
                          <p className="text-muted mt-0.5 text-fs-sm leading-relaxed">
                            {item.desc}
                            {item.discount && (
                              <span className="text-gold ml-1 text-fs-micro">
                                （旅商过境 · 今日折扣）
                              </span>
                            )}
                          </p>
                          <div className="mt-2 flex items-center justify-between gap-2">
                            <span className="text-faint font-numeric text-fs-micro tabular-nums">
                              {locked ? "货架未开放" : `持有 ×${item.count}`}
                            </span>
                            {locked ? (
                              <span className="border-border text-faint rounded-btn border px-3 py-1.5 text-fs-sm">
                                {item.unlockHint ?? "未解锁"}
                              </span>
                            ) : (
                              <div className="flex items-center gap-2">
                                {/* V2.0：送礼是独立动作，消耗一份并推进交情 */}
                                {isGift && owned && (
                                  <button
                                    type="button"
                                    disabled={busy !== null}
                                    onClick={() => post(item.key, "gift")}
                                    className="border-gold-line bg-gold-soft text-gold rounded-btn border px-3 py-1.5 text-fs-sm transition-colors hover:brightness-110 disabled:opacity-60"
                                  >
                                    {busy === item.key + ":gift"
                                      ? "……"
                                      : item.count >= 2
                                        ? "送他一份"
                                        : "送给他"}
                                  </button>
                                )}
                                <button
                                  type="button"
                                  disabled={!afford || busy !== null}
                                  onClick={() => post(item.key)}
                                  className={`border-accent-line text-accent hover:bg-accent-soft rounded-btn border px-3 py-1.5 text-fs-sm transition-colors ${
                                    afford ? "" : "border-disabled-border bg-disabled-bg text-disabled-fg"
                                  } disabled:opacity-60`}
                                >
                                  {busy === item.key ? "……" : buyLabel}
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            );
          })}
        {error && (
          <p className="border-danger bg-surface-2 text-danger-text rounded-tile border px-3 py-2 text-fs-meta">
            {error}
          </p>
        )}
        {savedText && !error && (
          <p className="text-gold font-numeric px-3 py-2 text-center text-fs-meta">
            {savedText}
          </p>
        )}
      </div>

      <BottomNav />
    </main>
  );
}
