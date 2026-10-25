import type { ReactNode } from "react";
import { useCallback } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

import { A, C, Fonts, R, S, SHADOW } from "@/constants/theme";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export function haptic(kind: "light" | "medium" | "success" | "error" | "select" = "light") {
  try {
    if (kind === "success") void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    else if (kind === "error") void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    else if (kind === "select") void Haptics.selectionAsync();
    else if (kind === "medium") void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    else void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  } catch {
    /* 触感不可用不阻断操作 */
  }
}

export function PressableScale({
  children,
  onPress,
  disabled,
  style,
  hapticKind = "light",
  accessibilityLabel,
  hitSlop,
}: {
  children: ReactNode | ((pressed: boolean) => ReactNode);
  onPress?: () => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  hapticKind?: "light" | "medium" | "success" | "error" | "select";
  accessibilityLabel?: string;
  hitSlop?: number;
}) {
  const scale = useSharedValue(1);
  const anim = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const press = useCallback(() => {
    if (disabled) return;
    haptic(hapticKind);
    onPress?.();
  }, [disabled, hapticKind, onPress]);
  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      hitSlop={hitSlop}
      onPressIn={() => {
        scale.value = withSpring(0.96, { damping: 18, stiffness: 320 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, { damping: 16, stiffness: 260 });
      }}
      onPress={press}
      style={[style, anim, disabled ? { opacity: 0.45 } : undefined]}
    >
      {typeof children === "function" ? children(false) : children}
    </AnimatedPressable>
  );
}

export function Card({
  children,
  style,
  gold,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  gold?: boolean;
}) {
  return (
    <View
      style={[
        styles.card,
        gold && { borderColor: C.goldLine, backgroundColor: C.surface },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <View style={styles.sectionRow}>
      <Text style={styles.sectionTitle}>{children}</Text>
      {right}
    </View>
  );
}

export function Button({
  children,
  onPress,
  variant = "primary",
  disabled,
  loading,
  style,
  small,
}: {
  children: ReactNode;
  onPress?: () => void;
  variant?: "primary" | "outline" | "ghost" | "gold" | "danger";
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
  small?: boolean;
}) {
  const bg =
    variant === "primary"
      ? C.accent
      : variant === "gold"
        ? C.gold
        : variant === "danger"
          ? C.dangerSoft
          : "transparent";
  const border =
    variant === "outline" ? C.borderStrong : variant === "danger" ? C.danger : variant === "ghost" ? "transparent" : bg;
  const color =
    variant === "primary"
      ? C.onAccent
      : variant === "gold"
        ? C.onGold
        : variant === "danger"
          ? C.dangerText
          : C.fg;
  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled || loading}
      style={[
        styles.button,
        small ? styles.buttonSmall : undefined,
        { backgroundColor: bg, borderColor: border, borderWidth: variant === "ghost" ? 0 : 1 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={color} size="small" />
      ) : (
        <Text style={[styles.buttonText, small && { fontSize: 12 }, { color }]}>{children}</Text>
      )}
    </PressableScale>
  );
}

export function Chip({
  label,
  active,
  onPress,
  tone = "default",
}: {
  label: string;
  active?: boolean;
  onPress?: () => void;
  tone?: "default" | "gold" | "accent" | "danger";
}) {
  const activeBg = tone === "gold" ? C.goldSoft : tone === "danger" ? C.dangerSoft : C.accentSoft;
  const activeBorder = tone === "gold" ? C.goldLine : tone === "danger" ? C.danger : C.accentLine;
  const activeText = tone === "gold" ? C.gold : tone === "danger" ? C.dangerText : C.accent;
  return (
    <PressableScale
      onPress={onPress}
      hapticKind="select"
      style={[
        styles.chip,
        active
          ? { backgroundColor: activeBg, borderColor: activeBorder }
          : { backgroundColor: "transparent", borderColor: C.border },
      ]}
    >
      <Text style={[styles.chipText, { color: active ? activeText : C.muted }]}>{label}</Text>
    </PressableScale>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={styles.label}>{label}</Text>
      {children}
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

export function Input(props: TextInputProps) {
  return (
    <TextInput
      placeholderTextColor={C.faint}
      selectionColor={C.accent}
      {...props}
      style={[styles.input, props.style]}
    />
  );
}

export function MultiInput(props: TextInputProps) {
  return (
    <TextInput
      multiline
      textAlignVertical="top"
      placeholderTextColor={C.faint}
      selectionColor={C.accent}
      {...props}
      style={[styles.input, styles.multiline, props.style]}
    />
  );
}

export function ProgressBar({
  ratio,
  color = C.accent,
  height = 6,
}: {
  ratio: number;
  color?: string;
  height?: number;
}) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  return (
    <View style={[styles.track, { height }]}>
      <View style={{ width: `${pct * 100}%`, height: "100%", backgroundColor: color, borderRadius: height }} />
    </View>
  );
}

export function Divider() {
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: C.border }} />;
}

