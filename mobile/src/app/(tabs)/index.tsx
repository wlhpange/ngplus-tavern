import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { useCallback, useRef, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { C, Fonts, R, S } from "@/constants/theme";
import {
  addMessage,
  deleteMessage,
  listMessages,
  newId,
  type StoredMessage,
} from "@/lib/db";
import { isConfigured, loadConfig, type ApiConfig } from "@/lib/settings";
import { streamChat, type ChatMessage } from "@/lib/llm";

const GREETING = "哟，是你啊。坐吧，茶刚沏上。今天想聊点什么？";

const SYSTEM_PROMPT: ChatMessage = {
  role: "system",
  content:
    "你是「二周目协会」的会长薇拉。说话简短、有分寸，像一个见过世面的人。" +
    "不要解释自己是 AI，不要用列表，像面对面聊天。",
};

export default function ChatScreen() {
  const router = useRouter();
  const listRef = useRef<FlatList<StoredMessage>>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [msgs, setMsgs] = useState<StoredMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [cfg, setCfg] = useState<ApiConfig>({ baseUrl: "", model: "", key: "" });
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      const stored = listMessages();
      if (stored.length === 0) {
        const greet: StoredMessage = {
          id: newId(),
          role: "assistant",
          content: GREETING,
          createdAt: Date.now(),
        };
        addMessage(greet);
        setMsgs([greet]);
      } else {
        setMsgs(stored);
      }
      loadConfig().then(setCfg).catch(() => {});
    }, []),
  );

  const scrollToEnd = useCallback(() => {
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;
    if (!isConfigured(cfg)) {
      setError("先在「设置」里填接口地址和模型名。");
      return;
    }

    setError(null);
    setInput("");
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});

    const userMsg: StoredMessage = {
      id: newId(),
      role: "user",
      content: text,
      createdAt: Date.now(),
    };
    addMessage(userMsg);

    const assistantId = newId();
    const placeholder: StoredMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      createdAt: Date.now() + 1,
    };
    setMsgs((prev) => [...prev, userMsg, placeholder]);
    setBusy(true);

    const history: ChatMessage[] = [
      SYSTEM_PROMPT,
      ...msgs
        .filter((m) => m.content.trim())
        .map((m) => ({ role: m.role, content: m.content })),
      { role: "user" as const, content: text },
    ];

    const controller = new AbortController();
    abortRef.current = controller;
    let acc = "";

    try {
      await streamChat(cfg, history, {
        signal: controller.signal,
        onDelta: (delta) => {
          acc += delta;
          setMsgs((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, content: acc } : m)),
          );
        },
      });
      if (!acc.trim()) throw new Error("接口没有返回内容");
      addMessage({ ...placeholder, content: acc });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } catch (e) {
      setMsgs((prev) => prev.filter((m) => m.id !== assistantId));
      deleteMessage(assistantId);
      const msg = e instanceof Error ? e.message : "发送失败";
      setError(controller.signal.aborted ? "已停止" : msg);
    } finally {
      setBusy(false);
      abortRef.current = null;
      scrollToEnd();
    }
  }, [busy, cfg, input, msgs, scrollToEnd]);

  const configured = isConfigured(cfg);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>薇</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>二周目协会</Text>
          <Text style={styles.subtitle}>会长 · 薇拉</Text>
        </View>
      </View>

      {!configured && (
        <Pressable style={styles.banner} onPress={() => router.push("/settings")}>
          <Ionicons name="key-outline" size={16} color={C.gold} />
          <Text style={styles.bannerText}>还没接模型，点这里去填接口地址</Text>
          <Ionicons name="chevron-forward" size={14} color={C.gold} />
        </Pressable>
      )}

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <FlatList
          ref={listRef}
          data={msgs}
          keyExtractor={(m) => m.id}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={scrollToEnd}
          renderItem={({ item }) => {
            const mine = item.role === "user";
            const empty = item.role === "assistant" && !item.content;
            return (
              <View style={[styles.row, mine ? styles.rowMine : styles.rowOther]}>
                <View style={[styles.bubble, mine ? styles.mine : styles.other]}>
                  <Text style={[styles.msgText, mine && styles.mineText]}>
                    {empty ? "……" : item.content}
                  </Text>
                </View>
              </View>
            );
          }}
        />

        {error ? (
          <View style={styles.errorBar}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        <View style={styles.inputBar}>
          <TextInput
            style={styles.input}
            value={input}
            onChangeText={setInput}
            placeholder="和会长说说今天……"
            placeholderTextColor={C.faint}
            multiline
            maxLength={2000}
          />
          {busy ? (
            <Pressable onPress={stop} style={styles.stopBtn} accessibilityLabel="停止">
              <Ionicons name="stop" size={18} color={C.dangerText} />
            </Pressable>
          ) : (
            <Pressable
              onPress={() => void send()}
              disabled={!input.trim()}
              style={[styles.sendBtn, !input.trim() && styles.sendDisabled]}
              accessibilityLabel="发送"
            >
              <Ionicons name="arrow-up" size={20} color={C.onGold} />
            </Pressable>
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  flex: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: S.md,
    paddingHorizontal: S.lg,
    paddingVertical: S.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.border,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: C.goldSoft,
    borderWidth: 1,
    borderColor: C.goldLine,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    fontFamily: Fonts.display,
    fontSize: 18,
    color: C.gold,
  },
  title: {
    fontFamily: Fonts.display,
    fontSize: 19,
    color: C.fg,
    letterSpacing: 0.5,
  },
  subtitle: {
    fontFamily: Fonts.body,
    fontSize: 12,
    color: C.muted,
    marginTop: 1,
  },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: S.sm,
    marginHorizontal: S.lg,
    marginTop: S.md,
    paddingHorizontal: S.md,
    paddingVertical: 10,
    borderRadius: R.btn,
    backgroundColor: C.goldSoft,
    borderWidth: 1,
    borderColor: C.goldLine,
  },
  bannerText: {
    flex: 1,
    fontFamily: Fonts.body,
    fontSize: 12,
    color: C.gold,
  },
  list: {
    padding: S.lg,
    gap: 10,
    paddingBottom: S.lg,
  },
  row: {
    flexDirection: "row",
  },
  rowMine: { justifyContent: "flex-end" },
  rowOther: { justifyContent: "flex-start" },
  bubble: {
    maxWidth: "82%",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 16,
  },
  mine: {
    backgroundColor: C.accentSoft,
    borderWidth: 1,
    borderColor: C.accentLine,
    borderBottomRightRadius: 6,
  },
  other: {
    backgroundColor: C.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.border,
    borderBottomLeftRadius: 6,
  },
  msgText: {
    fontFamily: Fonts.body,
    fontSize: 15,
    lineHeight: 22,
    color: C.fg,
  },
  mineText: { color: C.fg },
  errorBar: {
    marginHorizontal: S.lg,
    marginBottom: S.sm,
    paddingHorizontal: S.md,
    paddingVertical: 8,
    borderRadius: R.btn,
    backgroundColor: "rgba(168,50,68,0.18)",
    borderWidth: 1,
    borderColor: C.danger,
  },
  errorText: {
    fontFamily: Fonts.body,
    fontSize: 12,
    color: C.dangerText,
  },
  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: S.sm,
    paddingHorizontal: S.lg,
    paddingTop: S.sm,
    paddingBottom: S.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.border,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 12,
    borderRadius: 22,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
    color: C.fg,
    fontFamily: Fonts.body,
    fontSize: 15,
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: C.gold,
    alignItems: "center",
    justifyContent: "center",
  },
  sendDisabled: { opacity: 0.35 },
  stopBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: C.danger,
    alignItems: "center",
    justifyContent: "center",
  },
});
