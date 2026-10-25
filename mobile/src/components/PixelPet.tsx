import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from "react-native-reanimated";
import Svg, { Rect } from "react-native-svg";

import type { PetDescriptor } from "@/weblib/petCatalog";

export type PetAnim = "idle" | "walk" | "emote";

/** 原生像素小人：不依赖 Canvas / WebView，按 descriptor 用 16×16 方块拼装。 */

const BODY_COLORS: Record<string, string> = {
  light: "#F2C9A0",
  tan: "#D9A066",
  bronze: "#B97C50",
  brown: "#8C5A3C",
};
const HAIR_COLORS: Record<string, string> = {
  blonde: "#E8C97A",
  brown: "#7B4B2A",
  black: "#2B2430",
  silver: "#C9CED6",
  red: "#B5543F",
  purple: "#8C6BB1",
  blue: "#4E6B9B",
};
const CLOTH_COLORS: Record<string, string> = {
  purple: "#6B4E9B",
  teal: "#3F8C82",
  red: "#A84A4A",
  blue: "#4A6FA8",
  black: "#2E2A36",
  green: "#4E7B5A",
  gold: "#B8913F",
};
const EYE_COLORS: Record<string, string> = {
  green: "#4E9B6B",
  blue: "#5A8FC9",
  amber: "#C98A4E",
  red: "#B5544E",
  purple: "#8C6BB1",
};
const SHOE_COLOR = "#4A3428";

