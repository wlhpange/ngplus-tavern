"use client";

import { useEffect, useMemo, useState } from "react";
import PixelPet, { loadCatalog, loadPalettes, type PetAnim } from "@/components/PixelPet";
import {
  SLOT_ORDER,
  itemForBody,
  usedMaterials,
  type PetCatalog,
  type PetDescriptor,
  type PetPalettes,
} from "@/lib/petCatalog";

/**
 * PetDesigner · 像素小人形象设计器
 * 左侧预览（PixelPet），右侧按槽位选部件 + 按材质选颜色。
 * 供会长页「形象」区与 spike 演示页复用。
 */

const SLOT_LABELS: Record<string, string> = {
  body: "身体",
  head: "头型",
  face: "表情",
  hair: "发型",
  top: "上衣",
  bottom: "下装",
  shoes: "鞋",
};
const MATERIAL_LABELS: Record<string, string> = {
  body: "肤色",
  hair: "发色",
  cloth: "衣色",
  eye: "瞳色",
  metal: "金属色",
};
// body 必选；其余可「无」
const OPTIONAL_SLOTS = new Set(["face", "hair", "top", "bottom", "shoes"]);

export function defaultDescriptor(): PetDescriptor {
  return {
    bodyType: "female",
    items: {
      body: "body",
      head: "heads_human_female",
      face: "face_neutral",
      hair: "hair_ponytail",
      top: "torso_clothes_tshirt",
      bottom: "legs_pants",
      shoes: "feet_boots_basic",
    },
    colors: { body: "light", hair: "blonde", cloth: "purple", eye: "green" },
  };
}

/** 让描述在给定目录下保持有效（体型变化后剔除不适用部件；补齐 body/head 必选） */
export function sanitizeDescriptor(catalog: PetCatalog, d: PetDescriptor): PetDescriptor {
  const items: Record<string, string | undefined> = {};
  for (const slot of SLOT_ORDER) {
    const id = d.items[slot];
    if (id && itemForBody(catalog, id, d.bodyType)) items[slot] = id;
  }
  const firstOf = (slot: string, preferBody?: string): string | undefined => {
    const opts = Object.entries(catalog.items).filter(
      ([, it]) => it.slot === slot && it.bodyTypes.includes(d.bodyType),
    );
    return (
      (preferBody && opts.find(([id]) => id.endsWith(`_${preferBody}`))?.[0]) ?? opts[0]?.[0]
    );
  };
  // body / head 是必选（LPC 身体本身没有头，头是独立图层）
  if (!items.body) items.body = firstOf("body");
  if (!items.head) items.head = firstOf("head", d.bodyType);
  // 变体布局部件的颜色兜底（缺省取该部件第一个颜色）
  const itemVariants: Record<string, string | undefined> = {};
  for (const slot of SLOT_ORDER) {
    const it = items[slot] ? catalog.items[items[slot]!] : null;
    if (it?.layout === "variant" && it.variants?.length) {
      const cur = d.itemVariants?.[slot];
      itemVariants[slot] = cur && it.variants.includes(cur) ? cur : it.variants[0];
    }
  }
  return { ...d, items, itemVariants };
}

