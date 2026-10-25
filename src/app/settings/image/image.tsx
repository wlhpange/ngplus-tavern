"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import BottomNav from "@/components/BottomNav";
import ImageLightbox from "@/components/ImageLightbox";
import LetterField, { LETTER_INPUT } from "@/components/LetterField";
import { toast } from "@/components/Toast";

interface ImageState {
  enabled: boolean;
  width: number;
  height: number;
  style: string;
  apiBaseUrl: string;
  apiKey: string;
  apiModel: string;
}

const DEFAULT_IMAGE: ImageState = {
  enabled: false,
  width: 1024,
  height: 1024,
  style: "cinematic lighting, detailed background, illustration, high quality",
  apiBaseUrl: "",
  apiKey: "",
  apiModel: "",
};

interface ConfigState {
  image?: ImageState;
}

/**
 * 生图设置（二级页）：只接 API。
 * 请求 {地址}/images/generations，兼容 b64_json / url 两种返回。
 */
export default function ImageSettingsClient() {
  const [image, setImage] = useState<ImageState>(DEFAULT_IMAGE);
  const [busy, setBusy] = useState<string | null>(null);
  const [testToken, setTestToken] = useState<string | null>(null);
  /** 测试生图开始时间 + 已用秒数 */
  const [testStartedAt, setTestStartedAt] = useState<number | null>(null);
  const [testElapsed, setTestElapsed] = useState(0);
  const [imageTest, setImageTest] = useState<
    { ok: true; url: string; ms: number } | { ok: false; error: string } | null
  >(null);
  const [lightbox, setLightbox] = useState<string | null>(null);

  // 测试生图进行中：每秒刷新已用时间
  useEffect(() => {
    if (testStartedAt == null) {
      setTestElapsed(0);
      return;
    }
    setTestElapsed(Math.floor((Date.now() - testStartedAt) / 1000));
    const timer = window.setInterval(() => {
      setTestElapsed(Math.floor((Date.now() - testStartedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [testStartedAt]);

  const load = useCallback(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d: ConfigState) => {
        if (d.image) setImage(d.image);
      })
      .catch(() => toast("没能读到生图设置。", "err"));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function post(body: Record<string, unknown>) {
    setBusy(String(body.action));
    setImageTest(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = (await res.json()) as Record<string, unknown>;
      if (body.action === "testImage") {
        setTestStartedAt(null);
        if (d.cancelled) {
          setTestToken(null);
          toast("已停止生图");
          return;
        }
        if (res.ok && d.ok) {
          setImageTest({ ok: true, url: d.url as string, ms: d.ms as number });
        } else {
          setImageTest({ ok: false, error: (d.error as string) ?? "生图失败" });
        }
        setTestToken(null);
        return;
      }
      if (!res.ok || d.error) {
        toast((d.error as string) ?? "没办成，请稍后再试。", "err");
        return;
      }
      if (d.image) setImage(d.image as ImageState);
      toast("已记下");
    } catch {
      toast("网络不通，请稍后再试。", "err");
    } finally {
      setBusy(null);
    }
  }

  async function cancelTestImage() {
    const token = testToken;
    if (!token) return;
    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancelTestImage", token }),
      });
    } catch {
      /* 停不到也无妨 */
    }
  }

  return (
    <main className="mx-auto flex h-dvh max-w-md flex-col bg-bg text-fg">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <h1 className="font-display text-fs-h1 leading-tight">生图</h1>
          <p className="font-numeric text-fs-micro tracking-wide text-muted">
            给聊天配图 · 用你自己的 OpenAI 兼容接口
          </p>
        </div>
        <Link
          href="/settings"
          className="rounded-btn px-2 py-1.5 text-fs-meta text-muted transition-colors hover:text-fg"
        >
          返回设置
        </Link>
      </header>

      <div className="flex-1 space-y-6 overflow-y-auto px-4 py-4">
        <section className="rounded-card border border-border bg-surface p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-fs-h2">生图</h2>
            <button
              type="button"
              onClick={() => post({ action: "saveImage", image: { ...image, enabled: !image.enabled } })}
              aria-pressed={image.enabled}
              className={`rounded-full border px-2 py-0.5 font-numeric text-fs-micro ${
                image.enabled ? "border-gold-line bg-gold-soft text-gold" : "border-border text-faint"
              }`}
            >
              {image.enabled ? "开" : "关"}
            </button>
          </div>
          <p className="mt-1 text-fs-micro leading-relaxed text-muted">
            给聊天模式的会长消息配「此刻」的情景图。请求你填的 OpenAI 兼容生图接口。
          </p>

          <div className="mt-3 space-y-3">
            <LetterField label="接口地址" hint="到 /v1 为止；会请求 {地址}/images/generations">
              <input
                className={LETTER_INPUT}
                value={image.apiBaseUrl}
                onChange={(e) => setImage({ ...image, apiBaseUrl: e.target.value })}
                placeholder="https://api.example.com/v1"
              />
            </LetterField>
            <LetterField label="模型名">
              <input
                className={LETTER_INPUT}
                value={image.apiModel}
                onChange={(e) => setImage({ ...image, apiModel: e.target.value })}
                placeholder="例如 gpt-image-1 / flux"
              />
            </LetterField>
            <LetterField label="API Key（可选）">
              <input
                className={LETTER_INPUT}
                type="password"
                value={image.apiKey}
                onChange={(e) => setImage({ ...image, apiKey: e.target.value })}
                placeholder="可留空"
              />
            </LetterField>
            <LetterField label="分辨率" hint="按接口支持的尺寸选；不支持时接口会报错">
              <select
                className={LETTER_INPUT}
                value={`${image.width}x${image.height}`}
                onChange={(e) => {
                  const [w, h] = e.target.value.split("x").map(Number);
                  setImage({ ...image, width: w, height: h });
                }}
              >
                <option value="1024x1024">方形 1024×1024（默认）</option>
                <option value="832x1216">竖版 832×1216</option>
                <option value="1216x832">横版 1216×832</option>
                <option value="512x768">快速 512×768</option>
              </select>
            </LetterField>
            <LetterField label="画风前缀（可选）" hint="每张图都会加在描述前面，用来统一画风">
              <input
                className={LETTER_INPUT}
                value={image.style}
                onChange={(e) => setImage({ ...image, style: e.target.value })}
              />
            </LetterField>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => post({ action: "saveImage", image })}
              className="rounded-btn border border-border-strong px-4 py-2 text-fs-sm text-fg transition-colors hover:bg-surface-2 disabled:opacity-40"
            >
              {busy === "saveImage" ? "保存中…" : "保存"}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => {
                const token = globalThis.crypto?.randomUUID?.() ?? `t_${Date.now()}`;
                setTestToken(token);
                setTestStartedAt(Date.now());
                post({ action: "testImage", token });
              }}
              className="rounded-btn border border-border-strong px-4 py-2 text-fs-sm text-fg transition-colors hover:bg-surface-2 disabled:opacity-40"
            >
              {busy === "testImage" ? `生图中… 已 ${testElapsed}s` : "测试生图"}
            </button>
            {busy === "testImage" && testToken && (
              <button
                type="button"
                onClick={() => void cancelTestImage()}
                className="rounded-btn border border-danger px-4 py-2 text-fs-sm text-danger-text transition-colors hover:bg-surface-2"
              >
                停止
              </button>
            )}
          </div>

          {busy === "testImage" && (
            <p className="text-fs-micro text-faint mt-2 leading-relaxed">
              正在请求生图接口，通常几秒到一分钟。生成好会在这里出图，等不及可点「停止」。
            </p>
          )}

          {imageTest?.ok && (
            <div className="mt-3">
              <button
                type="button"
                onClick={() => setLightbox(imageTest.url)}
                aria-label="查看大图"
                className="block w-full text-left"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={imageTest.url}
                  alt="生图测试"
                  className="w-full rounded-tile border border-border"
                />
              </button>
              <p className="mt-1 font-numeric text-fs-micro text-gold">
                生成成功，耗时 {imageTest.ms}ms（点击图片可放大）
              </p>
            </div>
          )}
          {imageTest && !imageTest.ok && (
            <div className="border-danger bg-surface-2 mt-2 rounded-tile border px-3 py-2">
              <p className="text-danger-text font-display text-fs-sm">生图失败</p>
              <p className="text-fs-meta text-danger-text mt-1 leading-relaxed">{imageTest.error}</p>
            </div>
          )}
        </section>
      </div>

      <BottomNav />

      {lightbox && <ImageLightbox src={lightbox} onClose={() => setLightbox(null)} />}
    </main>
  );
}
