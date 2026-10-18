import type { Config } from "tailwindcss";

/**
 * 星穹秘契 · Astral Covenant 语义映射（docs/design/DESIGN.md §9）。
 * DESIGN-DECISION: 语义 key 全部用独立命名（rounded-card / text-fs-h1 / shadow-card），
 * 刻意不覆盖 Tailwind 默认刻度（rounded-lg / text-sm 等），
 * 避免未迁移的聊天页与 classic 页面发生视觉漂移；V1.7.1 全站铺开后再统一。
 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        surface: {
          DEFAULT: "var(--surface)",
          2: "var(--surface-2)",
          3: "var(--surface-3)",
        },
        border: "var(--border)",
        "border-strong": "var(--border-strong)",
        fg: "var(--fg)",
        muted: "var(--muted)",
        faint: "var(--faint)",
        accent: "var(--accent)",
        "accent-soft": "var(--accent-soft)",
        "accent-line": "var(--accent-line)",
        gold: "var(--gold)",
        "gold-soft": "var(--gold-soft)",
        "gold-line": "var(--gold-line)",
        "arcane-text": "var(--arcane-text)",
        danger: "var(--danger)",
        "danger-text": "var(--danger-text)",
        success: "var(--success)",
        "success-text": "var(--success-text)",
        "success-soft": "var(--success-soft)",
        "disabled-fg": "var(--disabled-fg)",
        "disabled-bg": "var(--disabled-bg)",
        "disabled-border": "var(--disabled-border)",
        "on-gold": "var(--on-gold)",
        "on-accent": "var(--on-accent)",
        flame: "var(--flame)",
        "attr-vitality": "var(--attr-vitality)",
        "attr-mind": "var(--attr-mind)",
        "attr-will": "var(--attr-will)",
        "attr-wealth": "var(--attr-wealth)",
        "attr-social": "var(--attr-social)",
        "attr-create": "var(--attr-create)",
      },
      fontFamily: {
        display: "var(--font-display)",
        body: "var(--font-body)",
        numeric: "var(--font-mono)",
      },
      fontSize: {
        "fs-display": ["var(--fs-display)", { lineHeight: "var(--lh-tight)" }],
        "fs-h1": ["var(--fs-h1)", { lineHeight: "var(--lh-tight)" }],
        "fs-h2": ["var(--fs-h2)", { lineHeight: "var(--lh-tight)" }],
        "fs-h3": ["var(--fs-h3)", { lineHeight: "var(--lh-body)" }],
        "fs-body": ["var(--fs-body)", { lineHeight: "var(--lh-body)" }],
        "fs-sm": ["var(--fs-sm)", { lineHeight: "var(--lh-body)" }],
        "fs-meta": ["var(--fs-meta)", { lineHeight: "var(--lh-body)" }],
        "fs-micro": ["var(--fs-micro)", { lineHeight: "var(--lh-tight)" }],
      },
      borderRadius: {
        card: "var(--radius-lg)",
        tile: "var(--radius)",
        btn: "var(--radius-sm)",
        chip: "var(--radius-xs)",
        pill: "var(--radius-pill)",
      },
      boxShadow: {
        card: "var(--shadow-1)",
        overlay: "var(--shadow-2)",
        "glow-accent": "var(--glow-accent)",
        "glow-gold": "var(--glow-gold)",
        "inset-gold": "var(--inset-gold)",
      },
    },
  },
  plugins: [],
};

export default config;
