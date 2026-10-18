"use client";

import { useEffect, useRef, useState } from "react";
import {
  resolveLayers,
  type PetCatalog,
  type PetDescriptor,
  type PetMaterial,
  type PetPalettes,
} from "@/lib/petCatalog";

/**
 * PixelPet · 桌面宠物式像素小人（路线 A：内置 LPC 部件拼装 + 调色板重上色）
 *
 * 输入一份「形象描述」descriptor（出处：角色卡映射 or 手动选择），
 * 从 catalog.json 解析出图层、按 z 叠放，取正面行（第 3 行）轮播帧。
 */

export type PetAnim = "idle" | "walk" | "emote";
export type PetColors = Partial<Record<PetMaterial, string>>;

const FRAME = 64;
const FRONT_ROW = 2; // LPC：0=上 1=左 2=下(正面) 3=右

const DEFAULT_ANIMS: Record<string, { frames: number; fps: number }> = {
  idle: { frames: 2, fps: 4 },
  walk: { frames: 9, fps: 10 },
  emote: { frames: 3, fps: 5 },
};

let catalogCache: PetCatalog | null = null;
let palettesCache: PetPalettes | null = null;

export async function loadCatalog(basePath = "/sprites/lpc/"): Promise<PetCatalog> {
  if (!catalogCache) catalogCache = (await (await fetch(`${basePath}catalog.json`)).json()) as PetCatalog;
  return catalogCache;
}
export async function loadPalettes(basePath = "/sprites/lpc/"): Promise<PetPalettes> {
  if (!palettesCache) palettesCache = (await (await fetch(`${basePath}palettes.json`)).json()) as PetPalettes;
  return palettesCache;
}

function hexOf(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function buildColorMap(materials: PetMaterial[], colors: PetColors, palettes: PetPalettes): Map<string, string> {
  const map = new Map<string, string>();
  for (const mat of materials) {
    const p = palettes[mat];
    if (!p) continue;
    const base = p.colors[p.base];
    const target = colors[mat] ? p.colors[colors[mat]] : null;
    if (!base || !target) continue;
    for (let i = 0; i < base.length; i++) {
      map.set(base[i].toLowerCase(), (target[i] ?? base[i]).toLowerCase());
    }
  }
  return map;
}

async function loadRecolored(
  src: string,
  materials: PetMaterial[],
  colors: PetColors,
  palettes: PetPalettes,
): Promise<HTMLCanvasElement> {
  const img = await loadImage(src);
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  const cx = c.getContext("2d");
  if (!cx) return c;
  cx.imageSmoothingEnabled = false;
  cx.drawImage(img, 0, 0);

  const map = materials.length ? buildColorMap(materials, colors, palettes) : null;
  if (map && map.size) {
    const data = cx.getImageData(0, 0, c.width, c.height);
    const d = data.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      const t = map.get(hexOf(d[i], d[i + 1], d[i + 2]));
      if (t) {
        d[i] = parseInt(t.slice(1, 3), 16);
        d[i + 1] = parseInt(t.slice(3, 5), 16);
        d[i + 2] = parseInt(t.slice(5, 7), 16);
      }
    }
    cx.putImageData(data, 0, 0);
  }
  return c;
}

export default function PixelPet({
  descriptor,
  animation = "idle",
  display = 64,
  basePath = "/sprites/lpc/",
  className,
}: {
  descriptor: PetDescriptor;
  animation?: PetAnim;
  /** 显示边长（px）。建议 64 或整数倍，缩小会丢像素 */
  display?: number;
  basePath?: string;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const [, setTick] = useState(0);
  const descKey = JSON.stringify(descriptor);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;

    const desc: PetDescriptor = JSON.parse(descKey);
    const colors = (desc.colors ?? {}) as PetColors;
    let cancelled = false;

    (async () => {
      const [catalog, palettes] = await Promise.all([loadCatalog(basePath), loadPalettes(basePath)]);
      const anim = catalog.animations[animation] ?? DEFAULT_ANIMS[animation];
      const layers = resolveLayers(catalog, desc);
      const drawn = await Promise.all(
        layers.map(async (l) => {
          const src =
            l.layout === "variant"
              ? `${basePath}${l.path}${animation}/${l.variant}.png`
              : `${basePath}${l.path}${animation}.png`;
          return { img: await loadRecolored(src, l.materials, colors, palettes) };
        }),
      );
      if (cancelled) return;

      const start = performance.now();
      const loop = (t: number) => {
        const frame = Math.floor(((t - start) / 1000) * anim.fps) % anim.frames;
        ctx.clearRect(0, 0, FRAME, FRAME);
        for (const { img } of drawn) {
          ctx.drawImage(img, frame * FRAME, FRONT_ROW * FRAME, FRAME, FRAME, 0, 0, FRAME, FRAME);
        }
        rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);
      setTick((x) => x + 1);
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafRef.current);
    };
  }, [descKey, animation, basePath]);

  return (
    <canvas
      ref={ref}
      width={FRAME}
      height={FRAME}
      className={className}
      style={{ width: display, height: display, imageRendering: "pixelated" }}
      aria-label="会长像素小人"
      role="img"
    />
  );
}
