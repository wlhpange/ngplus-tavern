/**
 * 像素小人 · 目录/描述工具（路线 A，LPC 子集）
 *
 * descriptor（存在会长身上的形象参数）→ 解析成可渲染的图层列表。
 * 目录与调色板数据来自 public/sprites/lpc/{catalog,palettes}.json（由 scripts/lpc-build.mjs 生成）。
 */

export type PetMaterial = "body" | "hair" | "cloth" | "eye" | "metal";

export interface CatalogLayer {
  z: number;
  materials: PetMaterial[];
  /** 各体型对应的图层目录（末尾带 /） */
  paths: Record<string, string>;
}
export interface CatalogItem {
  label: string;
  slot: string;
  /** 分组（用于下拉按类别归类，避免上百项堆在一起） */
  category?: string;
  /** single = <path><anim>.png（调色板重上色）；variant = <path><anim>/<颜色>.png（预上色） */
  layout?: "single" | "variant";
  /** variant 布局可选的颜色名 */
  variants?: string[];
  materials: PetMaterial[];
  bodyTypes: string[];
  layers: CatalogLayer[];
  /** 各体型可用的动画（idle/walk/emote 的子集） */
  animations: Record<string, string[]>;
}
export interface PetCatalog {
  frame: number;
  frontRow: number;
  base: string;
  animations: Record<string, { frames: number; fps: number }>;
  bodyTypes: string[];
  slots: { key: string; label: string }[];
  items: Record<string, CatalogItem>;
}

export interface MaterialPalette {
  base: string;
  label?: string;
  colors: Record<string, string[]>;
}
export type PetPalettes = Record<string, MaterialPalette>;

export interface PetDescriptor {
  bodyType: string;
  /** 各槽位选中的部件 id（缺省 = 不穿） */
  items: Record<string, string | undefined>;
  /** 各材质选中的颜色名（缺省 = 用该材质基底色） */
  colors: Record<string, string | undefined>;
  /** 变体布局部件的颜色（按槽位；缺省 = 该部件第一个颜色） */
  itemVariants?: Record<string, string | undefined>;
}

export interface ResolvedLayer {
  path: string;
  z: number;
  /** 所属槽位（body/head/face/hair/top/bottom/shoes），用于逐层替换（眨眼） */
  slot: string;
  materials: PetMaterial[];
  layout: "single" | "variant";
  /** variant 布局时选中的颜色文件名（不含 .png） */
  variant?: string;
}

/** 槽位渲染顺序（z 仍由图层自身决定，这里只保证齐全） */
export const SLOT_ORDER = ["body", "head", "face", "hair", "top", "bottom", "shoes"];

export function resolveLayers(catalog: PetCatalog, d: PetDescriptor): ResolvedLayer[] {
  const out: ResolvedLayer[] = [];
  for (const slot of SLOT_ORDER) {
    const item = catalog.items[d.items[slot] ?? ""];
    if (!item) continue;
    if (!item.bodyTypes.includes(d.bodyType)) continue;
    const layout = item.layout ?? "single";
    const chosen = d.itemVariants?.[slot];
    const variant =
      layout === "variant"
        ? chosen && item.variants?.includes(chosen)
          ? chosen
          : item.variants?.[0]
        : undefined;
    for (const l of item.layers) {
      const path = l.paths[d.bodyType];
      if (!path) continue;
      out.push({
        path,
        z: l.z,
        slot,
        materials: l.materials.length ? l.materials : item.materials,
        layout,
        variant,
      });
    }
  }
  return out.sort((a, b) => a.z - b.z);
}

/** 当前描述用到的材质（用于决定 UI 要显示哪些颜色下拉） */
export function usedMaterials(catalog: PetCatalog, d: PetDescriptor): PetMaterial[] {
  const set = new Set<PetMaterial>();
  for (const slot of SLOT_ORDER) {
    const item = catalog.items[d.items[slot] ?? ""];
    if (!item || !item.bodyTypes.includes(d.bodyType)) continue;
    for (const m of item.materials) set.add(m);
  }
  return [...set];
}

/** 当前描述下各部件都支持的动画交集（缺帧时降级用） */
export function availableAnims(catalog: PetCatalog, d: PetDescriptor): string[] {
  let acc: string[] | null = null;
  for (const slot of SLOT_ORDER) {
    const item = catalog.items[d.items[slot] ?? ""];
    if (!item || !item.bodyTypes.includes(d.bodyType)) continue;
    const anims = item.animations[d.bodyType] ?? [];
    acc = acc ? acc.filter((a) => anims.includes(a)) : [...anims];
  }
  return acc ?? [];
}

/** 该部件是否适用于某体型 */
export function itemForBody(catalog: PetCatalog, id: string, bodyType: string): CatalogItem | null {
  const it = catalog.items[id];
  return it && it.bodyTypes.includes(bodyType) ? it : null;
}
