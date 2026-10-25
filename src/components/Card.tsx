import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { C, R, S } from "@/constants/theme";

export function Card({ children }: { children: ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: C.surface,
    borderRadius: R.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.border,
    padding: S.lg,
    gap: S.sm,
  },
});