function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, ((n >> 16) & 255) + amount));
  const g = Math.max(0, Math.min(255, ((n >> 8) & 255) + amount));
  const b = Math.max(0, Math.min(255, (n & 255) + amount));
  return `#${[r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

interface Pixel {
  x: number;
  y: number;
  color: string;
}

function buildPixels(d: PetDescriptor, faceOverride?: string): Pixel[] {
  const body = BODY_COLORS[d.colors?.body ?? "light"] ?? BODY_COLORS.light;
  const hair = HAIR_COLORS[d.colors?.hair ?? "blonde"] ?? HAIR_COLORS.blonde;
  const cloth = CLOTH_COLORS[d.colors?.cloth ?? "purple"] ?? CLOTH_COLORS.purple;
  const eye = EYE_COLORS[d.colors?.eye ?? "green"] ?? EYE_COLORS.green;
  const male = d.bodyType === "male";
  const px: Pixel[] = [];
  const add = (x: number, y: number, color: string) => px.push({ x, y, color });

  // 头（略宽的女相 / 略方的男相）
  const headW = male ? 5 : 5;
  for (let y = 3; y <= 7; y++) {
    const from = male ? 6 : 5;
    for (let x = from; x < from + headW; x++) add(x, y, body);
  }
  // 脖子
  add(7, 8, shade(body, -16));
  add(8, 8, shade(body, -16));

  // 身体与手臂
  const bodyFrom = male ? 5 : 5;
  const bodyW = male ? 6 : 6;
  for (let y = 9; y <= 12; y++) {
    for (let x = bodyFrom; x < bodyFrom + bodyW; x++) add(x, y, cloth);
  }
  for (let y = 9; y <= 11; y++) {
    add(bodyFrom - 1, y, body);
    add(bodyFrom + bodyW, y, body);
  }

  // 下半身
  const bottomKey = d.items?.bottom ?? "legs_pants";
  const bottomColor = bottomKey.includes("skirt") ? shade(cloth, -28) : "#3B3247";
  for (let y = 13; y <= 13; y++) {
    for (let x = 5; x <= 10; x++) add(x, y, bottomColor);
  }
  add(5, 14, bottomColor);
  add(6, 14, bottomColor);
  add(9, 14, bottomColor);
  add(10, 14, bottomColor);

  // 鞋
  const shoeKey = d.items?.shoes ?? "feet_boots_basic";
  const shoeColor = shoeKey.includes("sandals") ? shade(body, -40) : SHOE_COLOR;
  add(5, 15, shoeColor);
  add(6, 15, shoeColor);
  add(9, 15, shoeColor);
  add(10, 15, shoeColor);

  // 头发：按部件名切换轮廓
  const hairKey = d.items?.hair ?? "hair_ponytail";
  for (let x = 5; x <= 10; x++) add(x, 2, hair);
  for (let y = 3; y <= 5; y++) {
    add(4, y, hair);
    add(11, y, hair);
  }
  if (hairKey.includes("bob")) {
    add(4, 6, hair);
    add(11, 6, hair);
  } else if (hairKey.includes("long")) {
    for (let y = 6; y <= 11; y++) {
      add(4, y, hair);
      add(11, y, hair);
    }
  } else if (hairKey.includes("braid")) {
    for (let y = 6; y <= 10; y++) add(11, y, hair);
    add(12, 11, hair);
  } else if (hairKey.includes("ponytail")) {
    add(11, 6, hair);
    add(12, 7, hair);
    add(12, 8, hair);
  } else {
    add(4, 6, hair);
    add(11, 6, hair);
  }

  // 脸
  const face = faceOverride ?? d.items?.face ?? "face_neutral";
  const eyeColor = face === "face_shock" ? "#FFFFFF" : eye;
  add(6, 5, eyeColor);
  add(9, 5, eyeColor);
  if (face === "face_happy") {
    add(6, 5, shade(body, -60));
    add(9, 5, shade(body, -60));
    add(7, 7, shade(body, -70));
    add(8, 7, shade(body, -70));
  } else if (face === "face_sad") {
    add(6, 7, "#7A4A5A");
    add(9, 7, "#7A4A5A");
    add(7, 6, shade(body, -50));
    add(8, 6, shade(body, -50));
  } else if (face === "face_angry") {
    add(6, 4, shade(hair, -20));
    add(9, 4, shade(hair, -20));
    add(7, 7, "#7A3A44");
    add(8, 7, "#7A3A44");
  } else if (face === "face_shock") {
    add(6, 6, shade(body, -40));
    add(9, 6, shade(body, -40));
    add(7, 7, "#5A3A44");
    add(8, 7, "#5A3A44");
  } else if (face === "face_blush") {
    add(5, 6, "#E58A96");
    add(10, 6, "#E58A96");
    add(7, 7, "#B45A66");
    add(8, 7, "#B45A66");
  } else {
    add(7, 7, "#9A5A5A");
    add(8, 7, "#9A5A5A");
  }

  // 上衣领口细节
  add(7, 9, shade(cloth, 26));
  add(8, 9, shade(cloth, 26));

  return px;
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
  const pixels = buildPixels(descriptor, face ?? undefined);
  const bob = useSharedValue(0);
  useEffect(() => {
    if (animation === "idle") {
      bob.value = withRepeat(withSequence(withTiming(-1.5, { duration: 900, easing: Easing.inOut(Easing.quad) }), withTiming(0, { duration: 900, easing: Easing.inOut(Easing.quad) })), -1, true);
    } else if (animation === "walk") {
      bob.value = withRepeat(withSequence(withTiming(-3, { duration: 220, easing: Easing.linear }), withTiming(0, { duration: 220, easing: Easing.linear })), -1, true);
    } else {
      bob.value = withRepeat(withSequence(withTiming(-5, { duration: 180 }), withTiming(0, { duration: 260 })), 2, true);
    }
  }, [animation, bob]);
  const style = useAnimatedStyle(() => ({ transform: [{ translateY: bob.value }] }));
  const cell = display / 16;
  return (
    <Animated.View style={[{ width: display, height: display }, style]}>
      <Svg width={display} height={display} viewBox="0 0 16 16">
        <Rect x={0} y={0} width={16} height={16} fill="transparent" />
        {pixels.map((p, i) => (
          <Rect key={i} x={p.x} y={p.y} width={1} height={1} fill={p.color} />
        ))}
      </Svg>
    </Animated.View>
  );
}

export const PET_HAIR = [
  ["hair_ponytail", "马尾"],
  ["hair_braid", "麻花辫"],
  ["hair_bob", "波波头"],
  ["hair_long_tied", "长直发"],
  ["hair_short", "短发"],
] as const;
export const PET_TOP = [
  ["torso_clothes_tshirt", "T 恤"],
  ["torso_clothes_longsleeve2", "长袖"],
  ["torso_armour_leather", "皮甲"],
  ["torso_clothes_sleeveless2", "背心"],
] as const;
export const PET_BOTTOM = [
  ["legs_pants", "长裤"],
  ["legs_skirt", "裙装"],
  ["legs_shorts", "短裤"],
] as const;
export const PET_SHOES = [
  ["feet_boots_basic", "靴子"],
  ["feet_sandals", "凉鞋"],
] as const;
export const PET_FACE = [
  ["face_neutral", "平静"],
  ["face_happy", "微笑"],
  ["face_sad", "难过"],
  ["face_angry", "生气"],
  ["face_shock", "惊讶"],
  ["face_blush", "脸红"],
] as const;

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

export const petStyles = StyleSheet.create({
  shadow: { shadowColor: "#000", shadowOpacity: 0.5, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
});
