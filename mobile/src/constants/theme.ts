import { Platform } from "react-native";

/**
 * 与 Web 端 tokens.css 对齐的暗金主题。
 * 只保留 Android 首版需要的语义色，避免把 Web 的 CSS 变量整套搬进来。
 */
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
  danger: "#A83244",
  dangerText: "#E68A96",
  onGold: "#0B0810",
} as const;

export const Fonts = {
  /** 标题：宋体 / 衬线，接近 Web 的 display */
  display: Platform.select({
    ios: "Songti SC",
    android: "serif",
    default: "serif",
  })!,
  /** 正文：系统无衬线 */
  body: Platform.select({
    ios: "PingFang SC",
    android: "sans-serif",
    default: "sans-serif",
  })!,
  /** 数字：等宽 */
  mono: Platform.select({
    ios: "Menlo",
    android: "monospace",
    default: "monospace",
  })!,
} as const;

export const R = {
  card: 18,
  tile: 14,
  btn: 12,
  pill: 999,
} as const;

export const S = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;
