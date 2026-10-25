import { useEffect, useMemo, useState } from "react";
import { Image, StyleSheet, View } from "react-native";
import { fromByteArray, toByteArray } from "base64-js";
import { decode, encode } from "fast-png";

import catalogJson from "@/server/pet_catalog.json";
import palettesJson from "@/server/pet_palettes.json";
import lpcData from "@/weblib/lpcData.json";
import {
  resolveLayers,
  type PetCatalog,
  type PetDescriptor,
  type PetMaterial,
  type PetPalettes,
  type ResolvedLayer,
} from "@/weblib/petCatalog";

/**
 * LPC 像素小人：与 Web 相同的 catalog / palettes / 分层 sprite sheet。
 * - 运行时用 fast-png 解 PNG，按调色板替换 RGB，再编码成 data URI；
 * - 用 64×64 的裁剪窗口播放正面行（frontRow）的动画帧；
 * - 素材随 APK 打包，不需要网络。
 */
export type PetAnim = "idle" | "walk" | "emote";

const catalog = catalogJson as unknown as PetCatalog;
const palettes = palettesJson as unknown as PetPalettes;
const LPC_DATA = lpcData as Record<string, { b64: string; w: number; h: number }>;
const FRAME = 64;

type LayerImage = { uri: string; width: number; height: number; z: number };

const recolorCache = new Map<string, LayerImage>();

function hexToInt(hex: string): number {
  const h = hex.replace("#", "");
  return parseInt(h.length >= 6 ? h.slice(0, 6) : h.padEnd(6, "0"), 16);
}

function buildColorMap(layer: ResolvedLayer, colors: Record<string, string | undefined>) {
  const map = new Map<number, number>();
  for (const mat of layer.materials as PetMaterial[]) {
    const p = palettes[mat];
    if (!p) continue;
    const base = p.colors[p.base];
    const key = colors[mat];
    const target = key ? p.colors[key] : null;
    if (!base || !target) continue;
    const n = Math.min(base.length, target.length);
    for (let i = 0; i < n; i++) map.set(hexToInt(base[i]), hexToInt(target[i] ?? base[i]));
  }
  return map;
}

/** fast-png 可能返回 RGBA（type 6）或索引色（type 3）；统一展开为 RGBA。 */
function toRgba(png: {
  width: number;
  height: number;
  channels: number;
  data: Uint8Array;
  depth: number;
  palette?: number[][];
}): Uint8Array {
  if (png.channels === 4) return png.data;
  const n = png.width * png.height;
  const out = new Uint8Array(n * 4);
  if (png.channels === 3) {
    for (let i = 0; i < n; i++) {
      out[i * 4] = png.data[i * 3];
      out[i * 4 + 1] = png.data[i * 3 + 1];
      out[i * 4 + 2] = png.data[i * 3 + 2];
      out[i * 4 + 3] = 255;
    }
    return out;
  }
  if (png.channels === 1 && png.palette) {
    for (let i = 0; i < n; i++) {
      const c = png.palette[png.data[i]] ?? [0, 0, 0, 0];
      out[i * 4] = c[0] ?? 0;
      out[i * 4 + 1] = c[1] ?? 0;
      out[i * 4 + 2] = c[2] ?? 0;
      out[i * 4 + 3] = c[3] ?? 255;
    }
    return out;
  }
  return out;
}

function sheetKey(layer: ResolvedLayer, anim: PetAnim): { key: string; fallback: string } {
  const variant = layer.variant ?? "";
  return layer.layout === "variant"
    ? { key: `${layer.path}${anim}/${variant}.png`, fallback: `${layer.path}idle/${variant}.png` }
    : { key: `${layer.path}${anim}.png`, fallback: `${layer.path}idle.png` };
}

