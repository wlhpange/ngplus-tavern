import { Linking, StyleSheet, Text, View, type TextStyle } from "react-native";
import { C, Fonts, R, S } from "@/constants/theme";

/**
 * 轻量 Markdown 渲染（GFM 常用子集）：
 * 标题 / 粗体 / 斜体 / 删除线 / 行内代码 / 代码块 / 列表 / 引用 / 链接 / 分隔线。
 * 原生实现，不依赖 WebView。
 */

type InlinePart = { text: string; bold?: boolean; italic?: boolean; strike?: boolean; code?: boolean; url?: string };

function inlineParts(src: string): InlinePart[] {
  const out: InlinePart[] = [];
  const re = /(\*\*[^*]+\*\*|~~[^~]+~~|`[^`]+`|\*[^*\n]+\*|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) out.push({ text: src.slice(last, m.index) });
    const tok = m[0];
    if (tok.startsWith("**")) out.push({ text: tok.slice(2, -2), bold: true });
    else if (tok.startsWith("~~")) out.push({ text: tok.slice(2, -2), strike: true });
    else if (tok.startsWith("`")) out.push({ text: tok.slice(1, -1), code: true });
    else if (tok.startsWith("[")) {
      const mm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (mm) out.push({ text: mm[1], url: mm[2] });
    } else out.push({ text: tok.slice(1, -1), italic: true });
    last = m.index + tok.length;
  }
  if (last < src.length) out.push({ text: src.slice(last) });
  return out;
}

export function MarkdownText({ text, style }: { text: string; style?: TextStyle }) {
  const parts = inlineParts(text);
  return (
    <Text style={[styles.body, style]}>
      {parts.map((p, i) => {
        if (p.url) {
          return (
            <Text
              key={i}
              style={styles.link}
              onPress={() => {
                Linking.openURL(p.url!).catch(() => {});
              }}
            >
              {p.text}
            </Text>
          );
        }
        return (
          <Text
            key={i}
            style={[
              p.bold && styles.bold,
              p.italic && styles.italic,
              p.strike && styles.strike,
              p.code && styles.code,
            ]}
          >
            {p.text}
          </Text>
        );
      })}
    </Text>
  );
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    // fenced code
    if (/^```/.test(line.trim())) {
      const lang = line.trim().slice(3);
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        buf.push(lines[i]);
        i++;
      }
      i++;
      blocks.push(
        <View key={key++} style={styles.codeBlock}>
          {lang ? <Text style={styles.codeLang}>{lang}</Text> : null}
          <Text style={styles.codeText}>{buf.join("\n")}</Text>
        </View>,
      );
      continue;
    }
    // heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const size = h[1].length === 1 ? 22 : h[1].length === 2 ? 19 : 16;
      blocks.push(
        <Text key={key++} style={[styles.heading, { fontSize: size }]}>
          {inlineParts(h[2]).map((p, j) => (
            <Text key={j} style={[p.bold && styles.bold, p.code && styles.code]}>
              {p.text}
            </Text>
          ))}
        </Text>,
      );
      i++;
      continue;
    }
    // hr
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      blocks.push(<View key={key++} style={styles.hr} />);
      i++;
      continue;
    }
    // blockquote
    if (line.trim().startsWith(">")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        buf.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      blocks.push(
        <View key={key++} style={styles.quote}>
          <MarkdownText text={buf.join("\n")} />
        </View>,
      );
      continue;
    }
    // list
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const ordered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (bullet || ordered) {
      const items: { marker: string; text: string }[] = [];
      while (i < lines.length) {
        const b = lines[i].match(/^\s*[-*+]\s+(.*)$/);
        const o = lines[i].match(/^\s*(\d+)[.)]\s+(.*)$/);
        if (b) {
          items.push({ marker: "•", text: b[1] });
          i++;
        } else if (o) {
          items.push({ marker: `${o[1]}.`, text: o[2] });
          i++;
        } else break;
      }
      blocks.push(
        <View key={key++} style={{ gap: 3 }}>
          {items.map((it, j) => (
            <View key={j} style={styles.listRow}>
              <Text style={[styles.body, styles.marker]}>{it.marker}</Text>
              <MarkdownText text={it.text} style={{ flex: 1 }} />
            </View>
          ))}
        </View>,
      );
      continue;
    }
    // paragraph
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^```/.test(lines[i].trim()) &&
      !/^#{1,6}\s+/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*(\d+)[.)]\s+/.test(lines[i]) &&
      !lines[i].trim().startsWith(">")
    ) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push(<MarkdownText key={key++} text={buf.join("\n")} />);
  }

  return <View style={{ gap: 6 }}>{blocks}</View>;
}

const styles = StyleSheet.create({
  body: { fontFamily: Fonts.body, fontSize: 14, lineHeight: 22, color: C.fg },
  bold: { fontWeight: "700" },
  italic: { fontStyle: "italic" },
  strike: { textDecorationLine: "line-through", color: C.muted },
  code: {
    fontFamily: Fonts.mono,
    fontSize: 12,
    color: C.accent,
    backgroundColor: C.surface2,
  },
  link: { color: C.accent, textDecorationLine: "underline" },
  heading: { fontFamily: Fonts.display, color: C.gold, marginTop: 2 },
  hr: { height: StyleSheet.hairlineWidth, backgroundColor: C.border, marginVertical: 4 },
  quote: {
    borderLeftWidth: 2,
    borderLeftColor: C.goldLine,
    paddingLeft: S.md,
    paddingVertical: 2,
  },
  codeBlock: {
    backgroundColor: C.surface2,
    borderRadius: R.tile,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.border,
    padding: S.md,
    gap: 4,
  },
  codeLang: { fontFamily: Fonts.mono, fontSize: 9, color: C.faint, textTransform: "uppercase" },
  codeText: { fontFamily: Fonts.mono, fontSize: 12, lineHeight: 18, color: C.fg },
  listRow: { flexDirection: "row", gap: S.sm, alignItems: "flex-start" },
  marker: { color: C.gold, width: 16 },
});
