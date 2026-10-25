import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import * as Haptics from "expo-haptics";

import { Page } from "@/components/Page";
import { C, Fonts, R, S } from "@/constants/theme";
import { isConfigured, loadConfig, saveConfig, type ApiConfig } from "@/lib/settings";
import { testConnection } from "@/lib/llm";

export default function SettingsScreen() {
  const [cfg, setCfg] = useState<ApiConfig>({ baseUrl: "", model: "", key: "" });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    loadConfig().then(setCfg).catch(() => {});
  }, []);

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      await saveConfig(cfg);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setStatus({ ok: true, text: "已保存（Key 存在系统安全存储里）" });
    } catch (e) {
      setStatus({ ok: false, text: e instanceof Error ? e.message : "保存失败" });
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setStatus(null);
    try {
      await saveConfig(cfg);
      const reply = await testConnection(cfg);
      setStatus({ ok: true, text: `连接成功：${reply}` });
    } catch (e) {
      setStatus({ ok: false, text: e instanceof Error ? e.message : "连接失败" });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Page title="设置" subtitle="模型与渠道 · 只存本机">
      <View style={styles.card}>
        <Text style={styles.cardTitle}>文本模型</Text>
        <Text style={styles.hint}>
          填一个 OpenAI 兼容接口（DeepSeek / OpenCode / 你自己的服务）。请求 {`{地址}/chat/completions`}。
        </Text>

        <Text style={styles.label}>接口地址</Text>
        <TextInput
          style={styles.input}
          value={cfg.baseUrl}
          onChangeText={(v) => setCfg({ ...cfg, baseUrl: v })}
          placeholder="https://api.example.com/v1"
          placeholderTextColor={C.faint}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />

        <Text style={styles.label}>模型名</Text>
        <TextInput
          style={styles.input}
          value={cfg.model}
          onChangeText={(v) => setCfg({ ...cfg, model: v })}
          placeholder="例如 deepseek-chat"
          placeholderTextColor={C.faint}
          autoCapitalize="none"
          autoCorrect={false}
        />

        <Text style={styles.label}>API Key</Text>
        <TextInput
          style={styles.input}
          value={cfg.key}
          onChangeText={(v) => setCfg({ ...cfg, key: v })}
          placeholder="可留空（本机服务）"
          placeholderTextColor={C.faint}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
        />

        <View style={styles.row}>
          <Pressable
            onPress={() => void save()}
            disabled={saving}
            style={[styles.btn, styles.btnPrimary, saving && styles.disabled]}
          >
            <Text style={styles.btnPrimaryText}>{saving ? "保存中…" : "保存"}</Text>
          </Pressable>
          <Pressable
            onPress={() => void test()}
            disabled={testing}
            style={[styles.btn, styles.btnGhost, testing && styles.disabled]}
          >
            <Text style={styles.btnGhostText}>{testing ? "测试中…" : "测试连接"}</Text>
          </Pressable>
        </View>

        {status ? (
          <View style={[styles.status, status.ok ? styles.statusOk : styles.statusErr]}>
            <Text style={[styles.statusText, { color: status.ok ? C.accent : C.dangerText }]}>
              {status.text}
            </Text>
          </View>
        ) : null}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>关于</Text>
        <Text style={styles.hint}>
          二周目协会 · Android 首版。数据只在本机 SQLite，不迁移、不上传。
          {isConfigured(cfg) ? "" : "\n填好上面两项后，对话页就能用了。"}
        </Text>
        <Text style={styles.version}>v0.1.1 · Expo</Text>
      </View>
    </Page>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: C.surface,
    borderRadius: R.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.border,
    padding: S.lg,
    gap: 6,
  },
  cardTitle: {
    fontFamily: Fonts.display,
    fontSize: 19,
    color: C.fg,
    marginBottom: 2,
  },
  hint: {
    fontFamily: Fonts.body,
    fontSize: 12,
    lineHeight: 18,
    color: C.muted,
    marginBottom: S.sm,
  },
  label: {
    fontFamily: Fonts.body,
    fontSize: 12,
    color: C.faint,
    marginTop: S.sm,
    marginBottom: 4,
    letterSpacing: 0.4,
  },
  input: {
    minHeight: 44,
    borderRadius: R.btn,
    backgroundColor: C.surface2,
    borderWidth: 1,
    borderColor: C.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: C.fg,
    fontFamily: Fonts.body,
    fontSize: 14,
  },
  row: {
    flexDirection: "row",
    gap: S.sm,
    marginTop: S.lg,
  },
  btn: {
    flex: 1,
    minHeight: 44,
    borderRadius: R.btn,
    alignItems: "center",
    justifyContent: "center",
  },
  btnPrimary: { backgroundColor: C.gold },
  btnPrimaryText: {
    fontFamily: Fonts.body,
    fontSize: 14,
    color: C.onGold,
    fontWeight: "600",
  },
  btnGhost: {
    borderWidth: 1,
    borderColor: C.borderStrong,
  },
  btnGhostText: {
    fontFamily: Fonts.body,
    fontSize: 14,
    color: C.fg,
  },
  disabled: { opacity: 0.45 },
  status: {
    marginTop: S.md,
    borderRadius: R.btn,
    borderWidth: 1,
    paddingHorizontal: S.md,
    paddingVertical: 8,
  },
  statusOk: {
    backgroundColor: C.accentSoft,
    borderColor: C.accentLine,
  },
  statusErr: {
    backgroundColor: "rgba(168,50,68,0.18)",
    borderColor: C.danger,
  },
  statusText: {
    fontFamily: Fonts.body,
    fontSize: 12,
    lineHeight: 17,
  },
  version: {
    fontFamily: Fonts.mono,
    fontSize: 11,
    color: C.faint,
    marginTop: S.sm,
  },
});
