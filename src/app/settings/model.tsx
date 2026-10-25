import { useCallback, useState } from "react";
import { useFocusEffect, useRouter } from "expo-router";
import { StyleSheet, Text, View } from "react-native";

import { C, Fonts, R, S } from "@/constants/theme";
import { Button, Card, Chip, ErrorBar, Field, Input, Loading, Screen, haptic } from "@/components/ui";
import { useToast } from "@/components/Toast";
import { saveLlm, settingsState, testLlm, type SettingsState } from "@/lib/service";
import type { LlmProvider } from "@/server/modelConfig";

export default function ModelSettingsScreen() {
  const router = useRouter();
  const toast = useToast();
  const [state, setState] = useState<SettingsState | null>(null);
  const [provider, setProvider] = useState<LlmProvider>("deepseek");
  const [model, setModel] = useState("");
  const [judgeModel, setJudgeModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(() => {
    try {
      const s = settingsState();
      setState(s);
      setProvider(s.provider);
      setModel(s.model);
      setJudgeModel(s.judgeModel);
      setBaseUrl(s.baseUrl);
      setApiKey("");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "没能读到模型设置。");
    }
  }, []);

  useFocusEffect(useCallback(() => load(), [load]));

  async function pickProvider(p: LlmProvider) {
    if (busy) return;
    setProvider(p);
    setTestResult(null);
    setBusy("provider");
    try {
      const s = await saveLlm({ provider: p });
      setState({ ...settingsState(), ...s });
      setModel(s.model);
      setJudgeModel(s.judgeModel);
      setBaseUrl(s.baseUrl);
      haptic("select");
    } catch (e) {
      setError(e instanceof Error ? e.message : "切换渠道失败。");
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    setBusy("save");
    setTestResult(null);
    try {
      await saveLlm({
        provider,
        model,
        judgeModel: provider === "local" ? "" : judgeModel,
        baseUrl: provider === "local" ? baseUrl : undefined,
        ...(apiKey.trim() ? { apiKey } : {}),
      });
      toast("已记下", "ok");
      haptic("success");
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败。");
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    setBusy("test");
    setTestResult(null);
    try {
      const r = await testLlm({
        provider,
        baseUrl: provider === "local" ? baseUrl : undefined,
        model,
        apiKey: apiKey.trim() || undefined,
      });
      setTestResult({ ok: true, text: `通了。模型 ${r.model} 应答正常，耗时 ${r.latencyMs}ms。` });
      haptic("success");
    } catch (e) {
      setTestResult({ ok: false, text: e instanceof Error ? e.message : "连接失败" });
      haptic("error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Screen title="模型与渠道" subtitle="会长的嗓门由这里驱动 · Key 只进系统安全存储" back onBack={() => router.push("/settings")}>
      {!state ? <Loading text="正在读模型设置……" /> : null}
      {state ? (
        <>
          <Card>
            <Text style={styles.cardTitle}>模型配置</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {state.providers.map((p) => (
                <Chip key={p.id} label={p.label} active={provider === p.id} onPress={() => void pickProvider(p.id)} tone="gold" />
              ))}
            </View>

            {provider === "local" ? (
              <>
                <Field label="接口地址" hint="OpenAI 兼容端点，一般以 /v1 结尾。模拟器访问本机用 10.0.2.2。">
                  <Input value={baseUrl} onChangeText={setBaseUrl} placeholder="http://10.0.2.2:12345/v1" autoCapitalize="none" />
                </Field>
                <Field label="模型名">
                  <Input value={model} onChangeText={setModel} placeholder="例如 llama-3.1-8b" autoCapitalize="none" />
                </Field>
              </>
            ) : (
              <>
                <Field label="模型" hint="各渠道都用这里切换；换渠道会自动落到该渠道默认模型。">
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5 }}>
                    {state.models.map((m) => (
                      <Chip key={m.id} label={m.label} active={model === m.id} onPress={() => setModel(m.id)} tone="accent" />
                    ))}
                  </View>
                  <Input value={model} onChangeText={setModel} placeholder="模型 id" autoCapitalize="none" style={{ marginTop: 4 }} />
                </Field>
                <Field label="复核判定模型（可选）" hint="用于结算复核；留空则跟随主模型。判定失败会自动维持原判。">
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5 }}>
                    <Chip label={`跟随主模型${model ? `（${model}）` : ""}`} active={!judgeModel} onPress={() => setJudgeModel("")} tone="gold" />
                    {state.models.map((m) => (
                      <Chip key={m.id} label={m.label} active={judgeModel === m.id} onPress={() => setJudgeModel(m.id)} tone="gold" />
                    ))}
                  </View>
                </Field>
              </>
            )}

            <Field label="API Key" hint={`已保存：${state.apiKeyMasked ?? "（无）"}。留空表示不覆盖；填写后保存/测试会写入 SecureStore。`}>
              <Input value={apiKey} onChangeText={setApiKey} placeholder={state.apiKeyMasked ?? "填写 API Key"} secureTextEntry autoCapitalize="none" />
            </Field>

            {provider === "opencode-go" ? (
              <View style={styles.note}><Text style={styles.noteText}>当前走 OpenCode Go 套餐（端点 zen/go）。若不想在额度用满后回落到余额扣费，请到 console.opencode.ai 关掉「Use balance」。</Text></View>
            ) : null}
            {provider === "local" ? (
              <View style={styles.note}><Text style={styles.noteText}>自定义 API：填你自己的 OpenAI 兼容服务地址、模型名和 Key（本机服务 Key 可留空）。</Text></View>
            ) : null}

            <View style={{ flexDirection: "row", gap: S.sm, marginTop: S.sm }}>
              <Button variant="gold" onPress={() => void save()} loading={busy === "save"} style={{ flex: 1 }}>保存</Button>
              <Button variant="outline" onPress={() => void test()} loading={busy === "test"} style={{ flex: 1 }}>测试连接</Button>
            </View>
            {testResult ? (
              <View style={[styles.result, { borderColor: testResult.ok ? C.accentLine : C.danger, backgroundColor: testResult.ok ? C.accentSoft : C.dangerSoft }]}>
                <Text style={[styles.resultText, { color: testResult.ok ? C.accent : C.dangerText }]}>{testResult.ok ? testResult.text : `没通：${testResult.text}`}</Text>
              </View>
            ) : null}
            {error ? <ErrorBar text={error} /> : null}
          </Card>

          <Card>
            <View style={{ flexDirection: "row", alignItems: "center", gap: S.sm }}>
              <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: state.hasKey ? C.success : C.faint }} />
              <Text style={{ fontFamily: Fonts.body, fontSize: 13, color: C.fg }}>当前 Key</Text>
              <View style={styles.keyBadge}><Text style={styles.keyBadgeText}>{state.hasKey ? "已配置" : "未配置"}</Text></View>
            </View>
            <Text style={styles.hint}>
              掩码：<Text style={{ fontFamily: Fonts.mono, color: C.fg }}>{state.apiKeyMasked ?? "（无）"}</Text>。Key 只存在 Android Keystore / iOS Keychain，不写数据库、不上传。
            </Text>
          </Card>
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  cardTitle: { fontFamily: Fonts.display, fontSize: 18, color: C.fg },
  note: { borderWidth: 1, borderColor: C.goldLine, backgroundColor: C.goldSoft, borderRadius: R.tile, padding: S.sm },
  noteText: { fontFamily: Fonts.body, fontSize: 10, color: C.gold, lineHeight: 16 },
  result: { borderWidth: 1, borderRadius: R.tile, paddingHorizontal: S.md, paddingVertical: 8, marginTop: S.sm },
  resultText: { fontFamily: Fonts.mono, fontSize: 10, lineHeight: 16 },
  keyBadge: { marginLeft: "auto", borderWidth: 1, borderColor: C.goldLine, backgroundColor: C.goldSoft, borderRadius: 99, paddingHorizontal: 8, paddingVertical: 1 },
  keyBadgeText: { fontFamily: Fonts.mono, fontSize: 9, color: C.gold },
  hint: { fontFamily: Fonts.body, fontSize: 10, color: C.muted, lineHeight: 16 },
});
