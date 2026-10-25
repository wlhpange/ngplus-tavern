import Svg, { Circle, Line, Polygon, Text as SvgText } from "react-native-svg";

import { ATTR_LABEL, ATTR_ORDER } from "@/weblib/labels";
import { A, C, Fonts } from "@/constants/theme";

/** 属性星图：六边形雷达 + 中心唯一 KPI。 */
export function RadarChart({
  values,
  centerLabel,
  size = 260,
  maxLevel = 12,
}: {
  values: { key: string; level: number }[];
  centerLabel: string;
  size?: number;
  maxLevel?: number;
}) {
  const cx = size / 2;
  const cy = size / 2;
  const radius = size * 0.34;
  const levels = 4;
  const n = ATTR_ORDER.length;
  const angle = (i: number) => (Math.PI * 2 * i) / n - Math.PI / 2;
  const point = (i: number, r: number) => [cx + Math.cos(angle(i)) * r, cy + Math.sin(angle(i)) * r] as const;

  const ring = (k: number) =>
    ATTR_ORDER.map((_, i) => point(i, (radius * k) / levels).join(",")).join(" ");

  const levelMap = new Map(values.map((v) => [v.key, v.level]));
  const dataPoints = ATTR_ORDER.map((k, i) => {
    const raw = levelMap.get(k) ?? 1;
    const ratio = Math.min(1, Math.max(0.08, raw / maxLevel));
    return point(i, radius * ratio).join(",");
  }).join(" ");

  return (
    <Svg width={size} height={size}>
      {Array.from({ length: levels }).map((_, k) => (
        <Polygon
          key={k}
          points={ring(k + 1)}
          fill={k === levels - 1 ? "rgba(217,176,97,0.04)" : "none"}
          stroke={k === levels - 1 ? C.goldDim : "rgba(74,56,99,0.5)"}
          strokeWidth={1}
        />
      ))}
      {ATTR_ORDER.map((_, i) => {
        const [x, y] = point(i, radius);
        return <Line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke="rgba(74,56,99,0.35)" strokeWidth={1} />;
      })}
      <Polygon points={dataPoints} fill="rgba(95,216,196,0.18)" stroke={C.accent} strokeWidth={1.6} />
      {ATTR_ORDER.map((k, i) => {
        const [x, y] = point(i, radius + 26);
        return (
          <SvgText
            key={k}
            x={x}
            y={y + 4}
            fill={A[k as keyof typeof A] ?? C.muted}
            fontSize={11}
            fontFamily={Fonts.body}
            textAnchor="middle"
          >
            {ATTR_LABEL[k]}
          </SvgText>
        );
      })}
      <Circle cx={cx} cy={cy} r={20} fill={C.surface2} stroke={C.goldLine} strokeWidth={1} />
      <SvgText x={cx} y={cy + 4} fill={C.gold} fontSize={11} fontFamily={Fonts.mono} textAnchor="middle">
        {centerLabel}
      </SvgText>
    </Svg>
  );
}
