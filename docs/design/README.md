# 星穹秘契 · 设计系统归档

品牌契约与设计 token 的来源文档。运行时**以 `src/app/tokens.css` 为准**
（`src/app/globals.css` 直接 import 它，tailwind.config.ts 的语义映射消费同一批变量）。

| 文件 | 说明 |
|---|---|
| `DESIGN.md` | 品牌契约：色彩策略、双通道强调规则、组件规范、动效基调（§1–§9） |
| `tokens.css` | 全部 CSS 变量；本目录与 `src/app/tokens.css` 保持逐字一致 |

维护约定：改 token 时先改 `src/app/tokens.css`，再同步回本目录并确认
`diff docs/design/tokens.css src/app/tokens.css` 无输出。

来源：早期由外部设计工具产出的方向稿（`ngplus-guild-design/`，含 7 页 HTML 原型），
V1.7 落地为全站设计系统；原型仅作历史参考，不作为实现依据。