async function loadLayer(
  layer: ResolvedLayer,
  anim: PetAnim,
  colors: Record<string, string | undefined>,
): Promise<LayerImage | null> {
  const { key, fallback } = sheetKey(layer, anim);
  const chosen = LPC_DATA[key] ? key : LPC_DATA[fallback] ? fallback : null;
  if (!chosen) return null;
  const colorKey = layer.materials.map((m) => colors[m] ?? "").join(",");
  const cacheKey = `${chosen}|${colorKey}`;
  const cached = recolorCache.get(cacheKey);
  if (cached) return cached;

  const entry = LPC_DATA[chosen];
  const map = buildColorMap(layer, colors);

  let result: LayerImage;
  if (map.size === 0) {
    result = {
      uri: `data:image/png;base64,${entry.b64}`,
      width: entry.w,
      height: entry.h,
      z: layer.z,
    };
  } else {
    const bytes = toByteArray(entry.b64);
    const png = decode(bytes) as unknown as {
      width: number;
      height: number;
      channels: number;
      data: Uint8Array;
      depth: number;
      palette?: number[][];
    };
    const rgba = toRgba(png);
    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i + 3] === 0) continue;
      const packed = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
      const target = map.get(packed);
      if (target !== undefined) {
        rgba[i] = (target >> 16) & 255;
        rgba[i + 1] = (target >> 8) & 255;
        rgba[i + 2] = target & 255;
      }
    }
    const out = encode({ width: png.width, height: png.height, data: rgba, channels: 4, depth: 8 });
    result = {
      uri: `data:image/png;base64,${fromByteArray(out)}`,
      width: png.width,
      height: png.height,
      z: layer.z,
    };
  }

  recolorCache.set(cacheKey, result);
  return result;
}

export function PixelPet({
  descriptor,
  animation = "idle",
  display = 64,
  face,
}: {
  descriptor: PetDescriptor;
  animation?: PetAnim;
  display?: number;
  face?: string | null;
}) {
  const desc = useMemo<PetDescriptor>(
    () => (face ? { ...descriptor, items: { ...descriptor.items, face } } : descriptor),
    [descriptor, face],
  );
  const descKey = JSON.stringify(desc);
  const anim = catalog.animations[animation] ?? { frames: 2, fps: 4 };
  const frames = Math.max(1, anim.frames);
  const [layers, setLayers] = useState<LayerImage[]>([]);
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLayers([]);
    (async () => {
      const resolved = resolveLayers(catalog, desc);
      const out = await Promise.all(
        resolved.map((l) => loadLayer(l, animation, desc.colors ?? {}).catch(() => null)),
      );
      if (!cancelled) setLayers(out.filter((x): x is LayerImage => Boolean(x)));
    })();
    return () => {
      cancelled = true;
    };
  }, [descKey, animation]);

  useEffect(() => {
    setFrame(0);
    if (frames <= 1) return;
    const timer = setInterval(() => setFrame((f) => (f + 1) % frames), Math.max(60, 1000 / anim.fps));
    return () => clearInterval(timer);
  }, [frames, anim.fps, animation]);

  const scale = display / FRAME;
  const row = catalog.frontRow ?? 2;

  return (
    <View style={[styles.frame, { width: display, height: display }]}>
      {layers.map((l, i) => (
        <Image
          key={i}
          source={{ uri: l.uri }}
          resizeMode="stretch"
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: l.width * scale,
            height: l.height * scale,
            transform: [
              { translateX: -frame * FRAME * scale },
              { translateY: -row * FRAME * scale },
            ],
          }}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { overflow: "hidden" },
});

export function defaultDescriptor(): PetDescriptor {
  return {
    bodyType: "female",
    items: {
      body: "body",
      head: "heads_human_female",
      face: "face_neutral",
      hair: "hair_ponytail",
      top: "torso_clothes_longsleeve2",
      bottom: "legs_pants2",
      shoes: "feet_shoes_basic",
    },
    colors: { body: "light", hair: "blonde", cloth: "purple", eye: "green" },
  };
}


