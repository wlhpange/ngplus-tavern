# 二周目协会 · Android

一间只有一个人的小协会。你和 AI「会长」对话，把想做却一直没做成的事锻造成委托；完成后结算经验与金币，升级、晋段、维持连击。也可以切到酒馆模式，和角色待一会儿。

**本仓库现在只有 Android 端**（Expo / React Native）。  
Web 版已归档到 GitHub 的 `web` 分支与 `web-v0.1.1` tag，不再维护。

- 数据只在手机本地 SQLite，不依赖电脑常开，不上传云端。
- API Key 只进 Android Keystore / iOS Keychain。
- 模型与生图都走你自己的 OpenAI 兼容 API；不包含本地生图/本地模型。

## 运行

```bash
npm install
npx expo start
```

- 手机装 **Expo Go**（需支持 SDK 58）扫码；或接 Android 设备/模拟器：
  ```bash
  npx expo run:android
  ```

## 构建 APK

```bash
npx expo prebuild -p android
cd android
./gradlew assembleRelease
```

产物：`android/app/build/outputs/apk/release/app-release.apk`（debug keystore 签名，适合个人侧载；上架需换成正式 keystore）。

## 主要功能

- 推门 / 选会长 / 更换会长 / 新增会长（AI 锻造）/ 导入 V1–V3 角色卡（含世界书）/ 翻译
- 任务 + 聊天双管线：流式、工具调用、多会话、开场白、背景、分页、删除、场景配图、Markdown、升级/晋段仪式、复核与争议
- 委托板 / 档案室 / 结算 / 逾期
- 面板：等级、评级、六维、称号、图鉴、周常 Boss、月账单（CSV / Markdown 导出）
- 商店（购买、库存、休整卷轴、礼物、亲密度）、技能树
- 世界书、记忆书、聊天记录、冒险者卡、R18 开关、每日事件、签到/连击/跨天补算
- LPC 像素小人：1053 张分层素材、7 槽位、5 材质色、变体颜色、待机/动作/走路
- 模型渠道：DeepSeek / OpenCode / 自定义 API + 测试连接；API 生图

## 文档

- `docs/PARITY.md`：Web → Android 功能逐项对照与验收记录
- `docs/MANUAL-TEST.md`：真机手动验收清单
- `docs/CREDITS-lpc.md`：LPC 像素素材署名

## 许可

非商业许可 [PolyForm Noncommercial 1.0.0](./LICENSE)。可以自由使用、修改、分发，**不能商用**。  
含 R18 内容开关（默认关闭，18+）；单用户、无鉴权，不要部署到公网。
