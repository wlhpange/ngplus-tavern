import { useCallback, useEffect, useRef, useState } from "react";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";

import { C, Fonts, R, S } from "@/constants/theme";
import { Avatar } from "@/components/Avatar";
import { ConfirmDialog } from "@/components/Dialogs";
import { Button, Card, Chip, ErrorBar, Field, Input, Loading, MultiInput, PressableScale, Screen, haptic } from "@/components/ui";
import { useToast } from "@/components/Toast";
import type { ImportedCard } from "@/server/cardImport";
import { getJob, startTranslateJob, cancelJob } from "@/server/translateJobs";
import {
  activateMaster,
  commitImportedCard,
  completeOnboarding,
  createMasterByFields,
  deleteMaster,
  forgeMaster,
  mastersData,
  previewImportedCard,
  saveMasterAvatar,
  uploadAvatar,
  avatarUri,
  ctx,
  type MasterItem,
} from "@/lib/service";

type PendingImport = {
  card: ImportedCard;
  name: string;
  fields: number;
  entries: number;
  avatarFile: string | null;
};

export default function MastersScreen() {
  const router = useRouter();
  const toast = useToast();
  const params = useLocalSearchParams<{ first?: string }>();
  const isFirstArrival = params.first === "1";
  const [masters, setMasters] = useState<MasterItem[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [intimacyLabel, setIntimacyLabel] = useState("初识");
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [forgeMsg, setForgeMsg] = useState<string | null>(null);
  const [forgedPersona, setForgedPersona] = useState<Record<string, unknown> | null>(null);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newPersonality, setNewPersonality] = useState("");
  const [newScenario, setNewScenario] = useState("");
  const [newFirstMes, setNewFirstMes] = useState("");
  const [newTags, setNewTags] = useState("");
  const [creating, setCreating] = useState(false);
  const [newAvatarFile, setNewAvatarFile] = useState<string | null>(null);
  const [newAvatarPreview, setNewAvatarPreview] = useState<string | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<MasterItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [translating, setTranslating] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [elapsed, setElapsed] = useState(0);
  const jobRef = useRef<string | null>(null);

  const load = useCallback(() => {
    try {
      const d = mastersData();
      setMasters(d.masters);
      setActiveId(d.activeMasterId);
      setIntimacyLabel(d.intimacyLabel);
      setError(null);
    } catch (e) {
      setMasters([]);
      setError(e instanceof Error ? e.message : "候选人们正在赶来……");
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  useEffect(() => {
    if (!translating) {
      setElapsed(0);
      return;
    }
    const start = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(t);
  }, [translating]);

  const isFirstPick = isFirstArrival || activeId === null;

  async function choose(id: string) {
    if (switching || id === activeId) return;
    setSwitching(id);
    setError(null);
    try {
      await activateMaster(id);
      setActiveId(id);
      haptic("success");
      if (isFirstPick) {
        completeOnboarding();
        router.replace("/");
      } else {
        load();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "交接仪式出了点状况。");
    } finally {
      setSwitching(null);
    }
  }

  async function pickAvatar(kind: "new" | "existing", masterId?: string) {
    if (avatarBusy) return;
    setAvatarBusy(true);
    setError(null);
    try {
      const res = await DocumentPicker.getDocumentAsync({ type: "image/*", copyToCacheDirectory: true, multiple: false });
      if (res.canceled) return;
      const asset = res.assets[0];
      const file = new File(asset.uri);
      const bytes = await file.bytes();
      const saved = uploadAvatar(bytes, asset.name || "avatar.png", asset.mimeType);
      if (kind === "new") {
        setNewAvatarFile(saved);
        setNewAvatarPreview(avatarUri(saved));
      } else if (masterId) {
        saveMasterAvatar(masterId, saved);
        load();
      }
      haptic("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "头像上传失败。");
    } finally {
      setAvatarBusy(false);
    }
  }

  async function createByFields() {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const created = createMasterByFields({
        card: {
          name: newName,
          description: newDescription,
          personality: newPersonality,
          scenario: newScenario,
          firstMes: newFirstMes,
          tags: newTags,
          avatar: newAvatarFile,
        },
        persona: forgedPersona,
      });
      resetForm();
      await choose(created.id);
      load();
      toast(`「${created.name}」已经上岗。`, "ok");
    } catch (e) {
      setError(e instanceof Error ? e.message : "新增失败。");
    } finally {
      setCreating(false);
    }
  }

  function resetForm() {
    setInviteOpen(false);
    setNewName("");
    setNewDescription("");
    setNewPersonality("");
    setNewScenario("");
    setNewFirstMes("");
    setNewTags("");
    setForgeMsg(null);
    setForgedPersona(null);
    setNewAvatarFile(null);
    setNewAvatarPreview(null);
  }

  async function generateByAi() {
    if (generating || creating) return;
    setGenerating(true);
    setError(null);
    setForgeMsg(null);
    try {
      const card = (await forgeMaster({
        name: newName,
        description: newDescription,
        personality: newPersonality,
        scenario: newScenario,
        firstMes: newFirstMes,
        tags: newTags,
      })) as {
        name?: string;
        description?: string;
        self_intro?: string;
        personality?: string[];
        scenario?: string;
        first_mes?: string;
        tags?: string[];
      };
      if (!newName.trim()) setNewName(card.name ?? "");
      if (!newDescription.trim()) setNewDescription(card.description ?? card.self_intro ?? "");
      if (!newPersonality.trim()) setNewPersonality((card.personality ?? []).join("，"));
      if (!newScenario.trim()) setNewScenario(card.scenario ?? "");
      if (!newFirstMes.trim()) setNewFirstMes(card.first_mes ?? "");
      if (!newTags.trim()) setNewTags((card.tags ?? []).join("，"));
      setForgedPersona(card as Record<string, unknown>);
      setForgeMsg("已根据你填的内容补全，检查一下，没问题就点「创建这位会长」。");
      haptic("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "AI 没能生成，请再试一次。");
    } finally {
      setGenerating(false);
    }
  }

  async function removeMaster() {
    const t = removeTarget;
    if (!t || deleting) return;
    setDeleting(true);
    try {
      deleteMaster(t.id);
      setRemoveTarget(null);
      load();
      haptic("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败。");
    } finally {
      setDeleting(false);
    }
  }

  async function importCard() {
    if (importing) return;
    setImporting(true);
    setError(null);
    setImportMsg(null);
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: ["application/json", "image/png", "application/octet-stream"],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (res.canceled) return;
      const asset = res.assets[0];
      const file = new File(asset.uri);
      const bytes = await file.bytes();
      const pv = previewImportedCard(bytes, asset.name || "");
      if (pv.needed) {
        setPendingImport({ card: pv.card, name: pv.name, fields: pv.fields, entries: pv.entries, avatarFile: pv.avatarFile });
        return;
      }
      await commitImport(pv.card, pv.avatarFile);
    } catch (e) {
      setError(e instanceof Error ? e.message : "导入失败。");
    } finally {
      setImporting(false);
    }
  }

  async function commitImport(card: ImportedCard, avatarFile: string | null) {
    try {
      const created = commitImportedCard(card, false);
      if (avatarFile) saveMasterAvatar(created.id, avatarFile);
      setImportMsg(`已请来「${created.name}」（${card.spec}），世界书词条 ${created.worldBookEntries ?? 0} 条`);
      load();
      haptic("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "导入失败。");
    }
  }

  async function onTranslateChoice(translate: boolean) {
    const pending = pendingImport;
    setPendingImport(null);
    if (!pending) return;
    if (!translate) {
      setImporting(true);
      await commitImport(pending.card, pending.avatarFile);
      setImporting(false);
      return;
    }
    setTranslating(true);
    setProgress({ done: 0, total: 0 });
    try {
      const { db, userId } = ctx();
      const jobId = startTranslateJob(db, userId, pending.card);
      jobRef.current = jobId;
      for (;;) {
        await new Promise((r) => setTimeout(r, 700));
        if (jobRef.current === null) return;
        const job = getJob(jobId);
        if (!job) {
          setError("翻译任务不存在或已过期。");
          return;
        }
        setProgress({ done: job.done, total: job.total });
        if (job.status === "done" && job.result) {
          if (pending.avatarFile) saveMasterAvatar(job.result.masterId, pending.avatarFile);
          setImportMsg(`已请来「${job.result.name}」（${pending.card.spec}），世界书词条 ${job.result.worldBookEntries} 条（已翻译）`);
          load();
          haptic("success");
          return;
        }
        if (job.status === "cancelled") {
          setImportMsg("已取消翻译，角色卡未导入。");
          return;
        }
        if (job.status === "error") {
          setError(job.error ?? "翻译失败。");
          return;
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "翻译失败。");
    } finally {
      jobRef.current = null;
      setTranslating(false);
    }
  }

  function cancelTranslation() {
    const id = jobRef.current;
    jobRef.current = null;
    setTranslating(false);
    if (id) cancelJob(id);
  }

  function keepDefault() {
    completeOnboarding();
    router.replace("/");
  }

  const hasSomeField = Boolean(newName.trim() || newDescription.trim() || newPersonality.trim() || newScenario.trim() || newFirstMes.trim() || newTags.trim());

  return (
    <Screen
      title={isFirstPick ? "这间协会在等它的主人" : "更换会长"}
      subtitle={isFirstPick ? "你想让它落在谁手里？不选也没关系——协会默认由薇拉执掌。" : `换人是游戏内事件：记忆保留；每位会长各有自己的好感（当前：${intimacyLabel}）`}
      back={!isFirstPick}
      onBack={() => router.back()}
    >
      {error ? <ErrorBar text={error} /> : null}
      {masters === null ? <Loading text="候选人们正在赶来……" /> : null}

      {masters?.map((m) => {
        const isActive = m.id === activeId;
        return (
          <Card key={m.id} gold={isActive}>
            {isActive ? (
              <View style={styles.currentBadge}>
                <Text style={styles.currentBadgeText}>现任</Text>
              </View>
            ) : null}
            <View style={{ flexDirection: "row", alignItems: "center", gap: S.md }}>
              <Avatar src={m.avatar} name={m.name} size={48} active={isActive} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.name}>{m.name}</Text>
                <Text style={styles.intro}>{m.selfIntro}</Text>
              </View>
            </View>
            {m.backstory ? <Text style={styles.backstory}>{m.backstory}</Text> : null}
            {m.tags?.length ? (
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5 }}>
                {m.tags.map((t) => (
                  <View key={t} style={styles.tag}>
                    <Text style={styles.tagText}>{t}</Text>
                  </View>
                ))}
              </View>
            ) : null}
            {isActive ? (
              <Button variant="outline" disabled>
                当前会长
              </Button>
            ) : (
              <Button variant="primary" onPress={() => void choose(m.id)} loading={switching === m.id} disabled={switching !== null}>
                {isFirstPick ? `请 ${m.name} 执掌协会` : `换成 ${m.name}`}
              </Button>
            )}
            <View style={styles.actionsRow}>
              <Pressable onPress={() => void pickAvatar("existing", m.id)} disabled={avatarBusy}>
                <Text style={styles.actionText}>{m.avatar ? "更换头像" : "设置头像"}</Text>
              </Pressable>
              {m.avatar ? (
                <Pressable
                  onPress={() => {
                    saveMasterAvatar(m.id, null);
                    load();
                  }}
                  disabled={avatarBusy}
                >
                  <Text style={[styles.actionText, { color: C.dangerText }]}>清除头像</Text>
                </Pressable>
              ) : null}
            </View>
            {!isActive && m.isCustom ? (
              <Pressable onPress={() => setRemoveTarget(m)}>
                <Text style={[styles.actionText, { textAlign: "center", color: C.muted }]}>删除这位会长</Text>
              </Pressable>
            ) : null}
          </Card>
        );
      })}

      {masters !== null ? (
        <Card>
          <Pressable style={styles.inviteHead} onPress={() => setInviteOpen((v) => !v)} disabled={generating}>
            <View style={styles.inviteIcon}>
              <Text style={{ color: C.muted, fontSize: 18 }}>✎</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.inviteTitle}>新增会长</Text>
              <Text style={styles.inviteHint}>填一张会长卡：名字、描述、性格、场景、开场白。填不动就让 AI 按你写的补全。</Text>
            </View>
            <Text style={{ color: C.faint }}>{inviteOpen ? "▴" : "▾"}</Text>
          </Pressable>
          {inviteOpen ? (
            <View style={{ gap: S.sm, marginTop: S.sm }}>
              <Input placeholder="名字（40 字以内）" maxLength={40} value={newName} onChangeText={setNewName} />
              <View style={{ flexDirection: "row", alignItems: "center", gap: S.md }}>
                <Avatar src={newAvatarPreview} name={newName || "?"} size={44} />
                <Button variant="outline" small onPress={() => void pickAvatar("new")} loading={avatarBusy}>
                  {newAvatarFile ? "更换头像" : "上传头像（可选）"}
                </Button>
                {newAvatarFile ? (
                  <Pressable
                    onPress={() => {
                      setNewAvatarFile(null);
                      setNewAvatarPreview(null);
                    }}
                  >
                    <Text style={styles.actionText}>移除</Text>
                  </Pressable>
                ) : null}
              </View>
              <MultiInput placeholder="描述（ta 是谁、什么来历）" maxLength={2000} value={newDescription} onChangeText={setNewDescription} />
              <Input placeholder="性格（逗号分隔，如：爽朗、精明、护短）" maxLength={400} value={newPersonality} onChangeText={setNewPersonality} />
              <MultiInput placeholder="场景（此刻你们在哪里、在做什么）" maxLength={800} value={newScenario} onChangeText={setNewScenario} />
              <MultiInput placeholder="开场白（ta 见你第一句话）" maxLength={800} value={newFirstMes} onChangeText={setNewFirstMes} />
              <Input placeholder="标签（逗号分隔，可留空）" maxLength={200} value={newTags} onChangeText={setNewTags} />
              <Button variant="outline" onPress={() => void generateByAi()} loading={generating} disabled={!hasSomeField || creating}>
                ✦ AI 生成（按你填的内容补全其余）
              </Button>
              <Text style={styles.hint}>上面任意一栏填了字就能生成；你写过的框保持不变，AI 只补空着的。</Text>
              {forgeMsg ? <Text style={{ color: C.success, fontSize: 11 }}>{forgeMsg}</Text> : null}
              <Button variant="primary" onPress={() => void createByFields()} loading={creating} disabled={!newName.trim() || (!newDescription.trim() && !newFirstMes.trim())}>
                创建这位会长
              </Button>
            </View>
          ) : null}
        </Card>
      ) : null}

      {masters !== null ? (
        <Card>
          <Text style={styles.inviteTitle}>导入角色卡</Text>
          <Text style={styles.inviteHint}>支持酒馆的 Character Card（.json / .png，V1–V3）；卡里的世界书会一并导入。</Text>
          <Button variant="outline" onPress={() => void importCard()} loading={importing} style={{ marginTop: S.sm }}>
            选择角色卡文件
          </Button>
          {importMsg ? <Text style={{ color: C.success, fontSize: 11, lineHeight: 17 }}>{importMsg}</Text> : null}
        </Card>
      ) : null}

      {isFirstPick && masters !== null ? (
        <Button variant="ghost" onPress={keepDefault}>
          先不选，直接进门（协会默认由薇拉执掌）
        </Button>
      ) : null}

      <ConfirmDialog
        visible={!!removeTarget}
        title="删除这位会长？"
        description={`「${removeTarget?.name ?? ""}」的交接记录会留在协会卷宗里，但 ta 的酒馆聊天记录会一并删除。`}
        confirmLabel="删除"
        danger
        busy={deleting}
        onConfirm={() => void removeMaster()}
        onCancel={() => setRemoveTarget(null)}
      />

      <ConfirmDialog
        visible={!!pendingImport}
        title={`要翻译「${pendingImport?.name ?? ""}」吗？`}
        description={`检测到 ${pendingImport?.fields ?? 0} 处外语提示词、${pendingImport?.entries ?? 0} 条外语世界书。翻译会逐段忠实译成中文（保留人名、格式与宏），更慢但读起来顺。`}
        confirmLabel="翻译后导入"
        cancelLabel="保留原文"
        onConfirm={() => void onTranslateChoice(true)}
        onCancel={() => void onTranslateChoice(false)}
      />

      <Modal visible={translating} transparent animationType="fade" statusBarTranslucent>
        <View style={styles.translateBackdrop}>
          <View style={styles.translateCard}>
            <Text style={styles.translateTitle}>正在翻译角色卡……</Text>
            <Text style={styles.translateCount}>
              {progress.total > 0 ? `${progress.done} / ${progress.total} 段` : "准备中……"} · {elapsed}s
            </Text>
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 10}%` }]} />
            </View>
            <Text style={styles.hint}>逐段忠实翻译（含世界书）。用较快的模型会明显更快。</Text>
            <Button variant="outline" onPress={cancelTranslation}>
              取消
            </Button>
          </View>
        </View>
      </Modal>

      <Modal visible={!!switching} transparent animationType="fade" statusBarTranslucent>
        <View style={styles.translateBackdrop}>
          <View style={{ alignItems: "center", gap: S.sm }}>
            <View style={styles.handoverSeal}>
              <Text style={{ color: C.gold, fontSize: 22 }}>✦</Text>
            </View>
            <Text style={{ fontFamily: Fonts.mono, fontSize: 12, color: C.gold, letterSpacing: 3 }}>交接仪式进行中……</Text>
          </View>
        </View>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  currentBadge: {
    position: "absolute",
    right: 12,
    top: 12,
    zIndex: 2,
    borderRadius: 99,
    borderWidth: 1,
    borderColor: C.goldLine,
    backgroundColor: C.goldSoft,
    paddingHorizontal: 8,
    paddingVertical: 1,
    transform: [{ rotate: "3deg" }],
  },
  currentBadgeText: { fontFamily: Fonts.mono, fontSize: 9, color: C.gold },
  name: { fontFamily: Fonts.display, fontSize: 18, color: C.fg },
  intro: { fontFamily: Fonts.body, fontSize: 12, color: C.fg, lineHeight: 18, marginTop: 2 },
  backstory: { fontFamily: Fonts.body, fontSize: 11, color: C.muted, lineHeight: 17 },
  tag: { borderRadius: 99, borderWidth: 1, borderColor: C.border, paddingHorizontal: 7, paddingVertical: 1 },
  tagText: { fontFamily: Fonts.body, fontSize: 9, color: C.muted },
  actionsRow: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: S.lg, marginTop: 2 },
  actionText: { fontFamily: Fonts.body, fontSize: 10, color: C.muted },
  inviteHead: { flexDirection: "row", alignItems: "center", gap: S.md },
  inviteIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: C.border,
    alignItems: "center",
    justifyContent: "center",
  },
  inviteTitle: { fontFamily: Fonts.display, fontSize: 16, color: C.muted },
  inviteHint: { fontFamily: Fonts.body, fontSize: 10, color: C.muted, lineHeight: 16, marginTop: 2 },
  hint: { fontFamily: Fonts.body, fontSize: 10, color: C.faint, lineHeight: 16 },
  translateBackdrop: { flex: 1, backgroundColor: "rgba(11,8,16,0.84)", alignItems: "center", justifyContent: "center", padding: S.xl },
  translateCard: { width: "100%", maxWidth: 360, borderRadius: R.card, borderWidth: 1, borderColor: C.goldLine, backgroundColor: C.surface, padding: S.lg, gap: S.sm },
  translateTitle: { fontFamily: Fonts.display, fontSize: 18, color: C.fg, textAlign: "center" },
  translateCount: { fontFamily: Fonts.mono, fontSize: 12, color: C.gold, textAlign: "center" },
  progressTrack: { height: 8, borderRadius: 4, backgroundColor: C.surface3, overflow: "hidden" },
  progressFill: { height: "100%", backgroundColor: C.gold },
  handoverSeal: {
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 1,
    borderColor: C.goldLine,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: C.surface,
  },
});
