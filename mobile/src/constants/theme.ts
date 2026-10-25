import { Platform } from "react-native";

/** 与 Web 端 tokens.css 对齐的中文暗金主题。 */
export const C = {
  bg: "#0B0810",
  surface: "#161020",
  surface2: "#1F1730",
  surface3: "#271B3B",
  border: "#322743",
  borderStrong: "#4A3863",
  fg: "#E6ECF7",
  muted: "#838FAE",
  faint: "#5B6482",
  accent: "#5FD8C4",
  accentSoft: "rgba(95,216,196,0.14)",
  accentLine: "rgba(95,216,196,0.40)",
  gold: "#D9B061",
  goldSoft: "rgba(217,176,97,0.16)",
  goldLine: "rgba(217,176,97,0.42)",
  goldDim: "rgba(217,176,97,0.10)",
  danger: "#A83244",
  dangerSoft: "rgba(168,50,68,0.22)",
  dangerText: "#E68A96",
  success: "#79D6A6",
  successSoft: "rgba(121,214,166,0.14)",
  arcane: "#B79BE8",
  arcaneSoft: "rgba(183,155,232,0.14)",
  flame: "#E2795E",
  onGold: "#0B0810",
  onAccent: "#061713",
  overlay: "rgba(11,8,16,0.78)",
} as const;

export const A = {
  vitality: "#E2795E",
  mind: "#6FA6D8",
  willpower: "#A98BE8",
  wealth: "#D9B061",
  social: "#D98FB5",
  creativity: "#5FD8C4",
} as const;

export const Fonts = {
  display: Platform.select({ ios: "Songti SC", android: "serif", default: "serif" })!,
  body: Platform.select({ ios: "PingFang SC", android: "sans-serif", default: "sans-serif" })!,
  mono: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" })!,
} as const;

export const R = { card: 18, tile: 14, btn: 12, pill: 999 } as const;

export const S = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

export const SHADOW = {
  card: {
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  gold: {
    shadowColor: C.gold,
    shadowOpacity: 0.35,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
    elevation: 10,
  },
} as const;
