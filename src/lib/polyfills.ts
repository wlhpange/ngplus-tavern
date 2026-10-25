/** React Native / Hermes 缺失的小型 Web API 补齐（只在缺失时安装）。 */

export function installPolyfills(): void {
  const AS = AbortSignal as unknown as {
    timeout?: (ms: number) => AbortSignal;
    any?: (signals: AbortSignal[]) => AbortSignal;
  };
  if (!AS.timeout) {
    AS.timeout = (ms: number) => {
      const c = new AbortController();
      setTimeout(() => c.abort(new Error("请求超时")), ms);
      return c.signal;
    };
  }
  if (!AS.any) {
    AS.any = (signals: AbortSignal[]) => {
      const c = new AbortController();
      for (const s of signals) {
        if (s.aborted) {
          c.abort(s.reason);
          break;
        }
        s.addEventListener("abort", () => c.abort(s.reason), { once: true });
      }
      return c.signal;
    };
  }
  if (typeof globalThis.structuredClone !== "function") {
    (globalThis as { structuredClone?: <T>(v: T) => T }).structuredClone = <T>(v: T): T =>
      JSON.parse(JSON.stringify(v)) as T;
  }
}
