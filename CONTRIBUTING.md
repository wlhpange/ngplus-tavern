# 贡献指南（Contributing）

欢迎提 issue 与 PR。这是一个**非商业**项目，采用 [PolyForm Noncommercial License 1.0.0](./LICENSE)：
提交贡献即表示你同意你的贡献以同一许可发布，并确认你对所提交内容拥有相应权利。

## 环境

- Node.js **22.x**、pnpm
- 复制 `.env.example` 为 `.env.local` 并至少填入一个渠道的 Key
  （`DEEPSEEK_API_KEY` 或 `OPENCODE_API_KEY`）

```bash
pnpm install
cp .env.example .env.local   # 填 Key
pnpm db:migrate              # 建表（首次）
pnpm dev                     # http://localhost:3000
```

## 提交前自检

```bash
pnpm test        # 全量单测（LLM 走 mock，不依赖真实 API）
pnpm exec tsc --noEmit
pnpm build       # 生产构建
```

- **不要并行运行多个 `pnpm build`**（会互相清空 `.next`）。
- 涉及数据库结构改动时：`ddl.ts` 与 `schema.ts` 同步，并给老库加一条**幂等**迁移（`migrations.ts`）。

## 约定

- 代码风格与现有文件保持一致；注释用中文、说明「为什么」。
- 关键设计取舍在注释里以 `DESIGN-DECISION` 标注。
- **绝不提交**：`.env.local`、`data/`、`backups/`、`logs/`、真实 API Key、第三方未授权素材。
- 新增第三方素材（字体/图片/音效/角色卡）时，注明来源与许可。

## 隐私 / 内容

- 本项目面向单机自用，请勿提交任何个人存档、对话或角色卡。
- R18 相关内容需在功能上默认关闭，且不得随仓库分发第三方受版权保护的素材。
