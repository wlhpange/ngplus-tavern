import { NextResponse } from "next/server";
import { bootstrap } from "@/server/bootstrap";
import { getCharacterSummary, getMonthSummary } from "@/server/character";
import { allRanks, rankBadgeInfo } from "@/server/engine/leveling";
import { listSkills } from "@/server/skills";
import { listAchievements } from "@/server/achievements";
import { getWeeklyBossState } from "@/server/weeklyBoss";

export const dynamic = "force-dynamic";

export async function GET() {
  const { db, userId } = bootstrap();
  const summary = getCharacterSummary(db, userId);
  const skills = listSkills(db, userId);
  const dex = listAchievements(db, userId);
  const weeklyBoss = getWeeklyBossState(db, userId);
  return NextResponse.json({
    ...summary,
    rankBadge: rankBadgeInfo(summary.totalLevel),
    ranks: allRanks(),
    monthSummary: getMonthSummary(db, userId),
    skillSummary: {
      owned: skills.skills.filter((s) => s.owned).length,
      total: skills.skills.length,
    },
    achievements: dex.achievements,
    achievementSummary: { owned: dex.owned, total: dex.total },
    weeklyBoss: {
      week: weeklyBoss.week,
      name: weeklyBoss.boss.name,
      desc: weeklyBoss.boss.desc,
      progress: weeklyBoss.progress,
      target: weeklyBoss.boss.target,
      claimed: weeklyBoss.claimed,
      reward: weeklyBoss.reward,
    },
  });
}
