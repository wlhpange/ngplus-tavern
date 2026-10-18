"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import BottomNav from "@/components/BottomNav";
import LetterField, { LETTER_INPUT } from "@/components/LetterField";
import { toast } from "@/components/Toast";

interface ModelOption {
  id: string;
  label: string;
}

interface ConfigState {
  hasKey: boolean;
  apiKeyMasked: string | null;
  baseUrl: string;
  model: string;
  judgeModel: string;
  provider?: "deepseek" | "opencode-go" | "local";
  models?: ModelOption[];
  providers?: { id: "deepseek" | "opencode-go" | "local"; label: string }[];
}

/**
 * 模型与渠道设置（二级页）：从设置首页拆出，避免主页过长。
 * Key 服务端内置，前端只切渠道 / 模型 / 复核模型，并可测试连接。
 */
export default function ModelSettingsClient() {
  const [state, setState] = useState<ConfigState | null>(null);
  const [model, setModel] = useState("");
  const [judgeModel, setJudgeModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<
    { ok: true; latencyMs: number; model: string } | { ok: false; error: string } | null
  >(null);

  const load = useCallback(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d: ConfigState) => {
        setState(d);
        setModel(d.model);
        setJudgeModel(d.judgeModel ?? "");
        setBaseUrl(d.baseUrl ?? "");
      })
      .catch(() => toast("没能读到模型设置。", "err"));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function post(body: Record<string, unknown>) {
    setBusy(String(body.action));
    setTestResult(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = (await res.json()) as Record<string, unknown>;
      if (body.action === "test") {
        if (res.ok && d.ok) {
          setTestResult({
            ok: true,
            latencyMs: d.latencyMs as number,
            model: d.model as string,
          });
        } else {
          setTestResult({ ok: false, error: (d.error as string) ?? "连接失败" });
        }
        return;
      }
      if (!res.ok || d.error) {
        toast((d.error as string) ?? "没办成，请稍后再试。", "err");
        return;
      }
      const next = d as unknown as ConfigState;
      setState(next);
      setModel(next.model);
      setJudgeModel(next.judgeModel ?? "");
      toast("已记下");
    } catch {
      toast("网络不通，请稍后再试。", "err");
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="mx-auto flex h-dvh max-w-md flex-col bg-bg text-fg">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <h1 className="font-display text-fs-h1 leading-tight">模型与渠道</h1>
          <p className="font-numeric text-fs-micro tracking-wide text-muted">
            会长的嗓门由这里驱动 · Key 从环境变量读取
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
        <section
          className="relative rounded-card border border-border bg-surface p-4"
          style={{ boxShadow: "inset 0 0 0 1px color-mix(in oklch, var(--gold) 10%, transparent)" }}
        >
          <h2 className="mb-4 font-display text-fs-h2">模型配置</h2>

          <div className="mb-4 flex flex-wrap gap-2">
            {(
              state?.providers ?? [
                { id: "deepseek", label: "DeepSeek 官方" },
                { id: "opencode-go", label: "OpenCode Go" },
                { id: "local", label: "自定义 API" },
              ]
            ).map((p) => (
              <button
                key={p.id}
                type="button"
                disabled={busy !== null}
                onClick={() => post({ action: "save", provider: p.id })}
                className={`rounded-pill border px-3 py-1 text-fs-meta transition-colors disabled:opacity-40 ${
                  (state?.provider ?? "deepseek") === p.id
                    ? "border-gold-line bg-gold-soft text-gold font-medium"
                    : "border-border text-muted hover:text-fg"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="space-y-4">
            {state?.provider === "local" ? (
              <>
                <LetterField label="接口地址" hint="OpenAI 兼容端点，一般以 /v1 结尾">
                  <input
                    className={LETTER_INPUT}
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder="http://127.0.0.1:12345/v1"
                  />
                </LetterField>
                <LetterField label="模型名">
                  <input
                    className={LETTER_INPUT}
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="例如 llama-3.1-8b"
                  />
                </LetterField>
                <LetterField
                  label="API Key（可选）"
                  hint="本机服务通常不校验可留空；已保存的只显示掩码，重新填写才会覆盖"
                >
                  <input
                    className={LETTER_INPUT}
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={state?.apiKeyMasked ?? "可留空"}
                  />
                </LetterField>
              </>
            ) : (
              <>
                <LetterField label="模型" hint="各渠道都用这里切换；换渠道会自动落到该渠道默认模型">
                  <select
                    className={`${LETTER_INPUT} bg-transparent`}
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                  >
                    {(state?.models ?? []).map((m) => (
                      <option key={m.id} value={m.id} className="bg-surface text-fg">
                        {m.label}
                      </option>
                    ))}
                  </select>
                </LetterField>

                <LetterField
                  label="复核判定模型（可选）"
                  hint="用于结算复核，在当前渠道内选择；留空则跟随主模型。判定失败会自动维持原判。"
                >
                  <select
                    className={`${LETTER_INPUT} bg-transparent`}
                    value={judgeModel}
                    onChange={(e) => setJudgeModel(e.target.value)}
                  >
                    <option value="" className="bg-surface text-fg">
                      跟随主模型{model ? `（${model}）` : ""}
                    </option>
                    {(state?.models ?? []).map((m) => (
                      <option key={m.id} value={m.id} className="bg-surface text-fg">
                        {m.label}
                      </option>
                    ))}
                  </select>
                </LetterField>
              </>
            )}
          </div>

          {state?.provider === "opencode-go" && (
            <p className="border-gold-line bg-gold-soft text-fs-micro mt-4 rounded-tile border px-3 py-2 leading-relaxed text-gold">
              当前走 OpenCode Go 套餐（端点 zen/go）。若不想在额度用满后回落到余额扣费，
              请到 console.opencode.ai 关掉「Use balance」。
            </p>
          )}
          {state?.provider === "local" && (
            <p className="border-border bg-surface-2 text-fs-micro text-muted mt-4 rounded-tile border px-3 py-2 leading-relaxed">
              自定义 API：填你自己的 OpenAI 兼容服务地址、模型名和 Key（本机服务 Key 可留空）。
              你启动了什么，这里就填什么。
            </p>
          )}

          <div className="mt-5 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() =>
                post(
                  state?.provider === "local"
                    ? {
                        action: "save",
                        provider: "local",
                        baseUrl,
                        model,
                        ...(apiKey ? { apiKey } : {}),
                      }
                    : { action: "save", model, judgeModel },
                )
              }
              className="rounded-btn bg-gold px-4 py-2 text-fs-sm font-medium text-on-gold transition-transform active:translate-y-px disabled:opacity-40"
            >
              {busy === "save" ? "保存中…" : "保存"}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => {
                if (state?.provider === "local" && !model.trim()) {
                  toast("先填模型名（可访问「接口地址」/models 看服务暴露的名字）", "err");
                  return;
                }
                post(
                  state?.provider === "local"
                    ? {
                        action: "test",
                        provider: "local",
                        baseUrl,
                        model,
                        ...(apiKey ? { apiKey } : {}),
                      }
                    : { action: "test", model },
                );
              }}
              className="rounded-btn border border-border-strong px-4 py-2 text-fs-sm text-fg transition-colors hover:bg-surface-2 disabled:opacity-40"
            >
              {busy === "test" ? "叩门中…" : "测试连接"}
            </button>
          </div>
          {testResult && (
            <p
              className={`mt-2 rounded-tile border px-3 py-2 font-numeric text-fs-meta ${
                testResult.ok
                  ? "border-success bg-success-soft text-success-text"
                  : "border-danger bg-surface-2 text-danger-text"
              }`}
            >
              {testResult.ok
                ? `通了。模型 ${testResult.model} 应答正常，耗时 ${testResult.latencyMs}ms。`
                : `没通：${testResult.error}`}
            </p>
          )}
        </section>

        {/* Key 状态：信息量低，收进模型页底部 */}
        <section className="rounded-card border border-border bg-surface p-4">
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden
              className={`h-2.5 w-2.5 rounded-full ${state?.hasKey ? "bg-success" : "bg-faint"}`}
            />
            <span className="text-fs-body">当前 Key</span>
            <span className="ml-auto rounded-full border border-gold-line bg-gold-soft px-2 py-0.5 font-numeric text-fs-micro text-gold">
              {state?.hasKey ? "已配置" : "未配置"}
            </span>
          </div>
          <p className="text-fs-micro text-muted mt-2 leading-relaxed">
            掩码：
            <span className="font-numeric tabular-nums text-fg">
              {state?.apiKeyMasked ?? "（无）"}
            </span>
            。Key 从服务端环境变量读取（`.env.local` 里的 `DEEPSEEK_API_KEY` / `OPENCODE_API_KEY`），前端不填写。
          </p>
        </section>
      </div>

      <BottomNav />
    </main>
  );
}