export function Loading({ text = "正在翻开协会的登记簿……" }: { text?: string }) {
  return (
    <View style={styles.center}>
      <ActivityIndicator color={C.gold} />
      <Text style={styles.mutedText}>{text}</Text>
    </View>
  );
}

export function Empty({ text }: { text: string }) {
  return (
    <View style={styles.center}>
      <Text style={styles.mutedText}>{text}</Text>
    </View>
  );
}

export function ErrorBar({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <Pressable onPress={onRetry} style={styles.errorBar}>
      <Ionicons name="alert-circle-outline" size={16} color={C.dangerText} />
      <Text style={styles.errorText}>{text}</Text>
    </Pressable>
  );
}

export function Screen({
  title,
  subtitle,
  children,
  back,
  onBack,
  right,
  scroll = true,
  contentStyle,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  back?: boolean;
  onBack?: () => void;
  right?: ReactNode;
  scroll?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
}) {
  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        {back ? (
          <PressableScale onPress={onBack} style={styles.backBtn} accessibilityLabel="返回">
            <Ionicons name="chevron-back" size={22} color={C.gold} />
          </PressableScale>
        ) : null}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
        </View>
        {right}
      </View>
      {scroll ? (
        <ScrollView
          contentContainerStyle={[styles.body, contentStyle]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.body, { flex: 1 }, contentStyle]}>{children}</View>
      )}
    </SafeAreaView>
  );
}

export function AttrDot({ attr }: { attr: string }) {
  return <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: A[attr as keyof typeof A] ?? C.muted }} />;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { key: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <View style={styles.segmented}>
      {options.map((o) => (
        <PressableScale
          key={o.key}
          hapticKind="select"
          onPress={() => onChange(o.key)}
          style={[styles.segmentedItem, value === o.key ? { backgroundColor: C.accent } : undefined]}
        >
          <Text style={[styles.segmentedText, { color: value === o.key ? C.onAccent : C.muted }]}>{o.label}</Text>
        </PressableScale>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: S.sm,
    paddingHorizontal: S.lg,
    paddingVertical: S.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.border,
  },
  backBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: C.surface2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.border,
  },
  title: { fontFamily: Fonts.display, fontSize: 24, color: C.fg, letterSpacing: 0.8 },
  subtitle: { fontFamily: Fonts.body, fontSize: 11, color: C.muted, marginTop: 2, letterSpacing: 0.3 },
  body: { padding: S.lg, paddingBottom: S.xxl, gap: S.md },
  card: {
    backgroundColor: C.surface,
    borderRadius: R.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.border,
    padding: S.lg,
    gap: S.sm,
    ...SHADOW.card,
  },
  sectionRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: S.sm,
    marginTop: S.sm,
  },
  sectionTitle: { fontFamily: Fonts.display, fontSize: 18, color: C.gold },
  button: {
    minHeight: 44,
    borderRadius: R.btn,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: S.lg,
  },
  buttonSmall: { minHeight: 32, paddingHorizontal: S.md, borderRadius: 10 },
  buttonText: { fontFamily: Fonts.body, fontSize: 14, fontWeight: "600", letterSpacing: 0.3 },
  chip: {
    borderRadius: R.pill,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  chipText: { fontFamily: Fonts.body, fontSize: 12 },
  label: { fontFamily: Fonts.body, fontSize: 11, color: C.muted, letterSpacing: 0.6 },
  hint: { fontFamily: Fonts.body, fontSize: 10, color: C.faint, lineHeight: 15 },
  input: {
    minHeight: 44,
    borderRadius: R.btn,
    borderWidth: 1,
    borderColor: C.borderStrong,
    backgroundColor: C.surface2,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: C.fg,
    fontFamily: Fonts.body,
    fontSize: 14,
  },
  multiline: { minHeight: 88, paddingTop: 10 },
  track: { flex: 1, borderRadius: 99, backgroundColor: C.surface3, overflow: "hidden" },
  center: { alignItems: "center", justifyContent: "center", gap: S.sm, paddingVertical: S.xxl },
  mutedText: { fontFamily: Fonts.body, fontSize: 13, color: C.muted, textAlign: "center" },
  errorBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: S.sm,
    borderRadius: R.tile,
    borderWidth: 1,
    borderColor: C.danger,
    backgroundColor: C.dangerSoft,
    paddingHorizontal: S.md,
    paddingVertical: 10,
  },
  errorText: { flex: 1, fontFamily: Fonts.body, fontSize: 12, color: C.dangerText, lineHeight: 18 },
  segmented: {
    flexDirection: "row",
    backgroundColor: C.surface2,
    borderRadius: R.pill,
    padding: 3,
    gap: 3,
    alignSelf: "flex-start",
  },
  segmentedItem: { paddingHorizontal: 14, paddingVertical: 5, borderRadius: R.pill },
  segmentedText: { fontFamily: Fonts.body, fontSize: 12, fontWeight: "600" },
});
