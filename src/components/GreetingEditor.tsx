import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { C, Fonts, R, S } from "@/constants/theme";
import { masterCard, updateMasterCard } from "@/lib/service";
import { Button, Field, Input, MultiInput, haptic } from "./ui";

export function GreetingEditor({
  visible,
  masterId,
  masterName,
  onClose,
  onSaved,
}: {
  visible: boolean;
  masterId: string;
  masterName: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [first, setFirst] = useState("");
  const [alternates, setAlternates] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    try {
      const { card } = masterCard(masterId);
      setFirst(card.first_mes);
      setAlternates(card.alternate_greetings);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "读取失败");
    }
  }, [visible, masterId]);

  const save = () => {
    setSaving(true);
    try {
      updateMasterCard(masterId, { first_mes: first, alternate_greetings: alternates });
      haptic("success");
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <View style={styles.header}>
          <Text style={styles.title}>{masterName} · 开场白</Text>
          <Pressable onPress={onClose}>
            <Text style={styles.close}>关闭</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <Field label="正式开场白（first_mes）" hint="新对话的第一条消息；支持 {{char}} / {{user}} 宏。">
            <MultiInput value={first} onChangeText={setFirst} maxLength={800} />
          </Field>
          <Text style={styles.section}>备选开场白（换一条时轮换）</Text>
          {alternates.map((g, i) => (
            <View key={i} style={styles.altRow}>
              <MultiInput
                value={g}
                onChangeText={(v) => setAlternates((prev) => prev.map((x, j) => (j === i ? v : x)))}
                maxLength={800}
                style={{ flex: 1, minHeight: 64 }}
              />
              <Pressable onPress={() => setAlternates((prev) => prev.filter((_, j) => j !== i))} style={styles.remove}>
                <Text style={styles.removeText}>删</Text>
              </Pressable>
            </View>
          ))}
          {alternates.length < 8 ? (
            <Button variant="outline" small onPress={() => setAlternates((prev) => [...prev, ""])}>
              + 添加备选开场白
            </Button>
          ) : null}
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Button variant="gold" onPress={save} loading={saving}>
            保存开场白
          </Button>
          <Text style={styles.hint}>已经开口的会话不能换开场白；新开会话才会使用新内容。</Text>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: S.lg,
    paddingVertical: S.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.border,
  },
  title: { flex: 1, fontFamily: Fonts.display, fontSize: 20, color: C.fg },
  close: { fontFamily: Fonts.body, fontSize: 13, color: C.muted },
  body: { padding: S.lg, paddingBottom: S.xxl, gap: S.md },
  section: { fontFamily: Fonts.display, fontSize: 16, color: C.gold, marginTop: S.sm },
  altRow: { flexDirection: "row", gap: S.sm, alignItems: "flex-start" },
  remove: {
    width: 38,
    height: 38,
    borderRadius: R.btn,
    borderWidth: 1,
    borderColor: C.danger,
    alignItems: "center",
    justifyContent: "center",
  },
  removeText: { fontFamily: Fonts.body, fontSize: 12, color: C.dangerText },
  error: { fontFamily: Fonts.body, fontSize: 12, color: C.dangerText },
  hint: { fontFamily: Fonts.body, fontSize: 10, color: C.faint, lineHeight: 16 },
});
