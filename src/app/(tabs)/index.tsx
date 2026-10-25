import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Redirect, useFocusEffect, useRouter } from "expo-router";
import {
  ActivityIndicator,
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
import { Ionicons } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import Animated, { FadeIn, useAnimatedKeyboard, useAnimatedStyle } from "react-native-reanimated";

import { C, Fonts, R, S } from "@/constants/theme";
import { Avatar } from "@/components/Avatar";
import { Markdown } from "@/components/Markdown";
import { SettlementCard, type SettlementCardData } from "@/components/SettlementCard";
import { CeremonyOverlay, type CeremonyEvent } from "@/components/CeremonyOverlay";
import { DustField } from "@/components/DustField";
import { SparkleLoop } from "@/components/Sparkle";
import { GreetingEditor } from "@/components/GreetingEditor";
import { ImageLightbox } from "@/components/ImageLightbox";
import { ConfirmDialog, PromptDialog } from "@/components/Dialogs";
import { PixelPet } from "@/components/PixelPet";
import type { PetDescriptor } from "@/weblib/petCatalog";
import { detectFace, type FaceId } from "@/weblib/mood";
import { Button, Chip, ErrorBar, haptic, PressableScale, Segmented } from "@/components/ui";
import { useToast } from "@/components/Toast";
import {
  chatScreenData,
  cycleGreeting as cycleGreetingService,
  deleteChatMessage,
  getUiPref,
  onboardingState,
  sceneStatus,
  sendChat,
  sessionAction,
  setUiPref,
  startScene,
  cancelScene,
  uploadBackground,
} from "@/lib/service";
import { useUiPrefOn } from "@/lib/uiPrefs";

type Mode = "quest" | "chat";
interface ApiMessage {
  id: string;
  role: "user" | "master";
  content: string;
  sender: string;
  createdAt: number;
  image?: string | null;
  generating?: boolean;
  generatingSince?: number;
}
type TimelineItem =
  | { type: "message"; message: ApiMessage; local?: boolean }
  | { type: "settlement"; settlement: SettlementCardData; fresh?: boolean };
interface Notice {
  text: string;
  at: number;
}
type Row = { key: string; kind: "day"; label: string } | { key: string; kind: "item"; item: TimelineItem };

const MODE_KEY = "chat.mode";
const RENDER_PAGE = 60;

function dayKey(ts: number) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
function dayLabel(ts: number) {
  const d = new Date(ts);
  const now = new Date();
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (dayKey(ts) === dayKey(now.getTime())) return "今天";
  if (dayKey(ts) === dayKey(y.getTime())) return "昨天";
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}
function itemTime(it: TimelineItem) {
  return it.type === "message" ? it.message.createdAt : it.settlement.createdAt;
}
function itemRank(it: TimelineItem) {
  if (it.type === "settlement") return 1;
  return it.message.role === "user" ? 0 : 2;
}
function itemKey(it: TimelineItem) {
  return it.type === "message" ? it.message.id : `s_${it.settlement.id}`;
}
function mergeItems(base: TimelineItem[], add: TimelineItem[]): TimelineItem[] {
  const map = new Map<string, TimelineItem>();
  for (const it of [...base, ...add]) map.set(itemKey(it), it);
  return [...map.values()].sort((a, b) => itemTime(a) - itemTime(b) || itemRank(a) - itemRank(b));
}

export default function ChatScreen() {
  const router = useRouter();
  const toast = useToast();
  const [onboarded, setOnboarded] = useState<boolean | null>(null);
  const [mode, setMode] = useState<Mode>("quest");
  const [modeReady, setModeReady] = useState(false);
  const [items, setItems] = useState<TimelineItem[] | null>(null);
  const [masterName, setMasterName] = useState("会长");
  const [masterAvatar, setMasterAvatar] = useState<string | null>(null);
  const [masterSprite, setMasterSprite] = useState<PetDescriptor | null>(null);
  const [background, setBackground] = useState<string | null>(null);
  const [imageEnabled, setImageEnabled] = useState(false);
  const [hasEarlier, setHasEarlier] = useState(false);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<{ id: string; title: string; updatedAt: number; messageCount: number }[]>([]);
  const [greeting, setGreeting] = useState<{ greetings: string[]; currentIndex: number } | null>(null);
  const [activeMasterId, setActiveMasterId] = useState<string | null>(null);
  const [userSpoke, setUserSpoke] = useState(false);
  const [serverPending, setServerPending] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [streamingReply, setStreamingReply] = useState("");
  const [sendingCtx, setSendingCtx] = useState<{ mode: Mode; sessionId: string | null } | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(RENDER_PAGE);
  const [showJump, setShowJump] = useState(false);
  const [sessionMenu, setSessionMenu] = useState(false);
  const [bgPanel, setBgPanel] = useState(false);
  const [bgUploading, setBgUploading] = useState(false);
  const [greetingEditor, setGreetingEditor] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{ id: string; title: string } | null>(null);
  const [deleteSessionTarget, setDeleteSessionTarget] = useState<{ id: string; title: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; preview: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [ceremony, setCeremony] = useState<CeremonyEvent | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [sceneBusy, setSceneBusy] = useState<string | null>(null);
  const [sceneStartedAt, setSceneStartedAt] = useState<number | null>(null);
  const [sceneElapsed, setSceneElapsed] = useState(0);
  const [sceneError, setSceneError] = useState<string | null>(null);
  const showPet = useUiPrefOn("pet");
  const [petReact, setPetReact] = useState(false);
  const [moodFace, setMoodFace] = useState<FaceId | null>(null);
  const [chatLoadingEarlier, setChatLoadingEarlier] = useState(false);

  // Android edge-to-edge 下 adjustResize 不会缩窗口：用键盘高度抬起输入栏
  const keyboard = useAnimatedKeyboard();
  const keyboardLift = useAnimatedStyle(() => ({
    // 键盘高度包含底部 tab bar / 系统导航区，减掉这部分再留 8px 间距
    paddingBottom: Platform.OS === "android" ? Math.max(8, keyboard.height.value - 64) : 8,
  }));

  const listRef = useRef<FlatList<Row>>(null);
  const nearBottom = useRef(true);
  const initialPositioned = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const moodTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modeRef = useRef<Mode>("quest");
  const sessionRef = useRef<string | null>(null);
  modeRef.current = mode;
  sessionRef.current = sessionId;

  const sendingHere = sending && sendingCtx?.mode === mode && sendingCtx?.sessionId === sessionId;

  useEffect(() => {
    setOnboarded(onboardingState().onboarded);
    setMode(getUiPref(MODE_KEY, "quest") === "chat" ? "chat" : "quest");
    setModeReady(true);
  }, []);

  const loadTimeline = useCallback((m: Mode, sessId?: string | null, opts?: { quiet?: boolean }) => {
    try {
      const d = chatScreenData(m, sessId);
      setMasterName(d.masterName);
      setMasterAvatar(d.masterAvatar);
      setMasterSprite(d.masterSprite);
      setBackground(d.background);
      setImageEnabled(d.imageEnabled);
      setHasEarlier(d.hasEarlier);
      if (!opts?.quiet) setNextBefore(d.nextBefore);
      setGreeting(d.greeting ?? null);
      setActiveMasterId(d.activeMasterId);
      setSessionId(d.sessionId ?? null);
      setSessions(d.sessions);
      setServerPending(Boolean(d.pending));
      setUserSpoke(d.messages.some((m) => m.role === "user"));
      const msgs: TimelineItem[] = d.messages.map((msg) => ({ type: "message", message: msg }));
      const sets: TimelineItem[] = d.settlements.map((s) => ({ type: "settlement", settlement: s as SettlementCardData }));
      setItems((prev) => (opts?.quiet && m === "chat" ? mergeItems(prev ?? [], mergeItems(msgs, sets)) : mergeItems(msgs, sets)));
      const gen = d.messages.find((m2) => m2.generating);
      if (gen) {
        setSceneBusy(gen.id);
        setSceneStartedAt(gen.generatingSince ?? Date.now());
      }
      setError(null);
    } catch (e) {
      setItems([]);
      setError(e instanceof Error ? e.message : "没能翻开协会的登记簿。");
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (!modeReady || !onboarded) return;
      loadTimeline(mode);
      return undefined;
    }, [mode, modeReady, onboarded, loadTimeline]),
  );

  // 服务端仍有生成在途：静默轮询到落库
  useEffect(() => {
    if (!serverPending || sendingHere) return;
    const t = setInterval(() => loadTimeline(mode, mode === "chat" ? sessionId : undefined, { quiet: true }), 2500);
    return () => clearInterval(t);
  }, [serverPending, sendingHere, mode, sessionId, loadTimeline]);

  // 生图轮询
  useEffect(() => {
    if (!sceneBusy) return;
    let alive = true;
    const tick = () => {
      const st = sceneStatus(sceneBusy);
      if (!alive) return;
      if (st.status === "done" && st.url) {
        setItems((prev) =>
          (prev ?? []).map((it) =>
            it.type === "message" && it.message.id === sceneBusy
              ? { ...it, message: { ...it.message, image: st.url, generating: false } }
              : it,
          ),
        );
        setSceneBusy(null);
        setSceneStartedAt(null);
      } else if (st.status === "error") {
        setSceneError(st.error ?? "配图失败。");
        setSceneBusy(null);
        setSceneStartedAt(null);
      } else if (st.status === "idle") {
        setSceneBusy(null);
        setSceneStartedAt(null);
      }
    };
    tick();
    const t = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [sceneBusy]);

  useEffect(() => {
    if (sceneStartedAt == null) {
      setSceneElapsed(0);
      return;
    }
    const t = setInterval(() => setSceneElapsed(Math.floor((Date.now() - sceneStartedAt) / 1000)), 1000);
    return () => clearInterval(t);
  }, [sceneStartedAt]);

  useEffect(() => {
    if (!notices.length) return;
    const t = setInterval(() => {
      const cut = Date.now() - 30_000;
      setNotices((n) => n.filter((x) => x.at > cut));
    }, 5000);
    return () => clearInterval(t);
  }, [notices]);

  const rows = useMemo<Row[]>(() => {
    const all = items ?? [];
    const hidden = Math.max(0, all.length - visibleCount);
    const shown = hidden > 0 ? all.slice(hidden) : all;
    const out: Row[] = [];
    let last = "";
    for (const it of shown) {
      const dk = dayKey(itemTime(it));
      if (dk !== last) {
        out.push({ key: `day_${dk}`, kind: "day", label: dayLabel(itemTime(it)) });
        last = dk;
      }
      out.push({ key: itemKey(it), kind: "item", item: it });
    }
    return out;
  }, [items, visibleCount]);

  const hiddenCount = Math.max(0, (items?.length ?? 0) - visibleCount);

  useEffect(() => {
    if (!initialPositioned.current || !nearBottom.current) return;
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: !streamingReply }));
  }, [rows.length, sendingHere, streamingReply]);

  const onScroll = (e: { nativeEvent: { contentOffset: { y: number }; contentSize: { height: number }; layoutMeasurement: { height: number } } }) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const gap = contentSize.height - contentOffset.y - layoutMeasurement.height;
    nearBottom.current = gap < 90;
    setShowJump(gap > 260);
  };

  const jumpLatest = () => {
    nearBottom.current = true;
    setShowJump(false);
    listRef.current?.scrollToEnd({ animated: true });
  };

  const switchMode = (next: Mode) => {
    if (next === mode) return;
    setUiPref(MODE_KEY, next);
    setError(null);
    setNotices([]);
    setCeremony(null);
    setItems(null);
    setVisibleCount(RENDER_PAGE);
    initialPositioned.current = false;
    setMode(next);
  };

  const flashMood = (face: FaceId) => {
    setMoodFace(face);
    if (moodTimer.current) clearTimeout(moodTimer.current);
    moodTimer.current = setTimeout(() => setMoodFace(null), 9000);
  };

  async function send() {
    const text = input.trim();
    if (!text || sending || serverPending) return;
    const localId = `local_u_${Date.now()}`;
    setItems((prev) =>
      mergeItems(prev ?? [], [
        {
          type: "message",
          local: true,
          message: { id: localId, role: "user", content: text, sender: "", createdAt: Date.now() },
        },
      ]),
    );
    setInput("");
    setError(null);
    setSending(true);
    setStreamingReply("");
    setSendingCtx({ mode, sessionId });
    nearBottom.current = true;
    haptic("light");
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const result = await sendChat({
        message: text,
        mode,
        sessionId,
        signal: controller.signal,
        onEvent: (e) => {
          if (e.type === "delta") setStreamingReply((s) => s + e.text);
          else setStreamingReply("");
        },
      });
      const now = Date.now();
      const additions: TimelineItem[] = [];
      for (const s of (result.settlements as SettlementCardData[] | undefined) ?? []) {
        additions.push({ type: "settlement", settlement: s, fresh: true });
      }
      if (result.reply) {
        additions.push({
          type: "message",
          message: {
            id: result.masterMessageId,
            role: "master",
            content: result.reply,
            sender: masterName,
            createdAt: now,
          },
        });
        if (modeRef.current === mode && sessionRef.current === sessionId) flashMood(detectFace(result.reply));
      }
      if (modeRef.current === mode && sessionRef.current === sessionId) {
        setItems((prev) => {
          const base = (prev ?? []).map((it) =>
            it.type === "message" && it.message.id === localId
              ? { ...it, message: { ...it.message, id: result.userMessageId } }
              : it,
          );
          return mergeItems(base, additions);
        });
        const reminders = result.reminderNotices ?? result.settlementNotices ?? [];
        if (reminders.length) {
          const at = Date.now();
          setNotices((n) => [...n, ...reminders.map((x) => ({ text: x, at }))]);
        }
        if (result.ceremony) setCeremony(result.ceremony as CeremonyEvent);
        if (result.sessionId) setSessionId(result.sessionId);
        haptic("success");
      }
    } catch (e) {
      setItems((prev) => (prev ?? []).filter((it) => itemKey(it) !== localId));
      setInput(text);
      setError(e instanceof Error && e.message ? e.message : "网络不通，消息没能送到协会。");
      haptic("error");
    } finally {
      setSending(false);
      setSendingCtx(null);
      setStreamingReply("");
      abortRef.current = null;
    }
  }

  async function loadEarlierChat() {
    if (!sessionId || nextBefore == null || chatLoadingEarlier) return;
    setChatLoadingEarlier(true);
    try {
      const d = chatScreenData("chat", sessionId, nextBefore);
      const older: TimelineItem[] = d.messages.map((msg) => ({ type: "message", message: msg }));
      setItems((prev) => mergeItems(older, prev ?? []));
      setHasEarlier(d.hasEarlier);
      setNextBefore(d.nextBefore);
      setVisibleCount((c) => c + older.length);
    } catch {
      setError("网络不通，没能翻到更早的记录。");
    } finally {
      setChatLoadingEarlier(false);
    }
  }

  async function cycleGreetingAction() {
    if (!sessionId) return;
    try {
      cycleGreetingService(sessionId);
      loadTimeline("chat", sessionId);
      haptic("select");
    } catch (e) {
      setError(e instanceof Error ? e.message : "换不了开场白。");
    }
  }

  function doSessionAction(action: "create" | "rename" | "delete" | "setBackground", extra: { sessionId?: string; title?: string; scene?: string | null }) {
    try {
      const r = sessionAction(action, extra);
      setSessionMenu(false);
      const next = (r as { sessionId?: string; nextSessionId?: string }).sessionId ?? (r as { nextSessionId?: string }).nextSessionId ?? sessionId;
      loadTimeline("chat", next);
      haptic("light");
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败。");
    }
  }

  async function pickBackground() {
    if (!sessionId || bgUploading) return;
    setBgUploading(true);
    try {
      const res = await DocumentPicker.getDocumentAsync({ type: "image/*", copyToCacheDirectory: true, multiple: false });
      if (res.canceled) return;
      const asset = res.assets[0];
      const file = new File(asset.uri);
      const bytes = await file.bytes();
      const scene = uploadBackground(bytes, asset.name || "background.png", asset.mimeType);
      doSessionAction("setBackground", { sessionId, scene });
      setBgPanel(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "背景上传失败。");
    } finally {
      setBgUploading(false);
    }
  }

  async function generateScene(messageId: string) {
    if (sceneBusy) return;
    setSceneError(null);
    try {
      const job = startScene(messageId);
      setSceneBusy(messageId);
      setSceneStartedAt(job.startedAt ?? Date.now());
      haptic("light");
    } catch (e) {
      setSceneError(e instanceof Error ? e.message : "配图失败。");
    }
  }

  async function confirmDelete() {
    const t = deleteTarget;
    if (!t) return;
    setDeleting(true);
    try {
      if (!t.id.startsWith("local_")) deleteChatMessage(t.id);
      setItems((prev) => (prev ?? []).filter((it) => itemKey(it) !== t.id));
      setDeleteTarget(null);
      haptic("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败。");
    } finally {
      setDeleting(false);
    }
  }

  function pokePet() {
    setPetReact(true);
    haptic("light");
    setTimeout(() => setPetReact(false), 1600);
  }

  if (onboarded === false) return <Redirect href="/gate" />;
  if (onboarded === null) return <View style={styles.safe} />;

  const bgVisible = mode === "chat" && Boolean(background);
  const petDescriptor = masterSprite
    ? { ...masterSprite, items: { ...masterSprite.items, face: moodFace ?? masterSprite.items.face } }
    : null;
  const petAnim = sendingHere || serverPending || petReact ? "emote" : "idle";

  return (
    <SafeAreaView style={[styles.safe, bgVisible && { backgroundColor: C.bg }]} edges={["top"]}>
      {bgVisible ? <Animated.Image key={background!} entering={FadeIn} source={{ uri: background! }} style={styles.bgImage} blurRadius={2} /> : null}
      {bgVisible ? <View style={styles.bgShade} /> : null}
      <DustField />

      <View style={styles.header}>
        <Avatar src={masterAvatar} name={masterName} size={40} active />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.headerTitle}>二周目协会</Text>
          <Text style={styles.headerSub} numberOfLines={1}>
            会长 · {masterName}
          </Text>
        </View>
        {mode === "quest" ? (
          <PressableScale onPress={() => router.push("/records")} hapticKind="select" style={styles.headerBtn}>
            <Ionicons name="time-outline" size={15} color={C.muted} />
            <Text style={styles.headerBtnText}>记录</Text>
          </PressableScale>
        ) : null}
      </View>

      <View style={styles.modeBar}>
        <Segmented
          options={[
            { key: "quest", label: "任务" },
            { key: "chat", label: "聊天" },
          ]}
          value={mode}
          onChange={switchMode}
        />
        <View style={{ flex: 1 }} />
        {mode === "chat" && greeting && greeting.greetings.length > 1 && !userSpoke ? (
          <Pressable onPress={cycleGreetingAction}>
            <Text style={styles.modeAction}>换一条开场白 ↻</Text>
          </Pressable>
        ) : mode === "chat" && activeMasterId ? (
          <Pressable onPress={() => setGreetingEditor(true)}>
            <Text style={styles.modeAction}>编辑开场白</Text>
          </Pressable>
        ) : mode === "chat" ? (
          <Text style={styles.modeHint}>自由对话</Text>
        ) : (
          <Text style={styles.modeHint} numberOfLines={1}>
            仅显示与「{masterName}」的对话
          </Text>
        )}
      </View>

      {mode === "chat" ? (
        <>
          <View style={styles.sessionBar}>
            <Pressable style={styles.sessionPick} onPress={() => setSessionMenu((v) => !v)}>
              <Text style={styles.sessionTitle} numberOfLines={1}>
                {sessions.find((s) => s.id === sessionId)?.title ?? "新的对话"}
              </Text>
              <Text style={styles.sessionCount}>{sessions.length} 段 ▾</Text>
            </Pressable>
            <Pressable onPress={() => setBgPanel((v) => !v)} style={[styles.sessionBtn, background && { borderColor: C.goldLine }]}>
              <Text style={[styles.sessionBtnText, background && { color: C.gold }]}>背景</Text>
            </Pressable>
            <Pressable onPress={() => doSessionAction("create", { title: "新的对话" })} style={[styles.sessionBtn, { borderColor: C.accentLine }]}>
              <Text style={[styles.sessionBtnText, { color: C.accent }]}>+ 新对话</Text>
            </Pressable>
          </View>

          {bgPanel ? (
            <View style={styles.bgPanel}>
              <Button variant="outline" small onPress={pickBackground} loading={bgUploading}>
                上传背景图
              </Button>
              {background ? (
                <Button
                  variant="ghost"
                  small
                  onPress={() => {
                    doSessionAction("setBackground", { sessionId: sessionId ?? undefined, scene: null });
                    setBgPanel(false);
                  }}
                >
                  <Text style={{ color: C.dangerText }}>清除背景</Text>
                </Button>
              ) : null}
              <Text style={styles.bgHint}>每个会话一张背景；任务页保持原样。</Text>
            </View>
          ) : null}

          {sessionMenu ? (
            <View style={styles.sessionMenu}>
              {sessions.map((s) => (
                <View key={s.id} style={[styles.sessionRow, s.id === sessionId && { backgroundColor: C.accentSoft }]}>
                  <Pressable
                    style={{ flex: 1, minWidth: 0 }}
                    onPress={() => {
                      setSessionMenu(false);
                      loadTimeline("chat", s.id);
                    }}
                  >
                    <Text style={styles.sessionRowTitle} numberOfLines={1}>
                      {s.title}
                    </Text>
                    <Text style={styles.sessionRowCount}>{s.messageCount} 条消息</Text>
                  </Pressable>
                  <Pressable onPress={() => setRenameTarget({ id: s.id, title: s.title })}>
                    <Text style={styles.sessionRowAction}>改名</Text>
                  </Pressable>
                  {sessions.length > 1 ? (
                    <Pressable onPress={() => setDeleteSessionTarget({ id: s.id, title: s.title })}>
                      <Text style={[styles.sessionRowAction, { color: C.dangerText }]}>删除</Text>
                    </Pressable>
                  ) : null}
                </View>
              ))}
            </View>
          ) : null}
        </>
      ) : null}

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <FlatList
          ref={listRef}
          data={rows}
          keyExtractor={(r) => r.key}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          onScroll={onScroll}
          scrollEventThrottle={16}
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
          onContentSizeChange={() => {
            if (!initialPositioned.current) {
              listRef.current?.scrollToEnd({ animated: false });
              initialPositioned.current = true;
              requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: false }));
            }
          }}
          ListHeaderComponent={
            <View style={{ gap: S.sm }}>
              {items === null ? <Text style={styles.centerHint}>正在翻开协会的登记簿……</Text> : null}
              {items !== null && hasEarlier && mode === "quest" ? (
                <Button variant="outline" small onPress={() => router.push("/records")}>
                  更早的对话在「聊天记录」→
                </Button>
              ) : null}
              {hiddenCount > 0 ? (
                <Button variant="outline" small onPress={() => setVisibleCount((c) => c + RENDER_PAGE)}>
                  展开更早的 {hiddenCount} 条
                </Button>
              ) : null}
              {mode === "chat" && hiddenCount === 0 && hasEarlier ? (
                <Button variant="outline" small onPress={loadEarlierChat} loading={chatLoadingEarlier}>
                  加载更早的对话
                </Button>
              ) : null}
            </View>
          }
          ListEmptyComponent={
            items !== null && !sendingHere && !serverPending ? (
              <View style={styles.emptyBox}>
                <SparkleLoop size={44} opacity={0.75} />
                <Text style={styles.centerHint}>
                  {mode === "chat" ? "屋子里只有你和会长两个人。说点什么吧。" : "协会的门虚掩着，灯火还亮着。说点什么吧。"}
                </Text>
              </View>
            ) : undefined
          }
          renderItem={({ item }) => {
            if (item.kind === "day") {
              return (
                <View style={styles.dayRow}>
                  <View style={styles.dayLine} />
                  <Text style={styles.dayText}>{item.label}</Text>
                  <View style={styles.dayLine} />
                </View>
              );
            }
            const it = item.item;
            if (it.type === "settlement") {
              return <SettlementCard s={it.settlement} fresh={it.fresh} />;
            }
            const msg = it.message;
            if (msg.role === "user") {
              return (
                <View style={{ alignItems: "flex-end" }}>
                  <View style={styles.userBubble}>
                    <Text style={styles.userText}>{msg.content}</Text>
                  </View>
                  <Pressable onPress={() => setDeleteTarget({ id: msg.id, preview: msg.content })}>
                    <Text style={styles.deleteLink}>删除</Text>
                  </Pressable>
                </View>
              );
            }
            const sender = msg.sender || masterName;
            return (
              <View style={{ gap: 4 }}>
                <View style={styles.masterRow}>
                  <Avatar src={sender === masterName ? masterAvatar : null} name={sender} size={26} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.sender}>{sender}</Text>
                    <View style={styles.masterBubble}>
                      <Markdown text={msg.content} />
                    </View>
                    {msg.image ? (
                      <Pressable onPress={() => setLightbox(msg.image!)}>
                        <Animated.Image source={{ uri: msg.image }} style={styles.sceneImage} />
                      </Pressable>
                    ) : null}
                    {sceneBusy === msg.id && !msg.image ? (
                      <View style={styles.sceneBusy}>
                        <ActivityIndicator size="small" color={C.accent} />
                        <Text style={styles.sceneBusyText}>正在作画… 已 {sceneElapsed}s</Text>
                        <Pressable onPress={() => { cancelScene(msg.id); setSceneBusy(null); setSceneStartedAt(null); }}>
                          <Text style={styles.sceneStop}>停止</Text>
                        </Pressable>
                      </View>
                    ) : null}
                    <View style={styles.msgActions}>
                      {mode === "chat" && imageEnabled && !msg.image && sceneBusy !== msg.id ? (
                        <Pressable onPress={() => generateScene(msg.id)} disabled={!!sceneBusy}>
                          <Text style={[styles.msgAction, sceneBusy ? { opacity: 0.4 } : null]}>
                            {sceneBusy ? "另一张正在作画…" : "🖼 给这一幕配图"}
                          </Text>
                        </Pressable>
                      ) : null}
                      <Pressable onPress={() => setDeleteTarget({ id: msg.id, preview: msg.content })}>
                        <Text style={styles.msgAction}>删除</Text>
                      </Pressable>
                    </View>
                  </View>
                </View>
              </View>
            );
          }}
          ListFooterComponent={
            <View style={{ gap: S.sm }}>
              {sendingHere || serverPending ? (
                <View style={styles.masterRow}>
                  <Avatar src={masterAvatar} name={masterName} size={26} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.sender}>{masterName}</Text>
                    <View style={styles.masterBubble}>
                      {streamingReply ? (
                        <Markdown text={streamingReply} />
                      ) : (
                        <View style={{ flexDirection: "row", gap: 4, paddingVertical: 4 }}>
                          <ActivityIndicator size="small" color={C.accent} />
                          <Text style={styles.typing}>正在斟酌措辞……</Text>
                        </View>
                      )}
                    </View>
                  </View>
                </View>
              ) : null}
              {error ? <ErrorBar text={error} onRetry={() => setError(null)} /> : null}
              {sceneError ? (
                <Pressable onPress={() => setSceneError(null)} style={styles.sceneError}>
                  <Text style={styles.sceneErrorTitle}>配图失败</Text>
                  <Text style={styles.sceneErrorText}>{sceneError}</Text>
                </Pressable>
              ) : null}
            </View>
          }
        />
      </KeyboardAvoidingView>

      {notices.length ? (
        <View style={styles.noticeBar}>
          {notices.slice(-3).map((n) => (
            <Text key={n.at + n.text} style={styles.noticeText}>
              {n.text}
            </Text>
          ))}
        </View>
      ) : null}

      <Animated.View style={[styles.inputBar, keyboardLift]}>
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder={mode === "chat" ? "和会长随便聊聊……" : "和会长说说今天……"}
          placeholderTextColor={C.faint}
          style={styles.input}
          multiline
          maxLength={2000}
        />
        {sendingHere ? (
          <Pressable
            style={styles.stopBtn}
            onPress={() => {
              abortRef.current?.abort();
              setSending(false);
              setSendingCtx(null);
              setStreamingReply("");
            }}
          >
            <Ionicons name="stop" size={18} color={C.dangerText} />
          </Pressable>
        ) : (
          <Pressable
            style={[styles.sendBtn, (!input.trim() || serverPending) && { opacity: 0.4 }]}
            disabled={!input.trim() || sending || serverPending}
            onPress={() => void send()}
          >
            <Ionicons name="arrow-up" size={20} color={C.onGold} />
          </Pressable>
        )}
      </Animated.View>

      {showJump ? (
        <Pressable onPress={jumpLatest} style={styles.jump}>
          <Ionicons name="arrow-down" size={18} color={C.gold} />
        </Pressable>
      ) : null}

      {showPet && petDescriptor ? (
        <Pressable onPress={pokePet} style={styles.petWrap} accessibilityLabel={`和${masterName}互动`}>
          <PixelPet descriptor={petDescriptor} animation={petAnim} display={64} face={moodFace} />
        </Pressable>
      ) : null}

      {ceremony ? <CeremonyOverlay event={ceremony} onDone={() => setCeremony(null)} /> : null}
      <ImageLightbox src={lightbox} onClose={() => setLightbox(null)} />
      <GreetingEditor
        visible={greetingEditor}
        masterId={activeMasterId ?? ""}
        masterName={masterName}
        onClose={() => setGreetingEditor(false)}
        onSaved={() => loadTimeline("chat", sessionId)}
      />
      <ConfirmDialog
        visible={!!deleteTarget}
        title="删除这条消息？"
        description={`「${deleteTarget?.preview.slice(0, 40) ?? ""}${(deleteTarget?.preview.length ?? 0) > 40 ? "…" : ""}」删除后无法恢复，它的配图也会一起删掉。`}
        confirmLabel="删除"
        danger
        busy={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
      <PromptDialog
        visible={!!renameTarget}
        title="会话名称"
        initialValue={renameTarget?.title}
        confirmLabel="保存"
        maxLength={40}
        onSubmit={(v) => {
          const t = renameTarget;
          setRenameTarget(null);
          if (t && v.trim()) doSessionAction("rename", { sessionId: t.id, title: v });
        }}
        onCancel={() => setRenameTarget(null)}
      />
      <ConfirmDialog
        visible={!!deleteSessionTarget}
        title="删除这段对话？"
        description={`「${deleteSessionTarget?.title ?? ""}」的聊天记录和它的对话记忆会一起消失，无法恢复。`}
        confirmLabel="删除"
        danger
        onConfirm={() => {
          const t = deleteSessionTarget;
          setDeleteSessionTarget(null);
          if (t) doSessionAction("delete", { sessionId: t.id });
        }}
        onCancel={() => setDeleteSessionTarget(null)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  bgImage: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, width: "100%", height: "100%", opacity: 0.55 },
  bgShade: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, backgroundColor: "rgba(11,8,16,0.45)" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: S.md,
    paddingHorizontal: S.lg,
    paddingVertical: S.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.border,
    backgroundColor: C.surface,
  },
  headerTitle: { fontFamily: Fonts.display, fontSize: 19, color: C.fg, letterSpacing: 0.5 },
  headerSub: { fontFamily: Fonts.body, fontSize: 11, color: C.muted, marginTop: 1 },
  headerBtn: { flexDirection: "row", alignItems: "center", gap: 4, padding: 6 },
  headerBtnText: { fontFamily: Fonts.body, fontSize: 11, color: C.muted },
  modeBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: S.sm,
    paddingHorizontal: S.lg,
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.border,
    backgroundColor: C.surface,
  },
  modeAction: { fontFamily: Fonts.body, fontSize: 11, color: C.muted },
  modeHint: { fontFamily: Fonts.body, fontSize: 10, color: C.faint, flexShrink: 1 },
  sessionBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: S.sm,
    paddingHorizontal: S.lg,
    paddingVertical: 6,
    backgroundColor: C.surface2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.border,
  },
  sessionPick: { flex: 1, minWidth: 0 },
  sessionTitle: { fontFamily: Fonts.body, fontSize: 12, color: C.fg },
  sessionCount: { fontFamily: Fonts.mono, fontSize: 9, color: C.faint },
  sessionBtn: { borderWidth: 1, borderColor: C.border, borderRadius: 9, paddingHorizontal: 8, paddingVertical: 3 },
  sessionBtnText: { fontFamily: Fonts.body, fontSize: 10, color: C.muted },
  bgPanel: {
    flexDirection: "row",
    alignItems: "center",
    gap: S.sm,
    paddingHorizontal: S.lg,
    paddingVertical: 6,
    backgroundColor: C.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.border,
  },
  bgHint: { flex: 1, fontFamily: Fonts.body, fontSize: 9, color: C.faint },
  sessionMenu: { backgroundColor: C.surface, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border, padding: S.sm },
  sessionRow: { flexDirection: "row", alignItems: "center", gap: S.sm, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 6 },
  sessionRowTitle: { fontFamily: Fonts.body, fontSize: 12, color: C.fg },
  sessionRowCount: { fontFamily: Fonts.mono, fontSize: 9, color: C.faint },
  sessionRowAction: { fontFamily: Fonts.body, fontSize: 10, color: C.muted },
  list: { padding: S.lg, gap: S.md, paddingBottom: S.xl, flexGrow: 1 },
  dayRow: { flexDirection: "row", alignItems: "center", gap: S.sm, paddingVertical: 2 },
  dayLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: C.border },
  dayText: { fontFamily: Fonts.mono, fontSize: 9, color: C.faint, letterSpacing: 2 },
  userBubble: {
    maxWidth: "82%",
    borderRadius: R.card,
    borderBottomRightRadius: 6,
    borderWidth: 1,
    borderColor: C.accentLine,
    backgroundColor: C.accentSoft,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  userText: { fontFamily: Fonts.body, fontSize: 14, lineHeight: 21, color: C.fg },
  deleteLink: { fontFamily: Fonts.body, fontSize: 9, color: C.faint, marginTop: 3 },
  masterRow: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  sender: { fontFamily: Fonts.mono, fontSize: 9, color: C.muted, letterSpacing: 1.5, marginBottom: 3 },
  masterBubble: {
    maxWidth: "94%",
    borderRadius: R.card,
    borderTopLeftRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.border,
    backgroundColor: "rgba(22,16,32,0.92)",
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  typing: { fontFamily: Fonts.body, fontSize: 11, color: C.muted },
  sceneImage: { marginTop: S.sm, width: 250, maxWidth: "92%", aspectRatio: 1, borderRadius: R.card, borderWidth: 1, borderColor: C.border },
  sceneBusy: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 },
  sceneBusyText: { fontFamily: Fonts.body, fontSize: 10, color: C.accent },
  sceneStop: { fontFamily: Fonts.body, fontSize: 10, color: C.dangerText },
  msgActions: { flexDirection: "row", gap: 12, marginTop: 4 },
  msgAction: { fontFamily: Fonts.body, fontSize: 9, color: C.faint },
  centerHint: { fontFamily: Fonts.body, fontSize: 13, color: C.muted, textAlign: "center", paddingVertical: S.xxl },
  emptyBox: { alignItems: "center", gap: S.xs, paddingTop: S.xl },
  noticeBar: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border, backgroundColor: C.surface, paddingHorizontal: S.lg, paddingVertical: 5, gap: 2 },
  noticeText: { fontFamily: Fonts.mono, fontSize: 10, color: C.gold },
  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: S.sm,
    paddingHorizontal: S.lg,
    paddingTop: S.sm,
    paddingBottom: S.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.border,
    backgroundColor: C.bg,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: C.borderStrong,
    backgroundColor: C.surface2,
    paddingHorizontal: 14,
    paddingTop: 11,
    paddingBottom: 11,
    color: C.fg,
    fontFamily: Fonts.body,
    fontSize: 14,
  },
  sendBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: C.gold, alignItems: "center", justifyContent: "center" },
  stopBtn: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, borderColor: C.danger, alignItems: "center", justifyContent: "center" },
  jump: {
    position: "absolute",
    right: 16,
    bottom: 96,
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    borderColor: C.goldLine,
    backgroundColor: C.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  petWrap: { position: "absolute", left: 12, bottom: 100 },
  sceneError: { borderWidth: 1, borderColor: C.danger, borderRadius: R.card, padding: S.md, backgroundColor: C.surface },
  sceneErrorTitle: { fontFamily: Fonts.display, fontSize: 15, color: C.dangerText },
  sceneErrorText: { fontFamily: Fonts.body, fontSize: 11, color: C.dangerText, lineHeight: 17, marginTop: 2 },
});
