// LPC 子集 vendoring 脚本
//
// 用法：
//   1) 浅克隆 LPC 仓库并展开需要的目录：
//        git clone --depth 1 --filter=blob:none --sparse \
//          https://github.com/LiberatedPixelCup/Universal-LPC-Spritesheet-Character-Generator.git /tmp/lpc
//        cd /tmp/lpc && git sparse-checkout set sheet_definitions spritesheets palette_definitions
//   2) LPC_DIR=/tmp/lpc node scripts/lpc-build.mjs
//
// 收录两类部件（都要带 idle）：
//   - 单文件布局：<path><anim>.png（调色板重上色）
//   - 变体布局：<path><anim>/<颜色>.png（预上色；如裙子/和服）
// 输出到 public/sprites/lpc/，并生成 catalog.json / palettes.json / docs/CREDITS-lpc.md。
import fs from "node:fs";
import path from "node:path";

const LPC = process.env.LPC_DIR ?? "/tmp/lpc";
const DEST = path.join(process.cwd(), "public", "sprites", "lpc");
const BODY_TYPES = ["female", "male"];
const WANT_ANIMS = ["idle", "walk", "emote"];
/** 变体布局只收录这些颜色，控制体积 */
const CURATED_VARIANTS = ["black", "white", "red", "blue", "green", "purple", "brown", "navy"];

const CATS = [
  { dir: "body", slot: "body", filter: (d) => d.name === "Body Color" },
  { dir: "hair", slot: "hair" },
  { dir: "head/faces", slot: "face" },
  { dir: "head/heads", slot: "head", filter: (d) => (d.name ?? "").startsWith("Human") },
  { dir: "torso", slot: "top" },
  { dir: "legs", slot: "bottom" },
  { dir: "feet", slot: "shoes" },
];
const SLOT_LABEL = { body: "身体", head: "头型", face: "表情", hair: "发型", top: "上衣", bottom: "下装", shoes: "鞋" };

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith(".json")) acc.push(p);
  }
  return acc;
}
const exists = (p) => fs.existsSync(path.join(LPC, "spritesheets", p));

function materialsOf(def) {
  const r = def.recolors ?? {};
  if (r.material) return [r.material];
  const out = [];
  for (const k of Object.keys(r)) if (r[k] && r[k].material) out.push(r[k].material);
  return out;
}

const catalogItems = {};
const credits = new Set();
let copied = 0;

