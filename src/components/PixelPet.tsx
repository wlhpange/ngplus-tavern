import { useEffect, useMemo, useState } from "react";
import { StyleSheet } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
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
 * - 帧号由 Reanimated useFrameCallback 在 UI 线程推进，不再 setInterval + setState；
 * - 待机时有呼吸起伏，每隔几秒眨一次眼（替换 face 图层）；
 * - 素材随 APK 打包，不需要网络。
 */
export type PetAnim = "idle" | "walk" | "emote";

const catalog = catalogJson as unknown as PetCatalog;
const palettes = palettesJson as unknown as PetPalettes;
const LPC_DATA = lpcData as Record<string, { b64: string; w: number; h: number }>;
const FRAME = 64;
const BLINK_FACE = "face_closed";

type LayerImage = { uri: string; width: number; height: number; z: number; slot: string };

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
      slot: layer.slot,
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
      slot: layer.slot,
    };
  }

  recolorCache.set(cacheKey, result);
  return result;
}

/** 单层：帧位移在 UI 线程按共享帧号计算，不触发 React 重渲染 */
function PetLayer({
  layer,
  frame,
  scale,
  row,
  blinkUri,
}: {
  layer: LayerImage;
  frame: SharedValue<number>;
  scale: number;
  row: number;
  blinkUri: string | null;
}) {
  const style = useAnimatedStyle(() => ({
    transform: [
      { translateX: -frame.value * FRAME * scale },
      { translateY: -row * FRAME * scale },
    ],
  }));
  const uri = layer.slot === "face" && blinkUri ? blinkUri : layer.uri;
  return (
    <Animated.Image
      source={{ uri }}
      resizeMode="stretch"
      style={[
        {
          position: "absolute",
          left: 0,
          top: 0,
          width: layer.width * scale,
          height: layer.height * scale,
        },
        style,
      ]}
    />
  );
}

export function PixelPet({
  descriptor,
  animation = "idle",
  display = 64,
  face,
  animated = true,
}: {
  descriptor: PetDescriptor;
  animation?: PetAnim;
  display?: number;
  face?: string | null;
  /** 列表里展示时关掉呼吸/眨眼，只保留帧动画 */
  animated?: boolean;
}) {
  const desc = useMemo<PetDescriptor>(
    () => (face ? { ...descriptor, items: { ...descriptor.items, face } } : descriptor),
    [descriptor, face],
  );
  const descKey = JSON.stringify(desc);
  const anim = catalog.animations[animation] ?? { frames: 2, fps: 4 };
  const frames = Math.max(1, anim.frames);
  const fps = Math.max(1, anim.fps);
  const [layers, setLayers] = useState<LayerImage[]>([]);
  const [blinkUri, setBlinkUri] = useState<string | null>(null);
  const [blinking, setBlinking] = useState(false);

  const frame = useSharedValue(0);
  const carry = useSharedValue(0);
  const breathe = useSharedValue(1);

  useEffect(() => {
    let cancelled = false;
    setLayers([]);
    setBlinkUri(null);
    (async () => {
      const resolved = resolveLayers(catalog, desc);
      const loaded = await Promise.all(
        resolved.map((l) => loadLayer(l, animation, desc.colors ?? {}).catch(() => null)),
      );
      const blinkLayer = desc.items.face
        ? resolveLayers(catalog, {
            ...desc,
            items: { ...desc.items, face: BLINK_FACE },
          }).find((l) => l.slot === "face")
        : undefined;
      const blink = blinkLayer
        ? await loadLayer(blinkLayer, animation, desc.colors ?? {}).catch(() => null)
        : null;
      if (cancelled) return;
      setLayers(loaded.filter((x): x is LayerImage => Boolean(x)));
      setBlinkUri(blink?.uri ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [descKey, animation]);

  // 帧号推进：按累计时间步进，掉帧时也不会越走越慢
  useFrameCallback((info) => {
    if (frames <= 1) return;
    const dt = info.timeSincePreviousFrame ?? 0;
    if (dt <= 0) return;
    carry.value += dt;
    const interval = 1000 / fps;
    if (carry.value >= interval) {
      const steps = Math.floor(carry.value / interval);
      carry.value -= steps * interval;
      frame.value = (frame.value + steps) % frames;
    }
  });

  // 动画/形象切换后从头播
  useEffect(() => {
    frame.value = 0;
    carry.value = 0;
  }, [animation, descKey, frames, fps, frame, carry]);

  useEffect(() => {
    if (!animated) return;
    breathe.value = withRepeat(
      withSequence(
        withTiming(1.012, { duration: 1900, easing: Easing.inOut(Easing.quad) }),
        withTiming(0.994, { duration: 2100, easing: Easing.inOut(Easing.quad) }),
      ),
      -1,
      false,
    );
    return () => {
      cancelAnimation(breathe);
      breathe.value = 1;
    };
  }, [animated, breathe]);

  useEffect(() => {
    if (!animated || !blinkUri) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = () => {
      timer = setTimeout(() => {
        if (!alive) return;
        setBlinking(true);
        timer = setTimeout(() => {
          if (!alive) return;
          setBlinking(false);
          loop();
        }, 130);
      }, 2600 + Math.random() * 3600);
    };
    loop();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      setBlinking(false);
    };
  }, [animated, blinkUri]);

  const breatheStyle = useAnimatedStyle(() => {
    const v = breathe.value;
    return { transform: [{ scaleY: v }, { scaleX: 2 - v }] };
  });

  const scale = display / FRAME;
  const row = catalog.frontRow ?? 2;
  const blink = blinking && animated ? blinkUri : null;

  return (
    <Animated.View style={[styles.frame, { width: display, height: display }, animated ? breatheStyle : null]}>
      {layers.map((l, i) => (
        <PetLayer key={`${l.slot}-${i}`} layer={l} frame={frame} scale={scale} row={row} blinkUri={blink} />
      ))}
    </Animated.View>
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
