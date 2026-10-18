"use client";

import { ATTR_LABEL } from "@/lib/labels";

interface RadarChartProps {
  /** 六维等级（用于归一化） */
  values: { key: string; level: number }[];
  size?: number;
  /** 圆心唯一短 KPI（DESIGN.md §7.5：同心层内不放其他文字） */
  centerLabel?: string;
}

/**
 * 手绘 SVG 六维星座雷达（不用重型图表库）。
 * 星穹秘契规范 §7.5：4 圈同心星轨网格、青色数据面 + 发亮星点，
 * 形状必须按真实数值绘制；分类色/标签只出现在顶点外侧。
 * 归一化：以 max(10, 最高维等级) 为满格，避免早期图形缩成一个点。
 */
export default function RadarChart({
  values,
  size = 220,
  centerLabel,
}: RadarChartProps) {
  const cx = size / 2;
  const cy = size / 2;
  const radius = size / 2 - 34;
  const n = values.length;
  const maxLevel = Math.max(10, ...values.map((v) => v.level));

  // 从正上方开始，顺时针
  const point = (i: number, ratio: number) => {
    const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
    return [
      cx + Math.cos(angle) * radius * ratio,
      cy + Math.sin(angle) * radius * ratio,
    ] as const;
  };

  const ring = (ratio: number) =>
    values.map((_, i) => point(i, ratio).join(",")).join(" ");

  const valuePolygon = values
    .map((v, i) => point(i, Math.min(1, v.level / maxLevel)).join(","))
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className="mx-auto block w-full max-w-[240px]"
      role="img"
      aria-label="六维属性星图"
    >
      {/* 星轨网格：4 圈（25/50/75/100%），网格线用 border 60% */}
      {[0.25, 0.5, 0.75, 1].map((r) => (
        <polygon
          key={r}
          points={ring(r)}
          fill="none"
          stroke="var(--border)"
          strokeOpacity={r === 1 ? 1 : 0.6}
          strokeWidth="1"
        />
      ))}
      {/* 轴线 */}
      {values.map((_, i) => {
        const [x, y] = point(i, 1);
        return (
          <line
            key={i}
            x1={cx}
            y1={cy}
            x2={x}
            y2={y}
            stroke="var(--border)"
            strokeWidth="1"
          />
        );
      })}
      {/* 数据面：accent 18% 填充 + accent-line 描边 */}
      <polygon
        points={valuePolygon}
        fill="var(--accent)"
        fillOpacity="0.18"
        stroke="var(--accent-line)"
        strokeWidth="1.5"
      />
      {/* 顶点星点：辉光晕 + 亮核（星点着落 §6.2） */}
      {values.map((v, i) => {
        const [x, y] = point(i, Math.min(1, v.level / maxLevel));
        return (
          <g key={v.key}>
            <circle cx={x} cy={y} r="6" fill="var(--accent)" opacity="0.25" />
            <circle cx={x} cy={y} r="2.5" fill="var(--accent)" />
          </g>
        );
      })}
      {/* 圆心唯一短 KPI */}
      {centerLabel && (
        <text
          x={cx}
          y={cy}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize="13"
          fill="var(--gold)"
          style={{
            fontFamily: "var(--font-mono)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {centerLabel}
        </text>
      )}
      {/* 轴标签：等宽小字置于顶点外侧 */}
      {values.map((v, i) => {
        const [x, y] = point(i, 1.22);
        return (
          <text
            key={v.key}
            x={x}
            y={y}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize="10.5"
            fill="var(--muted)"
            letterSpacing="0.08"
            style={{
              fontFamily: "var(--font-mono)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {ATTR_LABEL[v.key] ?? v.key} {v.level}
          </text>
        );
      })}
    </svg>
  );
}
