/**
 * 音效层（Android，移植自 Web 端 src/lib/audio.ts）。
 *
 * 规格见 .zcode/plans/design-prompts-gamefeel.md §三：实物拟音的短促 one-shot。
 * 设计取舍：外部音频素材尚未产出，这里继续用合成音色（木、铜、纸、蜡），
 * 单条 ≤1.5s、响度克制；素材到位后按同名 cue 替换实现即可，调用方不用改。
 *
 * 与 Web 的差异只有底层引擎和开关存储：
 * - Web 用浏览器 Web Audio API，这里用 react-native-audio-api（同一套接口）。
 * - Web 开关存 localStorage（ngplus.sound），这里存本机 SQLite 的 ui.sound，
 *   与设置页「音效」共用同一个偏好；默认开。
 *
 * 单例 AudioContext：首次真正播 cue 时才创建（此时一定已有用户点击），
 * 避免 App 启动就占用音频资源。
 */

import { AudioContext } from "react-native-audio-api";

import { getUiPref, setUiPref } from "./service";

export type SoundCue =
  | "button"
  | "settle"
  | "settle_partial"
  | "level_up"
  | "rank_up"
  | "streak_break"
  | "scroll"
  | "purchase"
  | "gift"
  | "dispute";

const PREF_KEY = "sound";

let ctx: AudioContext | null = null;
/** -1 = 还没读过；0 = 关；1 = 开。避免每次 cue 都查 SQLite。 */
let enabledCache: boolean | null = null;

export function soundEnabled(): boolean {
  if (enabledCache !== null) return enabledCache;
  try {
    enabledCache = getUiPref(PREF_KEY, "1") !== "0";
    return enabledCache;
  } catch {
    // DB 还没就绪：本次按开处理，但不缓存，等下次再读。
    return true;
  }
}

export function setSoundEnabled(on: boolean): void {
  enabledCache = on;
  try {
    setUiPref(PREF_KEY, on ? "1" : "0");
  } catch {
    /* 写入失败也不阻断当前这次开关操作 */
  }
}

function audio(): AudioContext | null {
  if (!soundEnabled()) return null;
  try {
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => undefined);
    }
    return ctx;
  } catch {
    return null;
  }
}

interface ToneOptions {
  freq: number;
  at?: number;
  dur?: number;
  type?: "sine" | "square" | "sawtooth" | "triangle";
  gain?: number;
  /** 频率滑动终点（用于"闷响""落袋"这类滑音） */
  sweepTo?: number;
}

function tone(ac: AudioContext, o: ToneOptions): void {
  const t = ac.currentTime + (o.at ?? 0);
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = o.type ?? "sine";
  osc.frequency.setValueAtTime(o.freq, t);
  if (o.sweepTo) osc.frequency.exponentialRampToValueAtTime(o.sweepTo, t + (o.dur ?? 0.15));
  const peak = o.gain ?? 0.05;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + (o.dur ?? 0.15));
  osc.connect(g);
  g.connect(ac.destination);
  osc.start(t);
  osc.stop(t + (o.dur ?? 0.15) + 0.02);
}

interface NoiseOptions {
  at?: number;
  dur?: number;
  gain?: number;
  freq?: number;
  q?: number;
}

/** 带通噪声：木头、纸、蜡这类没有明确音高的质感动效 */
function noise(ac: AudioContext, o: NoiseOptions = {}): void {
  const dur = o.dur ?? 0.06;
  const t = ac.currentTime + (o.at ?? 0);
  const frames = Math.max(1, Math.floor(ac.sampleRate * dur));
  const buffer = ac.createBuffer(1, frames, ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
  }
  const src = ac.createBufferSource();
  src.buffer = buffer;
  const filter = ac.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = o.freq ?? 900;
  filter.Q.value = o.q ?? 1.2;
  const g = ac.createGain();
  g.gain.value = o.gain ?? 0.05;
  src.connect(filter);
  filter.connect(g);
  g.connect(ac.destination);
  src.start(t);
}

