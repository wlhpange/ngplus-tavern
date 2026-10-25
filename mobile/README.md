# 二周目协会 · Android（Expo）

Web 版在 `main` 分支；这里是**本地优先**的 Android 版：数据在手机 SQLite，不依赖电脑常开，也不从 Web 迁移数据。

## 运行

```bash
cd mobile
npm install
npx expo start
```

- 手机装 **Expo Go**（需支持 SDK 58），扫码即可。
- 或者接上 Android 设备 / 模拟器：`npx expo run:android`。

## 现在有什么

- 5 个 Tab：委托 / 面板 / 对话 / 商店 / 设置（暗金主题，自绘底栏）。
- **对话**：直连 OpenAI 兼容接口，流式输出；消息落本地 SQLite。
- **设置**：接口地址 / 模型名存 SQLite，API Key 只进系统安全存储（Keystore / Keychain）；带「测试连接」。
- 委托 / 面板 / 商店：首版占位，先把壳和对话跑通。

## 结构

```
mobile/
  src/app/(tabs)/        5 个页面
  src/components/        Page / Card / GoldTabBar
  src/lib/db.ts          SQLite（app_settings + chat_log）
  src/lib/settings.ts    模型配置 + SecureStore
  src/lib/llm.ts         OpenAI 兼容流式客户端（expo/fetch）
  src/constants/theme.ts 与 Web tokens.css 对齐的暗金色板
```

## 下一步

1. 把 Web 的委托 / 结算 / 记忆等领域逻辑改成 async，移植到 `src/lib/`。
2. 补商店、技能树、世界书、冒险者卡。
3. 动效与 Android 返回手势、键盘细节打磨。

## 注意

- 本地生图（mflux / LoRA）在本分支已移除，只保留 API 生图。
- 数据不迁移：手机从空库开始（官方会长等种子数据后续补）。