for (const cat of CATS) {
  const catDir = path.join(LPC, "sheet_definitions", cat.dir);
  if (!fs.existsSync(catDir)) continue;
  for (const file of walk(catDir)) {
    let def;
    try {
      def = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (def.type || !def.name) continue;
    if (cat.filter && !cat.filter(def)) continue;
    const layerKeys = Object.keys(def).filter((k) => k.startsWith("layer_"));
    if (!layerKeys.length) continue;
    const anims = def.animations ?? [];
    if (!anims.includes("idle")) continue;

    const curated = (def.variants ?? []).filter((v) => CURATED_VARIANTS.includes(v));

    // 判断布局：单文件 or 变体
    let layout = null;
    const perBody = {};
    for (const bt of BODY_TYPES) {
      const paths = [];
      let ok = true;
      for (const k of layerKeys) {
        const raw = def[k]?.[bt];
        if (!raw) {
          ok = false;
          break;
        }
        paths.push(raw.replace("${head}", bt));
      }
      if (!ok) continue;
      if (!layout) {
        if (paths.every((p) => exists(`${p}idle.png`))) layout = "single";
        else if (curated.length && paths.every((p) => exists(`${p}idle/${curated[0]}.png`)))
          layout = "variant";
      }
      if (layout === "single") {
        perBody[bt] = { paths, avail: WANT_ANIMS.filter((a) => paths.every((p) => exists(`${p}${a}.png`))) };
      } else if (layout === "variant") {
        perBody[bt] = {
          paths,
          avail: WANT_ANIMS.filter((a) => paths.every((p) => exists(`${p}${a}/${curated[0]}.png`))),
        };
      }
    }
    const bodyTypes = Object.keys(perBody).filter((bt) => perBody[bt]?.avail?.length);
    if (!layout || !bodyTypes.length) continue;

    const id = path.basename(file, ".json");
    const materials = layout === "single" ? materialsOf(def) : [];
    const rel = path.relative(catDir, path.dirname(file));
    const category = rel === "" || rel === "." ? "其他" : rel;

    const layers = perBody[bodyTypes[0]].paths.map((_, i) => {
      const paths = {};
      for (const bt of bodyTypes) paths[bt] = perBody[bt].paths[i];
      return { z: def[layerKeys[i]].zPos ?? 0, materials, paths };
    });
    const animations = {};
    for (const bt of bodyTypes) animations[bt] = perBody[bt].avail;

    catalogItems[id] = {
      label: def.name,
      slot: cat.slot,
      category,
      layout,
      ...(layout === "variant" ? { variants: curated } : {}),
      materials,
      bodyTypes,
      layers,
      animations,
    };

    // 拷贝
    for (const bt of bodyTypes) {
      const paths = perBody[bt].paths;
      const colors = layout === "variant" ? curated : [null];
      for (const a of perBody[bt].avail) {
        for (const p of paths) {
          for (const c of colors) {
            const relFile = c ? `${p}${a}/${c}.png` : `${p}${a}.png`;
            const src = path.join(LPC, "spritesheets", relFile);
            if (!fs.existsSync(src)) continue;
            const out = path.join(DEST, relFile);
            fs.mkdirSync(path.dirname(out), { recursive: true });
            fs.copyFileSync(src, out);
            copied++;
          }
        }
      }
    }
    for (const c of def.credits ?? []) {
      credits.add(JSON.stringify({ file: c.file, authors: c.authors, licenses: c.licenses, urls: c.urls }));
    }
  }
}

// 调色板
const palettes = {};
for (const m of ["body", "hair", "cloth", "eye", "metal"]) {
  const src = path.join(LPC, "palette_definitions", m, `${m}_ulpc.json`);
  if (!fs.existsSync(src)) continue;
  const meta = JSON.parse(fs.readFileSync(path.join(LPC, "palette_definitions", m, `meta_${m}.json`), "utf8"));
  palettes[m] = { base: meta.base, label: meta.label, colors: JSON.parse(fs.readFileSync(src, "utf8")) };
}
fs.writeFileSync(path.join(DEST, "palettes.json"), JSON.stringify(palettes, null, 2));

const catalog = {
  $comment: "Universal LPC Spritesheet Character Generator 子集（CC-BY-SA/OGA-BY，见 docs/CREDITS-lpc.md）。64×64 帧，正面=第 3 行。",
  frame: 64,
  frontRow: 2,
  base: "/sprites/lpc/",
  animations: { idle: { frames: 2, fps: 4 }, walk: { frames: 9, fps: 10 }, emote: { frames: 3, fps: 5 } },
  bodyTypes: BODY_TYPES,
  slots: Object.entries(SLOT_LABEL).map(([key, label]) => ({ key, label })),
  items: catalogItems,
};
fs.writeFileSync(path.join(DEST, "catalog.json"), JSON.stringify(catalog, null, 2));

// 署名
const creditList = [...credits].map((c) => JSON.parse(c));
const authorSet = new Set();
const licSet = new Set();
for (const c of creditList) {
  for (const a of c.authors ?? []) authorSet.add(a);
  for (const l of c.licenses ?? []) licSet.add(l);
}
fs.writeFileSync(
  path.join(process.cwd(), "docs", "CREDITS-lpc.md"),
  [
    "# LPC 素材署名（CREDITS）",
    "",
    "本项目 `public/sprites/lpc/` 下的像素素材来自 **Universal LPC Spritesheet Character Generator**",
    "（https://github.com/LiberatedPixelCup/Universal-LPC-Spritesheet-Character-Generator）。",
    "拼装/重上色的成品为 **CC-BY-SA** 衍生物，使用时需保留本署名。",
    "",
    "## 作者",
    "",
    [...authorSet].map((a) => `- ${a}`).join("\n"),
    "",
    "## 许可",
    "",
    [...licSet].map((l) => `- ${l}`).join("\n"),
    "",
    "## 各部件明细",
    "",
    "| 部件 | 作者 | 许可 | 来源 |",
    "|---|---|---|---|",
    ...creditList.map(
      (c) => `| ${c.file} | ${(c.authors ?? []).join(", ")} | ${(c.licenses ?? []).join(", ")} | ${(c.urls ?? []).join(" ")} |`,
    ),
    "",
  ].join("\n"),
);

const bySlot = {};
for (const it of Object.values(catalogItems)) bySlot[it.slot] = (bySlot[it.slot] ?? 0) + 1;
const variants = Object.values(catalogItems).filter((it) => it.layout === "variant").length;
console.log(`copied ${copied} files; items ${Object.keys(catalogItems).length} (variant ${variants})`);
console.log("by slot:", JSON.stringify(bySlot));
