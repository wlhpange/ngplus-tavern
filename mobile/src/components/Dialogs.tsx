import { useEffect, useState, type ReactNode } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { BlurView } from "expo-blur";

import { Button, Input, MultiInput } from "./ui";
import { C, Fonts, R, S } from "@/constants/theme";

function Overlay({ visible, onClose, children }: { visible: boolean; onClose: () => void; children: ReactNode }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <BlurView intensity={18} tint="dark" style={StyleSheet.absoluteFill} />
        <Pressable style={styles.card} onPress={(e) => e.stopPropagation()}>
          {children}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export function ConfirmDialog({
  visible,
  title,
  description,
  confirmLabel = "确认",
  cancelLabel = "取消",
  busy,
  danger,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Overlay visible={visible} onClose={onCancel}>
      <Text style={styles.title}>{title}</Text>
      {description ? <Text style={styles.body}>{description}</Text> : null}
      <View style={styles.row}>
        <Button variant="outline" onPress={onCancel} style={{ flex: 1 }} disabled={busy}>
          {cancelLabel}
        </Button>
        <Button variant={danger ? "danger" : "gold"} onPress={onConfirm} style={{ flex: 1 }} loading={busy}>
          {confirmLabel}
        </Button>
      </View>
    </Overlay>
  );
}

export function PromptDialog({
  visible,
  title,
  label,
  initialValue = "",
  placeholder,
  confirmLabel = "保存",
  multiline,
  maxLength,
  busy,
  onSubmit,
  onCancel,
}: {
  visible: boolean;
  title: string;
  label?: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  multiline?: boolean;
  maxLength?: number;
  busy?: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  useEffect(() => {
    if (visible) setValue(initialValue);
  }, [visible, initialValue]);
  return (
    <Overlay visible={visible} onClose={onCancel}>
      <Text style={styles.title}>{title}</Text>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      {multiline ? (
        <MultiInput value={value} onChangeText={setValue} placeholder={placeholder} maxLength={maxLength} />
      ) : (
        <Input value={value} onChangeText={setValue} placeholder={placeholder} maxLength={maxLength} autoFocus />
      )}
      <View style={styles.row}>
        <Button variant="outline" onPress={onCancel} style={{ flex: 1 }} disabled={busy}>
          取消
        </Button>
        <Button variant="gold" onPress={() => onSubmit(value)} style={{ flex: 1 }} loading={busy}>
          {confirmLabel}
        </Button>
      </View>
    </Overlay>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: "center",
    padding: S.xl,
    backgroundColor: "rgba(11,8,16,0.55)",
  },
  card: {
    borderRadius: R.card,
    borderWidth: 1,
    borderColor: C.goldLine,
    backgroundColor: C.surface,
    padding: S.lg,
    gap: S.md,
  },
  title: { fontFamily: Fonts.display, fontSize: 20, color: C.fg },
  body: { fontFamily: Fonts.body, fontSize: 13, color: C.muted, lineHeight: 20 },
  label: { fontFamily: Fonts.body, fontSize: 11, color: C.muted },
  row: { flexDirection: "row", gap: S.sm, marginTop: S.xs },
});
