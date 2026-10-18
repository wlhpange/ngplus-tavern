/**
 * 情绪 → 表情图层 的轻量识别。
 *
 * 不调用任何模型：对会长本轮的回复文本做关键词打分，选一个表情。
 * 命中不了就返回 neutral（也不覆盖用户设定的表情）。
 *
 * 表情 id 对应 catalog 里的 face_* 部件（LPC 表情图层）。
 */

export type FaceId =
  | "face_neutral"
  | "face_happy"
  | "face_sad"
  | "face_angry"
  | "face_shock"
  | "face_blush";

interface Rule {
  id: FaceId;
  words: string[];
}

// 顺序即优先级（同分时靠前者胜）：惊 → 怒 → 羞 → 喜 → 悲
const RULES: Rule[] = [
  {
    id: "face_shock",
    words: ["震惊", "吃惊", "惊愕", "惊讶", "惊", "愣住", "愣", "呆住", "瞪大", "愕然", "没想到", "猛然", "shock", "surprise", "startled", "stun"],
  },
  {
    id: "face_angry",
    words: ["愤怒", "生气", "发怒", "恼怒", "怒火", "咬牙", "低吼", "怒吼", "瞪", "皱眉", "恼", "凶", "滚", "angry", "furious", "mad", "rage", "annoyed"],
  },
  {
    id: "face_blush",
    words: ["脸红", "红了脸", "羞", "害羞", "羞涩", "赧", "耳根", "不好意思", "忸怩", "blush", "shy", "embarrass"],
  },
  {
    id: "face_happy",
    words: ["笑", "开心", "高兴", "愉快", "欣喜", "欢喜", "愉悦", "乐", "欣慰", "哈哈", "嘻", "微笑", "大笑", "嘴角", "轻快", "happy", "smile", "laugh", "joy", "glad", "cheer"],
  },
  {
    id: "face_sad",
    words: ["难过", "悲伤", "伤感", "伤心", "哭", "泪", "泣", "失落", "沮丧", "叹息", "叹", "低落", "黯然", "苦涩", "sad", "cry", "tear", "upset", "sorrow", "sigh"],
  },
];

/** 从文本里识别最可能的情绪表情（无命中 → neutral） */
export function detectFace(text: string): FaceId {
  if (!text) return "face_neutral";
  const t = text.toLowerCase();
  let best: FaceId = "face_neutral";
  let bestScore = 0;
  for (const rule of RULES) {
    let score = 0;
    for (const w of rule.words) {
      // 统计出现次数（简单包含即算一次）
      let idx = t.indexOf(w.toLowerCase());
      while (idx !== -1) {
        score++;
        idx = t.indexOf(w.toLowerCase(), idx + w.length);
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = rule.id;
    }
  }
  return bestScore > 0 ? best : "face_neutral";
}
