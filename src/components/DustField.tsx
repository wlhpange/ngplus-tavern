import { useEffect, useMemo } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import { Canvas, Circle } from "@shopify/react-native-skia";

/**
 * 淡金尘埃背景：两层不同速度、不同粒径的静态点阵，整体做极慢的竖直循环位移。
 * 不用逐帧重绘：Canvas 只画一次，位移走 UI 线程的 translateY，几乎不占 CPU。
 * 点阵在上半屏生成后复制一份到下半屏，所以循环接缝处完全对齐。
 */

const GOLD = [217, 176, 97] as const;
const rgba = (alpha: number) => `rgba(${GOLD[0]},${GOLD[1]},${GOLD[2]},${alpha})`;

type Dot = { x: number; y: number; r: number; a: number };

function makeDots(
  seed: number,
  count: number,
  width: number,
  height: number,
  rMin: number,
  rMax: number,
  aMin: number,
  aMax: number,
): Dot[] {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  return Array.from({ length: count }, () => ({
    x: rnd() * width,
    y: rnd() * height,
    r: rMin + rnd() * (rMax - rMin),
    a: aMin + rnd() * (aMax - aMin),
  }));
}

function DustLayer({
  dots,
  width,
  height,
  duration,
}: {
  dots: Dot[];
  width: number;
  height: number;
  duration: number;
}) {
  const y = useSharedValue(0);
  useEffect(() => {
    y.value = 0;
    y.value = withRepeat(withTiming(-height, { duration, easing: Easing.linear }), -1, false);
  }, [duration, height, y]);
  const style = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));
  const all = useMemo(() => [...dots, ...dots.map((d) => ({ ...d, y: d.y + height }))], [dots, height]);

  return (
    <Animated.View style={[StyleSheet.absoluteFill, style]}>
      <Canvas style={{ width, height: height * 2 }}>
        {all.map((d, i) => (
          <Circle key={i} cx={d.x} cy={d.y} r={d.r} color={rgba(d.a)} />
        ))}
      </Canvas>
    </Animated.View>
  );
}

export function DustField({ intensity = 1 }: { intensity?: number }) {
  const { width, height } = useWindowDimensions();
  // 近处：大一点、亮一点、落得快；远处：细密、几乎看不见
  const near = useMemo(
    () => makeDots(17, Math.round(14 * intensity), width, height, 1.0, 2.1, 0.08, 0.2),
    [width, height, intensity],
  );
  const far = useMemo(
    () => makeDots(91, Math.round(34 * intensity), width, height, 0.45, 1.2, 0.03, 0.1),
    [width, height, intensity],
  );

  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.clip]}>
      <DustLayer dots={far} width={width} height={height} duration={120_000} />
      <DustLayer dots={near} width={width} height={height} duration={68_000} />
    </View>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: "hidden" },
});
