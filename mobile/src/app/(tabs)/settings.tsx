import { useCallback, useEffect, useRef, useState } from "react";
import { useFocusEffect, useRouter } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { C, Fonts, R, S } from "@/constants/theme";
import { Button, Card, ErrorBar, Field, Input, Loading, MultiInput, PressableScale, Screen, haptic } from "@/components/ui";
import { useToast } from "@/components/Toast";
import { registerSecretTap } from "@/weblib/secret";
import {
  getUiPref,
  saveChatMaster,
  saveRp,
  userPersonaSave,
  setUiPref,
  settingsState,
  userPersonaGet,
  type SettingsState,
} from "@/lib/service";

const ADULT_KEY = "adult.unlocked";

function NavRow({ title, hint, onPress }: { title: string; hint: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.navRow}>
      <Text style={styles.navTitle}>{title}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4, flex: 1, justifyContent: "flex-end" }}>
        <Text style={styles.navHint} numberOfLines={1}>{hint}</Text>
        <Ionicons name="chevron-forward" size={14} color={C.faint} />
      </View>
    </Pressable>
  );
}

export default function SettingsScreen() {
  const router = useRouter();
  const toast = useToast();
  const [state, setState] = useState<SettingsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sound, setSound] = useState(true);
  const [pet, setPet] = useState(true);
  const [rpEnabled, setRpEnabled] = useState(false);
  const [adultUnlocked, setAdultUnlocked] = useState(false);
  const [upName, setUpName] = useState("");
  const [upBrief, setUpBrief] = useState("");
  const [upDesc, setUpDesc] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const taps = useRef<number[]>([]);

  const load = useCallback(() => {
    try {
      const s = settingsState();
      setState(s);
      setRpEnabled(s.rp.enabled);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "没能读到设置。");
    }
  }, []);

  useFocusEffect(useCallback(() => load(), [load]));

  useEffect(() => {
    setSound(getUiPref("sound", "1") !== "0");
    setPet(getUiPref("pet", "1") !== "0");
    setAdultUnlocked(getUiPref(ADULT_KEY, "0") === "1");
    try {
      const p = userPersonaGet();
      setUpName(p.name);
      setUpBrief(p.brief);
      setUpDesc(p.description);
    } catch {
      /* noop */
    }
  }, []);

  function secretTap() {
    const r = registerSecretTap(taps.current, Date.now());
    taps.current = r.taps;
    if (!r.unlocked || adultUnlocked) return;
    setAdultUnlocked(true);
    setUiPref(ADULT_KEY, "1");
    haptic("success");
    toast("……协会的暗门，开了。");
  }

  function toggleSound() {
    const next = !sound;
    setSound(next);
    setUiPref("sound", next ? "1" : "0");
    haptic("select");
  }

  function togglePet() {
    const next = !pet;
    setPet(next);
    setUiPref("pet", next ? "1" : "0");
    haptic("select");
  }

  function toggleRp() {
    try {
      const r = saveRp(!rpEnabled);
      setRpEnabled(r.enabled);
      haptic("select");
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败。");
    }
  }

  async function savePersona() {
    setBusy("persona");
    try {
      userPersonaSave({ name: upName, brief: upBrief, description: upDesc });
      toast("冒险者卡已记下", "ok");
      haptic("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败。");
    } finally {
      setBusy(null);
    }
  }

  async function changeChatMaster(id: string) {
    setBusy("chatMaster");
    try {
      const s = saveChatMaster(id || null);
      setState(s);
      setRpEnabled(s.rp.enabled);
      haptic("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败。");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Screen title="设置" subtitle="协会章程 · 会长与酒馆的规矩都在这">
      <Pressable onPress={secretTap} style={{ gap: 2 }}>
        <Text style={styles.tapHint}>（设置 · 协会章程）</Text>
      </Pressable>
      {error ? <ErrorBar text={error} /> : null}
      {!state ? <Loading text="正在翻开协会章程……" /> : null}
      {state ? (
        <>
          <Card>
            <Text style={styles.cardTitle}>协会</Text>
            <NavRow title="更换会长" hint="各自好感 · 各自记忆书" onPress={() => router.push("/masters")} />
            <NavRow title="世界书" hint="角色设定 · 会长专属" onPress={() => router.push("/worldbook")} />
            <NavRow title="记忆书" hint="长期记忆 · 永久 / 每段对话" onPress={() => router.push("/memory")} />
            <NavRow title="模型与渠道" hint="DeepSeek / OpenCode / 自定义" onPress={() => router.push("/settings/model")} />
            <NavRow title="生图" hint="OpenAI 兼容接口 · 模型 / 尺寸 / 画风" onPress={() => router.push("/settings/image")} />

            <View style={styles.rowLine}>
              <Text style={styles.rowTitle}>聊天模式会长</Text>
              <View style={styles.selectWrap}>
                <Pressable
                  style={styles.selectBtn}
                  onPress={() => {
                    const current = state.chatMasterId ?? "";
                    const ids = ["", ...state.masters.map((m) => m.id)];
                    const idx = ids.indexOf(current);
                    const next = ids[(idx + 1) % ids.length];
                    void changeChatMaster(next);
                  }}
                  disabled={busy !== null}
                >
                  <Text style={styles.selectText} numberOfLines={1}>
                    {state.chatMasterId ? state.masters.find((m) => m.id === state.chatMasterId)?.name ?? "指定会长" : "跟随任务会长"}
                  </Text>
                  <Ionicons name="swap-vertical" size={14} color={C.muted} />
                </Pressable>
              </View>
            </View>
            <Text style={styles.hint}>酒馆（聊天）模式用哪位会长。任务模式与历史归属不受影响；两者相同时共享同一本记忆书。</Text>

            <Pressable style={styles.rowLine} onPress={toggleSound}>
              <Text style={styles.rowTitle}>音效</Text>
              <View style={[styles.pill, sound ? styles.pillOn : null]}>
                <Text style={[styles.pillText, { color: sound ? C.gold : C.faint }]}>{sound ? "开" : "关"}</Text>
              </View>
            </Pressable>
            <Pressable style={styles.rowLine} onPress={togglePet}>
              <Text style={styles.rowTitle}>对话页像素小人</Text>
              <View style={[styles.pill, pet ? styles.pillOn : null]}>
                <Text style={[styles.pillText, { color: pet ? C.gold : C.faint }]}>{pet ? "开" : "关"}</Text>
              </View>
            </Pressable>

            {adultUnlocked || rpEnabled ? (
              <>
                <Pressable style={styles.rowLine} onPress={toggleRp}>
                  <Text style={styles.rowTitle}>R18 内容</Text>
                  <View style={[styles.pill, rpEnabled ? { borderColor: C.danger, backgroundColor: C.dangerSoft } : null]}>
                    <Text style={[styles.pillText, { color: rpEnabled ? C.dangerText : C.faint }]}>{rpEnabled ? "开" : "关"}</Text>
                  </View>
                </Pressable>
                <Text style={styles.hint}>
                  开启后，聊天模式注入 Evening-Truth 系解禁准则；配图提炼也会如实定格、不审查。
                  {adultUnlocked ? (
                    <Text
                      style={{ textDecorationLine: "underline", color: C.faint }}
                      onPress={() => {
                        setAdultUnlocked(false);
                        setUiPref(ADULT_KEY, "0");
                      }}
                    >
                      {" "}收起
                    </Text>
                  ) : null}
                </Text>
              </>
            ) : null}
          </Card>

          <Card>
            <Text style={styles.cardTitle}>冒险者卡</Text>
            <Text style={styles.hint}>关于「你」自己的设定。会长在任务与聊天两个模式里都会知道这些。</Text>
            <Field label="称呼">
              <Input placeholder="会长怎么称呼你" maxLength={40} value={upName} onChangeText={setUpName} />
            </Field>
            <Field label="一句话">
              <Input placeholder="例如：一个想重新开始的夜班程序员" maxLength={120} value={upBrief} onChangeText={setUpBrief} />
            </Field>
            <Field label="背景">
              <MultiInput placeholder="想告诉会长的关于你自己的事" maxLength={1000} value={upDesc} onChangeText={setUpDesc} />
            </Field>
            <Button variant="outline" onPress={() => void savePersona()} loading={busy === "persona"}>
              保存冒险者卡
            </Button>
          </Card>

          <Card>
            <Text style={styles.cardTitle}>数据与隐私</Text>
            <Text style={styles.hint}>
              全部数据只存在本机 SQLite；API Key 只进系统安全存储（Android Keystore）。不上传云端、不依赖电脑常开、不迁移 Web 数据。
            </Text>
            <Text style={styles.version}>二周目协会 · Android v0.1.1</Text>
          </Card>
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  tapHint: { fontFamily: Fonts.mono, fontSize: 10, color: C.faint, letterSpacing: 1 },
  cardTitle: { fontFamily: Fonts.display, fontSize: 18, color: C.fg, marginBottom: 2 },
  navRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: S.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.border,
    paddingVertical: 10,
  },
  navTitle: { fontFamily: Fonts.body, fontSize: 13, color: C.fg },
  navHint: { fontFamily: Fonts.body, fontSize: 10, color: C.faint, maxWidth: 200 },
  rowLine: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: S.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.border,
    paddingVertical: 10,
  },
  rowTitle: { fontFamily: Fonts.body, fontSize: 13, color: C.fg },
  selectWrap: { maxWidth: "58%" },
  selectBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderWidth: 1,
    borderColor: C.borderStrong,
    borderRadius: 9,
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: C.surface2,
  },
  selectText: { fontFamily: Fonts.body, fontSize: 11, color: C.fg, maxWidth: 150 },
  pill: { borderWidth: 1, borderColor: C.border, borderRadius: 99, paddingHorizontal: 9, paddingVertical: 1 },
  pillOn: { borderColor: C.goldLine, backgroundColor: C.goldSoft },
  pillText: { fontFamily: Fonts.mono, fontSize: 10 },
  hint: { fontFamily: Fonts.body, fontSize: 10, color: C.faint, lineHeight: 16 },
  version: { fontFamily: Fonts.mono, fontSize: 10, color: C.faint, marginTop: 2 },
});
