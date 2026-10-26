import { useCallback, useState } from "react";
import { useFocusEffect, useRouter } from "expo-router";
import { StyleSheet, Text, View } from "react-native";

import { C, Fonts, S } from "@/constants/theme";
import { Button, Card, ErrorBar, Loading, Screen, haptic } from "@/components/ui";
import { useToast } from "@/components/Toast";
import { playCue } from "@/lib/audio";
import { skillsData, unlockSkill } from "@/lib/service";

interface SkillView {
  key: string;
  name: string;
  desc: string;
  cost_gold: number;
  min_level: number;
  effect: { type: string; value: number };
  owned: boolean;
  levelOk: boolean;
  affordable: boolean;
}
interface SkillsResponse { gold: number; totalLevel: number; skills: SkillView[] }

export default function SkillsScreen() {
  const router = useRouter();
  const toast = useToast();
  const [data, setData] = useState<SkillsResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    try {
      setData(skillsData() as SkillsResponse);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "技能树没能取出来。");
    }
  }, []);

  useFocusEffect(useCallback(() => load(), [load]));

  async function unlock(s: SkillView) {
    if (busy) return;
    setBusy(s.key);
    setError(null);
    try {
      unlockSkill(s.key);
      playCue("purchase");
      toast(`点亮了「${s.name}」。它已经生效了。`, "ok");
      haptic("success");
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "协会那边没办成。");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Screen title="技能树" subtitle="金币 + 等级解锁，点亮后一直生效" back onBack={() => router.push("/character")}>
      {data ? (
        <Text style={styles.meta}>当前 Lv.{data.totalLevel} · 金币 {data.gold} · 已点亮 {data.skills.filter((s) => s.owned).length}/{data.skills.length}</Text>
      ) : null}
      {!data && !error ? <Loading text="正在翻技能树……" /> : null}
      {error ? <ErrorBar text={error} /> : null}
      {data?.skills.map((s) => {
        const requirement = s.owned ? "已点亮" : !s.levelOk ? `需要 Lv.${s.min_level}` : !s.affordable ? "金币不够" : null;
        return (
          <Card key={s.key} gold={s.owned}>
            <View style={{ flexDirection: "row", alignItems: "flex-start", gap: S.sm }}>
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <Text style={styles.name}>
                  {s.name}
                  {s.owned ? <Text style={styles.owned}>  ✓ 已点亮</Text> : null}
                </Text>
                <Text style={styles.desc}>{s.desc}</Text>
                <Text style={styles.cost}>{s.cost_gold} 金币 · 需要 Lv.{s.min_level}</Text>
              </View>
              {!s.owned ? (
                <Button
                  variant={s.levelOk && s.affordable ? "gold" : "outline"}
                  small
                  disabled={!s.levelOk || !s.affordable || busy !== null}
                  loading={busy === s.key}
                  onPress={() => void unlock(s)}
                >
                  {requirement ?? "解锁"}
                </Button>
              ) : null}
            </View>
          </Card>
        );
      })}
      <Text style={styles.hint}>效果由结算/签到引擎读取生效，页面只负责展示与解锁。</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  meta: { fontFamily: Fonts.mono, fontSize: 10, color: C.faint },
  name: { fontFamily: Fonts.display, fontSize: 16, color: C.fg },
  owned: { fontFamily: Fonts.mono, fontSize: 10, color: C.gold },
  desc: { fontFamily: Fonts.body, fontSize: 11, color: C.muted, lineHeight: 17 },
  cost: { fontFamily: Fonts.mono, fontSize: 9, color: C.faint },
  hint: { fontFamily: Fonts.body, fontSize: 10, color: C.faint },
});
