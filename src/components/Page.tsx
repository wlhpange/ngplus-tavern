import type { ReactNode } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { C, Fonts, S } from "@/constants/theme";

/** 常规页面骨架：标题 + 副标题 + 可滚动内容。 */
export function Page({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.title}>{title}</Text>
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      </View>
      <ScrollView
        contentContainerStyle={styles.body}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: C.bg,
  },
  header: {
    paddingHorizontal: S.lg,
    paddingTop: S.md,
    paddingBottom: S.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.border,
    gap: 2,
  },
  title: {
    fontFamily: Fonts.display,
    fontSize: 26,
    color: C.fg,
    letterSpacing: 1,
  },
  subtitle: {
    fontFamily: Fonts.body,
    fontSize: 12,
    color: C.muted,
    letterSpacing: 0.4,
  },
  body: {
    padding: S.lg,
    paddingBottom: S.xxl,
    gap: S.md,
  },
});