/** 铜币落袋：高频短音 + 一点噪声面 */
function coin(ac: AudioContext, at: number, freq = 1500): void {
  tone(ac, { freq, at, dur: 0.12, type: "triangle", gain: 0.035, sweepTo: freq * 0.86 });
  noise(ac, { at, dur: 0.05, gain: 0.02, freq: freq * 1.4, q: 2 });
}

export function playCue(cue: SoundCue): void {
  const ac = audio();
  if (!ac) return;
  switch (cue) {
    case "button":
      // 极轻一声木叩（各处复用）
      noise(ac, { dur: 0.045, gain: 0.03, freq: 480, q: 1.6 });
      tone(ac, { freq: 190, dur: 0.05, gain: 0.02, sweepTo: 150 });
      break;
    case "settle":
      // 蜡封「噗」+ 铜币落袋轻响
      noise(ac, { dur: 0.09, gain: 0.05, freq: 320, q: 1.1 });
      tone(ac, { freq: 150, at: 0.01, dur: 0.16, gain: 0.045, sweepTo: 95 });
      coin(ac, 0.32, 1450);
      coin(ac, 0.44, 1750);
      coin(ac, 0.58, 1300);
      break;
    case "settle_partial":
      noise(ac, { dur: 0.09, gain: 0.045, freq: 300, q: 1.1 });
      tone(ac, { freq: 140, at: 0.01, dur: 0.16, gain: 0.04, sweepTo: 90 });
      coin(ac, 0.34, 1250);
      coin(ac, 0.5, 1100);
      break;
    case "level_up":
      // 拨弦上行三音，克制
      tone(ac, { freq: 523, dur: 0.16, gain: 0.04, type: "triangle" });
      tone(ac, { freq: 659, at: 0.12, dur: 0.16, gain: 0.042, type: "triangle" });
      tone(ac, { freq: 784, at: 0.24, dur: 0.24, gain: 0.045, type: "triangle" });
      break;
    case "rank_up":
      // 开门钟：一记带余韵的钟
      tone(ac, { freq: 520, dur: 1.4, gain: 0.05, type: "sine" });
      tone(ac, { freq: 1040, dur: 1.1, gain: 0.02, type: "sine" });
      tone(ac, { freq: 1560, at: 0.01, dur: 0.7, gain: 0.012, type: "sine" });
      break;
    case "streak_break":
      // 低沉木鱼一记：遗憾，不是惩罚
      tone(ac, { freq: 140, dur: 0.32, gain: 0.05, sweepTo: 105, type: "sine" });
      noise(ac, { dur: 0.06, gain: 0.03, freq: 260, q: 1.2 });
      break;
    case "scroll":
      // 纸张展开
      noise(ac, { dur: 0.18, gain: 0.035, freq: 2400, q: 0.9 });
      tone(ac, { freq: 620, at: 0.16, dur: 0.22, gain: 0.03, type: "triangle" });
      break;
    case "purchase":
      // 铜币划过木柜台
      coin(ac, 0, 1650);
      coin(ac, 0.09, 1350);
      noise(ac, { at: 0.02, dur: 0.08, gain: 0.028, freq: 520, q: 1.5 });
      break;
    case "gift":
      // 纸盒轻放 + 暖音
      noise(ac, { dur: 0.1, gain: 0.03, freq: 700, q: 1.1 });
      tone(ac, { freq: 392, at: 0.06, dur: 0.22, gain: 0.032, type: "triangle" });
      tone(ac, { freq: 587, at: 0.14, dur: 0.24, gain: 0.028, type: "triangle" });
      break;
    case "dispute":
      // 羽毛笔划纸一记
      noise(ac, { dur: 0.14, gain: 0.035, freq: 3200, q: 0.8 });
      break;
  }
}