export default function PetDesigner({
  value,
  onChange,
  animation = "idle",
  display = 128,
  showAnimationSwitch = false,
}: {
  value: PetDescriptor;
  onChange: (next: PetDescriptor) => void;
  animation?: PetAnim;
  display?: number;
  showAnimationSwitch?: boolean;
}) {
  const [catalog, setCatalog] = useState<PetCatalog | null>(null);
  const [palettes, setPalettes] = useState<PetPalettes | null>(null);
  const [anim, setAnim] = useState<PetAnim>(animation);

  useEffect(() => {
    Promise.all([loadCatalog(), loadPalettes()])
      .then(([c, p]) => {
        setCatalog(c);
        setPalettes(p);
        onChange(sanitizeDescriptor(c, value));
      })
      .catch(() => {
        setCatalog(null);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const materials = useMemo(
    () => (catalog ? usedMaterials(catalog, value) : []),
    [catalog, value],
  );

  if (!catalog || !palettes) {
    return <p className="text-fs-micro text-faint">正在加载部件库……</p>;
  }

  const setItem = (slot: string, id: string) =>
    onChange(sanitizeDescriptor(catalog, { ...value, items: { ...value.items, [slot]: id || undefined } }));
  const setColor = (mat: string, name: string) =>
    onChange({ ...value, colors: { ...value.colors, [mat]: name } });

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
      <div className="flex flex-col items-center gap-2">
        <div className="border-border bg-surface-2 rounded-card border p-3">
          <PixelPet descriptor={value} animation={anim} display={display} />
        </div>
        {showAnimationSwitch && (
          <div className="flex gap-1">
            {(["idle", "walk", "emote"] as PetAnim[]).map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => setAnim(a)}
                className={
                  anim === a
                    ? "bg-accent text-on-accent rounded-pill px-2 py-0.5 text-fs-micro"
                    : "text-muted rounded-pill border border-border px-2 py-0.5 text-fs-micro"
                }
              >
                {a}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1 space-y-2">
        <label className="flex items-center gap-2 text-fs-micro text-muted">
          <span className="w-12 shrink-0">体型</span>
          <select
            className="border-border-strong bg-surface-2 text-fg rounded-btn min-w-0 flex-1 border px-2 py-1 text-fs-micro outline-none"
            value={value.bodyType}
            onChange={(e) => onChange(sanitizeDescriptor(catalog, { ...value, bodyType: e.target.value }))}
          >
            {catalog.bodyTypes.map((bt) => (
              <option key={bt} value={bt}>
                {bt === "female" ? "女性" : bt === "male" ? "男性" : bt}
              </option>
            ))}
          </select>
        </label>

        {SLOT_ORDER.map((slot) => {
          // 按 category 分组（hair 有上百项，optgroup 归类才用得了）
          const groups = new Map<string, { id: string; label: string }[]>();
          for (const [id, it] of Object.entries(catalog.items)) {
            if (it.slot !== slot || !it.bodyTypes.includes(value.bodyType)) continue;
            const c = it.category ?? "其他";
            if (!groups.has(c)) groups.set(c, []);
            groups.get(c)!.push({ id, label: it.label });
          }
          if (!groups.size) return null;
          const ordered = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
          const selItem = value.items[slot] ? catalog.items[value.items[slot]!] : null;
          const showVariant = selItem?.layout === "variant" && (selItem.variants?.length ?? 0) > 0;
          return (
            <div key={slot} className="space-y-1">
              <label className="flex items-center gap-2 text-fs-micro text-muted">
                <span className="w-12 shrink-0">{SLOT_LABELS[slot] ?? slot}</span>
                <select
                  className="border-border-strong bg-surface-2 text-fg rounded-btn min-w-0 flex-1 border px-2 py-1 text-fs-micro outline-none"
                  value={value.items[slot] ?? ""}
                  onChange={(e) => setItem(slot, e.target.value)}
                >
                  {OPTIONAL_SLOTS.has(slot) && <option value="">无</option>}
                  {ordered.map(([cat, opts]) => (
                    <optgroup key={cat} label={cat}>
                      {opts.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>
              {/* 变体布局部件（裙子/和服等）自带预上色，单独选颜色 */}
              {showVariant && (
                <label className="flex items-center gap-2 text-fs-micro text-muted">
                  <span className="w-12 shrink-0">颜色</span>
                  <select
                    className="border-border-strong bg-surface-2 text-fg rounded-btn min-w-0 flex-1 border px-2 py-1 text-fs-micro outline-none"
                    value={value.itemVariants?.[slot] ?? selItem!.variants![0]}
                    onChange={(e) =>
                      onChange({ ...value, itemVariants: { ...value.itemVariants, [slot]: e.target.value } })
                    }
                  >
                    {selItem!.variants!.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          );
        })}

        {materials.map((mat) => {
          const p = palettes[mat];
          if (!p) return null;
          return (
            <label key={mat} className="flex items-center gap-2 text-fs-micro text-muted">
              <span className="w-12 shrink-0">{MATERIAL_LABELS[mat] ?? mat}</span>
              <select
                className="border-border-strong bg-surface-2 text-fg rounded-btn min-w-0 flex-1 border px-2 py-1 text-fs-micro outline-none"
                value={value.colors[mat] ?? p.base}
                onChange={(e) => setColor(mat, e.target.value)}
              >
                {Object.keys(p.colors).map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
      </div>
    </div>
  );
}
