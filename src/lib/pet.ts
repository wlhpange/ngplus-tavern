/**
 * 对话页像素小人的显示开关（本机 localStorage，与音效同级）。
 * 默认开；关掉后对话页不渲染小人（任务 / 聊天两个模式都生效）。
 */

const STORAGE_KEY = "ngplus.pet";

export function petEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setPetEnabled(on: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
  } catch {
    /* 隐私模式等场景静默失败 */
  }
}
