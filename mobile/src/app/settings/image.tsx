import { useCallback, useEffect, useRef, useState } from "react";
import { useFocusEffect, useRouter } from "expo-router";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";

import { C, Fonts, R, S } from "@/constants/theme";
import { Button, Card, Chip, ErrorBar, Field, Input, Loading, Screen, haptic } from "@/components/ui";
import { ImageLightbox } from "@/components/ImageLightbox";
import { useToast } from "@/components/Toast";
import { cancelTestImage, saveImage, settingsState, testImage } from "@/lib/service";

interface ImageState {
  enabled: boolean;
  width: number;
  height: number;
  style: string;
  apiBaseUrl: string;
  apiKey: string;
  apiModel: string;
}
const SIZES = [
  [1024, 1024, "方形 1024×1024"],
  [832, 1216, "竖版 832×1216"],
  [1216, 832, "横版 1216×832"],
  [512, 768, "快速 512×768"],
] as const;

function mask(k: string) {
  if (!k) return "";
  if (k.length <= 8) return "****";
  return `${k.slice(0, 3)}****${k.slice(-4)}`;
}

export default function ImageSettingsScreen() {
  const router = useRouter();
  const toast = useToast();
  const [image, setImage] = useState<ImageState | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testUrl, setTestUrl] = useState<string | null>(null);
  const [testMs, setTestMs] = useState<number | null>(null);
  const [testing, setTesting] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const tokenRef = useRef<string | null>(null);

  const load = useCallback(() => {
    try {
      const s = settingsState();
      setImage(s.image);
      setKeyInput("");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "没能读到生图设置。");
    }
  }, []);

  useFocusEffect(useCallback(() => load(), [load]));

  useEffect(() => {
    if (startedAt == null) {
      setElapsed(0);
      return;
    }
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(t);
  }, [startedAt]);

  async function save(next?: Partial<ImageState>) {
    if (!image) return;
    setBusy("save");
    setError(null);
    try {
      const merged = { ...image, ...(next ?? {}) };
      const img = await saveImage({
        enabled: merged.enabled,
        width: merged.width,
        height: merged.height,
        style: merged.style,
        apiBaseUrl: merged.apiBaseUrl,
        apiModel: merged.apiModel,
        ...(keyInput.trim() ? { apiKey: keyInput } : {}),
      });
      setImage(img);
      setKeyInput("");
      toast("已记下", "ok");
      haptic("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败。");
    } finally {
      setBusy(null);
    }
  }

  async function runTest() {
    if (testing) return;
    const token = `t_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    tokenRef.current = token;
    setTesting(true);
    setStartedAt(Date.now());
    setTestUrl(null);
    setTestMs(null);
    setError(null);
    try {
      const r = await testImage("a quiet room at dusk, warm lamp light", token);
      setTestUrl(r.url);
      setTestMs(r.ms);
      haptic("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "生图失败");
      haptic("error");
    } finally {
      setTesting(false);
      setStartedAt(null);
      tokenRef.current = null;
    }
  }

  function stopTest() {
    const t = tokenRef.current;
    if (t) cancelTestImage(t);
    setTesting(false);
    setStartedAt(null);
    toast("已停止生图");
  }

  return (
    <Screen title="生图" subtitle="给聊天配图 · 用你自己的 OpenAI 兼容接口" back onBack={() => router.push("/settings")}>
      {!image ? <Loading text="正在读生图设置……" /> : null}
      {image ? (
        <>
          <Card>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <Text style={styles.cardTitle}>生图</Text>
              <Pressable onPress={() => void save({ enabled: !image.enabled })} disabled={busy !== null}>
                <View style={[styles.pill, image.enabled ? styles.pillOn : null]}>
                  <Text style={[styles.pillText, { color: image.enabled ? C.gold : C.faint }]}>{image.enabled ? "开" : "关"}</Text>
                </View>
              </Pressable>
            </View>
            <Text style={styles.hint}>给聊天模式的会长消息配「此刻」的情景图。请求你填的 OpenAI 兼容生图接口。</Text>

            <Field label="接口地址" hint="到 /v1 为止；会请求 {地址}/images/generations">
              <Input value={image.apiBaseUrl} onChangeText={(v) => setImage({ ...image, apiBaseUrl: v })} placeholder="https://api.example.com/v1" autoCapitalize="none" />
            </Field>
            <Field label="模型名">
              <Input value={image.apiModel} onChangeText={(v) => setImage({ ...image, apiModel: v })} placeholder="例如 gpt-image-1 / flux" autoCapitalize="none" />
            </Field>
            <Field label="API Key（可选）" hint={`已保存：${mask(image.apiKey) || "（无）"}。留空表示不覆盖；Key 只进 SecureStore。`}>
              <Input value={keyInput} onChangeText={setKeyInput} placeholder={mask(image.apiKey) || "可留空"} secureTextEntry autoCapitalize="none" />
            </Field>
            <Field label="分辨率" hint="按接口支持的尺寸选；不支持时接口会报错">
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5 }}>
                {SIZES.map(([w, h, label]) => (
                  <Chip key={label} label={label} active={image.width === w && image.height === h} onPress={() => setImage({ ...image, width: w, height: h })} tone="gold" />
                ))}
              </View>
            </Field>
            <Field label="画风前缀（可选）" hint="每张图都会加在描述前面，用来统一画风">
              <Input value={image.style} onChangeText={(v) => setImage({ ...image, style: v })} />
            </Field>

            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: S.sm, marginTop: S.sm }}>
              <Button variant="outline" onPress={() => void save()} loading={busy === "save"}>保存</Button>
              <Button variant="gold" onPress={() => void runTest()} loading={testing} disabled={!image.enabled}>
                {testing ? `生图中… 已 ${elapsed}s` : "测试生图"}
              </Button>
              {testing ? <Button variant="danger" onPress={stopTest}>停止</Button> : null}
            </View>
            {testing ? <Text style={styles.hint}>正在请求生图接口，通常几秒到一分钟。生成好会在这里出图，等不及可点「停止」。</Text> : null}
            {error ? <ErrorBar text={error} /> : null}

            {testUrl ? (
              <Pressable onPress={() => setLightbox(testUrl)} style={{ marginTop: S.sm }}>
                <Image source={{ uri: testUrl }} style={styles.preview} contentFit="cover" />
                <Text style={styles.success}>生成成功，耗时 {testMs}ms（点击图片可放大）</Text>
              </Pressable>
            ) : null}
          </Card>
          <Text style={styles.hint}>不包含本地生图（mflux / LoRA / 量化 / HF 镜像）；只走上表填写的 API 渠道。</Text>
        </>
      ) : null}
      <ImageLightbox src={lightbox} onClose={() => setLightbox(null)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  cardTitle: { fontFamily: Fonts.display, fontSize: 18, color: C.fg },
  hint: { fontFamily: Fonts.body, fontSize: 10, color: C.faint, lineHeight: 16 },
  pill: { borderWidth: 1, borderColor: C.border, borderRadius: 99, paddingHorizontal: 10, paddingVertical: 2 },
  pillOn: { borderColor: C.goldLine, backgroundColor: C.goldSoft },
  pillText: { fontFamily: Fonts.mono, fontSize: 10 },
  preview: { width: "100%", aspectRatio: 1, borderRadius: R.tile, borderWidth: 1, borderColor: C.border },
  success: { fontFamily: Fonts.mono, fontSize: 10, color: C.gold, marginTop: 4 },
});
