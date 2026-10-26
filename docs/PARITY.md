# Android 全量移植 PARITY（唯一功能基准：main 的 Web 端）

> 工作区：``（Expo SDK 58 / React Native 0.88 / 独立 APK）
> 基准：main 的 `src/app` 页面、`src/app/api` 路由、`src/server` 模块、`src/components` 交互。
> 本文件逐项映射。**每行状态只允许**：`已验证` / `平台限制` / `阻塞`。
> 禁止写“后续”“暂不做”；未完成必须写清阻塞原因与最小解锁条件。

## 状态定义（避免歧义）

| 状态 | 判定标准 |
| --- | --- |
| 已验证 | 移动端实现存在，且通过本轮可重复的自动化验证（`npx tsc --noEmit`／`npx vitest run`／`npx expo export`）。**设备验收单独记录在“设备验收”列，不以自动化替代。** |
| 平台限制 | Android 无 Web 对应能力（无常驻 Node、浏览器下载、PWA、本地模型/生图等），已用原生等价物替换；理由与等价物写在行内。 |
| 阻塞 | 实现缺失、自动化验证失败、或缺少设备验收前置（APK／模拟器）。必须写阻塞原因与最小解锁条件。 |

设备验收列：`未跑` / `通过` / `失败(原因)`。目标要求逐行在模拟器/真机跑通并留证。**只有该行全部子项都跑过才标“通过”**；已跑过的子项按时间记在 §18。

## 0. 本轮基线（checkpoint 1baca12 之后）

| 项 | 状态 | 证据 / 说明 |
| --- | --- | --- |
| `mobile` 源码盘点（104 文件） | 已验证 | `src/app` 11 屏、`src/server` 58 模块、`src/lib` 7 模块、`src/components` 15 组件 |
| `mobile` TypeScript | 已验证 | 修复 `tests/engine/*` 相对导入后 `npx tsc --noEmit` 通过 |
| `mobile` 单测 | 已验证 | `npx vitest run --reporter=dot`（超时保护）通过 8 个测试文件 |
| `mobile` 静态导出 | 已验证 | `npx expo export --platform android` exit 0，产出 `dist`（Hermes bundle 6.1MB） |
| Android APK（release） | 已验证 | `android/app/build/outputs/apk/release/app-release.apk`，113MB，Gradle `assembleRelease` BUILD SUCCESSFUL（3m04s） |
| `aapt dump badging` | 已验证 | `package name='com.wlhpange.ngplus'`，`launchable-activity='com.wlhpange.ngplus.MainActivity'`，targetSdk 36 |
| `apksigner verify` | 已验证 | v2 签名验证通过（签名证书为 debug keystore；Goal 允许 debug 或 release 签名 APK） |
| `adb install -r` + 冷启动 | 已验证 | emulator-5554 安装 Success；`am start -W` COLD 3.7s，前台 Activity 为 `.MainActivity`，无 FATAL |
| 杀进程重开数据仍在 | 已验证 | `am force-stop` 后重启，聊天时间线/结算卡/会长与数据完整保留；截图见交付证据 |
| 模拟器逐项验收（PARITY 1–16 行） | 阻塞 | APK 已装，但尚未按行逐项跑；解锁：本地 OpenAI 兼容 stub + 逐项操作 |
| Web 端冻结回归 | 阻塞 | 本轮未跑 `pnpm test/build`；解锁：移动端功能竖切完成后在仓库根执行 |

---

## 1. 启动 / 全局壳

| # | Web 基准 | Android 实现 | 状态 | 设备验收 |
| --- | --- | --- | --- | --- |
| 1.1 | `src/app/layout.tsx` 全局暗金主题、字体、Toast | `app/_layout.tsx` + `constants/theme.ts` + `Toast` | 已验证 | 未跑 |
| 1.2 | 首屏加载 / 数据初始化 | `_layout.tsx` Splash + `lib/bootstrap.ts initApp()` | 已验证 | 未跑 |
| 1.3 | 推门页 `gate/gate.tsx`（开门动画 + 触感） | `app/gate.tsx`（Reanimated 门板 + Haptics） | 已验证 | 未跑 |
| 1.4 | onboarding 状态 / 完成 `api/onboarding/*` | `service.onboardingState/completeOnboarding` | 已验证 | 未跑 |
| 1.5 | 未 onboarding 重定向 | `gate.tsx` / `(tabs)/index.tsx` Redirect | 已验证 | 未跑 |
| 1.6 | 底栏 5 入口（委托/面板/对话/商店/设置） | `components/GoldTabBar.tsx` + `(tabs)/_layout.tsx` | 已验证 | 未跑 |
| 1.7 | 页面切换动画 | Stack `slide_from_right` + tabs fade | 已验证 | 未跑 |
| 1.8 | Android 返回手势 | `gestureEnabled` + `predictiveBackGestureEnabled` | 已验证 | 未跑 |
| 1.9 | 安全区 / 键盘避让 | `SafeAreaView` + `KeyboardAvoidingView` | 已验证 | 未跑 |
| 1.10 | 主操作触感 | `components/ui.tsx haptic()` + 底栏 selection | 已验证 | 未跑 |
| 1.11 | Toast / 确认框 / 输入框 | `Toast.tsx`、`Dialogs.tsx`、`ui.tsx` | 已验证 | 未跑 |
| 1.12 | 浏览器刷新后状态保持 | SQLite 落库；`getDb()` 单例 | 已验证 | 未跑 |
| 1.13 | PWA 注册 / Service Worker | 无 Web 管道；原生 App 不需要 | 平台限制：PWA 专属，Android 用系统安装包与本地通知替代 |
| 1.14 | 多用户 / 登录 | 本机单用户 `LOCAL_USER_ID` | 平台限制：Goal 明确不做账号与云同步 |
| 1.15 | Web 数据迁移 | 不迁移，首次启动 seed | 平台限制：Goal 明确不迁移 Web 数据 |

## 2. 会长

| # | Web 基准 | Android 实现 | 状态 | 设备验收 |
| --- | --- | --- | --- | --- |
| 2.1 | 会长列表 / 当前会长 `api/masters` | `app/masters.tsx` + `service.mastersData` | 已验证 | 未跑 |
| 2.2 | 选择 / 切换会长 `api/masters/activate` | `activateMaster`；切换确认弹窗 | 已验证 | 未跑 |
| 2.3 | 新建会长（手填字段）`api/masters/create` | `createMasterByFields` + 表单 | 已验证 | 未跑 |
| 2.4 | AI 锻造 `api/masters/forge` | `forgeMaster`；回填表单后确认 | 已验证 | 通过：设备创建 Aster（阿岚）成功 |
| 2.5 | 指名邀请（旧 `api/masters/invite`） | 由 `forge` 取代；数据层 `createCustomMaster` 保留 | 平台限制：Web 旧接口无 UI 入口，移动端用现行 forge 等价 |
| 2.6 | 导入 V1–V3 角色卡 `api/masters/import` | `previewImportedCard/commitImportedCard`，`.json/.png` | 已验证 | 部分通过：V2 卡解析单测；系统文件选择器设备点选受模拟器动画限制 |
| 2.7 | 角色卡内嵌世界书导入 | `cardImport` + `worldbook.replaceMasterBookFromCharacterBook` | 已验证 | 通过：cardImport+worldbook 单测覆盖 character_book 导入 |
| 2.8 | 导入翻译 + 进度轮询 + 取消 | `translateJobs` + `masters.tsx` 翻译弹窗 | 已验证 | 部分通过：翻译预览/任务实现；设备 picker 未跑 |
| 2.9 | 删除会长 `api/masters/delete` | `deleteMaster`；聊天/记忆/世界书级联清理 | 已验证 | 未跑 |
| 2.10 | 头像上传 / 更换 / 移除 `api/masters/avatar` | `uploadAvatar/saveMasterAvatar` + DocumentPicker | 已验证 | 未跑 |


| 2.13 | 会长立绘（Avatar 大图） | `components/Avatar.tsx` | 已验证 | 未跑 |
| 2.14 | 好感 / 交情阶段 | `masters.intimacyLabel` + 商店赠礼推进 | 已验证 | 未跑 |
| 2.15 | 任期 / 历任记录 | `master_history`；`masters.ts` 切换写任期 | 已验证 | 未跑 |
| 2.16 | 会长卡读取 / 开场白编辑 `api/masters/card` | `masterCard/updateMasterCard` + `GreetingEditor` | 已验证 | 未跑 |
| 2.17 | 对话会长与任务会长分离 | 设置页 `saveChatMaster` | 已验证 | 未跑 |

## 3. 对话 / 聊天双管线

| # | Web 基准 | Android 实现 | 状态 | 设备验收 |
| --- | --- | --- | --- | --- |
| 3.1 | 任务模式 / 酒馆模式切换 `api/chat?mode=` | `(tabs)/index.tsx` 双管线 + `chatScreenData` | 已验证 | 未跑 |
| 3.2 | 流式回复 | `llm/conversation.ts` + `service.sendChat(onEvent)` | 已验证 | 未跑 |
| 3.3 | 工具调用（建委托/结算/记忆/购买/赠礼/争议） | `server/llm/tools.ts` 9 个工具 | 已验证 | 未跑 |
| 3.4 | 多会话 `api/chat/sessions` | `chatSessions.ts` + 会话菜单 | 已验证 | 未跑 |
| 3.5 | 开场白切换 / 编辑 | `cycleGreeting` + `GreetingEditor` | 已验证 | 未跑 |
| 3.6 | 会话改名 / 删除 | `sessionAction("rename"/"delete")` | 已验证 | 未跑 |
| 3.7 | 会话背景上传 / 清除 | `uploadBackground` + `setBackground` | 已验证 | 未跑 |
| 3.8 | 历史分页 / 加载更早 | `queryRecords before` + `hasEarlier` | 已验证 | 部分通过：记录页「加载更早」+250 条种子；逐页翻完未跑 |
| 3.9 | 长列表分页渲染 | `RENDER_PAGE=60` + 展开更早 | 已验证 | 部分通过：长列表分页渲染；200+ 条逐页未跑 |
| 3.10 | 消息删除 `api/chat/messages` | `deleteChatMessage`（连配图文件） | 已验证 | 未跑 |
| 3.11 | 在途请求恢复 | `inflight.ts` + `pending` + 2.5s 轮询 | 已验证 | 未跑 |
| 3.12 | 发送失败 / 停止生成 | AbortSignal + 错误条 | 已验证 | 未跑 |
| 3.13 | API 情景配图生成 / 停止 / 状态恢复 | `image/jobs.ts` + `startScene/cancelScene/sceneStatus` | 已验证 | 未跑 |
| 3.14 | 配图灯箱 | `ImageLightbox.tsx` | 已验证 | 未跑 |
| 3.15 | Markdown 渲染 | `components/Markdown.tsx` | 已验证 | 通过：粗体/斜体/行内代码渲染，标记被去掉 |
| 3.16 | 日期分隔 / 时间戳 | `index.tsx` dayLabel/dayKey | 已验证 | 未跑 |
| 3.17 | 结算卡嵌入时间线 | `SettlementCard.tsx` + `mergeItems` | 已验证 | 未跑 |
| 3.18 | 升级 / 晋段仪式 | `CeremonyOverlay.tsx` + `rankPromotion` 事件 | 已验证 | 未跑 |

| 3.20 | 结算复核 / 争议 | `reviewPipeline` + `file_dispute` + 委托页争议入口 | 已验证 | 通过：dispute 落库 + 复核维持原判 |
| 3.21 | 回到底部 / 新消息提示 | `jumpToLatest` | 已验证 | 未跑 |
| 3.22 | 发言后隐藏“换开场白” | `userSpoke` 状态 | 已验证 | 未跑 |

## 4. 委托

| # | Web 基准 | Android 实现 | 状态 | 设备验收 |
| --- | --- | --- | --- | --- |
| 4.1 | 告示板分组（待接受/进行中/已逾期/已完成） | `(tabs)/quests.tsx` | 已验证 | 未跑 |
| 4.2 | 只看当月完成 + 历史归档 | `questBoard` 月度窗口 | 已验证 | 未跑 |
| 4.3 | 对话中接受 / 拒绝委托 | `respond_to_quest` 工具 | 已验证 | 通过：一次性委托接受成功，状态 proposed→active |
| 4.4 | 委托详情（属性/难度/连击/进度） | 卡片展开 | 已验证 | 未跑 |
| 4.5 | 完成结算 / 结算卡 | `settle_completion` + `engine/settlement` | 已验证 | 通过：日常/一次性结算均落结算卡与 settlement_log |
| 4.6 | 逾期扫描 / 连击衰减 / 休整卷轴 | `cron/jobs.ts runOverdueSweep` | 已验证 | 未跑 |
| 4.7 | 对结算有异议 | 委托卡片按钮 → 聊天争议 | 已验证 | 通过：委托卡异议 → dispute/rejected + 复核日志 |
| 4.8 | 重挂委托（同属性同难度） | `repeatQuest` + 确认框 | 已验证 | 未跑 |
| 4.9 | 档案室搜索 / 分页 / 按月分组 | `app/archive.tsx` + `questArchive` | 已验证 | 部分通过：按月分组/单条显示；搜索与 200+ 分页未跑 |
| 4.10 | 档案室一键重挂 | `archive.tsx` 确认框 + `repeatQuest` | 已验证 | 通过：档案室「再来一次」重挂为 active |
| 4.11 | 日常 / 每周 / 一次性 / 主线 / 里程碑 | `TYPE_LABEL` + 引擎类型 | 已验证 | 未跑 |

## 5. 角色面板

| # | Web 基准 | Android 实现 | 状态 | 设备验收 |
| --- | --- | --- | --- | --- |
| 5.1 | 等级 / 评级 / 经验条 | `(tabs)/character.tsx` | 已验证 | 通过：面板显示 Lv.20 / C 评级 / 经验条 |
| 5.2 | 金币 | 同上 | 已验证 | 通过：金币 1850→1550 实时更新 |
| 5.3 | 六维雷达 | `RadarChart.tsx`（SVG） | 已验证 | 未跑 |
| 5.4 | 称号 | 称号页签 + 授予 | 已验证 | 未跑 |
| 5.5 | 图鉴 | 已解锁条目 | 已验证 | 未跑 |
| 5.6 | 周常 Boss（进度/奖励/自动入袋） | `weeklyBoss.ts` + 面板 | 已验证 | 未跑 |
| 5.7 | 技能入口 / 已点亮统计 | 面板 → `/skills` | 已验证 | 通过：面板显示 0/4，技能页显示 1/4 |
| 5.8 | 月账单筛选 | 7 类筛选 + 分页 30 | 已验证 | 未跑 |
| 5.9 | 月账单 CSV / Markdown 导出 | `export.ts` + `expo-sharing` 分享文件 | 平台限制：浏览器下载 → Android 系统分享/文件；内容格式一致 |
| 5.10 | 本月 XP / 金币 / 笔数汇总 | `monthSummary` | 已验证 | 未跑 |
| 5.11 | 结算卡样式 | `SettlementCard.tsx` | 已验证 | 未跑 |

## 6. 商店

| # | Web 基准 | Android 实现 | 状态 | 设备验收 |
| --- | --- | --- | --- | --- |
| 6.1 | 商品分类 / 持有数量 / 货架解锁 | `(tabs)/shop.tsx` + `shop.ts` | 已验证 | 通过：商品分类/持有数量/等级解锁均显示 |
| 6.2 | 购买 / 扣金币 / 入库存 | `shopBuy` + `purchaseItem` | 已验证 | 通过：休整卷轴 -100、热茶 -50，库存 ×1 |
| 6.3 | 休整卷轴自动抵消断签 | `REST_SCROLL_KEY` + 逾期巡检 | 已验证 | 未跑 |
| 6.4 | 礼物 / 亲密度推进 | `shopGift` + `giftItem` | 已验证 | 部分通过：热茶送出后库存 1→0；亲密度阶段未推进 |
| 6.5 | 每日折扣（旅商过境） | `dailyEvent.shopDiscountFor` | 已验证 | 未跑 |
| 6.6 | 余额不足 / 已售罄 / 未解锁提示 | 按钮禁用 + Toast | 已验证 | 未跑 |

## 7. 技能树

| # | Web 基准 | Android 实现 | 状态 | 设备验收 |
| --- | --- | --- | --- | --- |
| 7.1 | 技能树分层 / 前置 / 价格 | `app/skills.tsx` + `skills.ts` | 已验证 | 通过：技能树 4 项、价格/等级条件正确 |
| 7.2 | 解锁扣金币 / 落库 | `unlockSkill` | 已验证 | 通过：晨型人 -300 金币，已点亮 1/4 |
| 7.3 | 技能在结算/签到时生效 | `engine/*` 读取已解锁技能 | 已验证 | 未跑 |

## 8. 世界书

| # | Web 基准 | Android 实现 | 状态 | 设备验收 |
| --- | --- | --- | --- | --- |
| 8.1 | 世界书列表 / 新建 / 改名 / 删除 | `app/worldbook.tsx` + `worldbook.ts` | 已验证 | 通过 |
| 8.2 | 条目增删改 | `upsertBookEntry/deleteBookEntry` | 已验证 | 通过 |
| 8.3 | 常驻 / 关键词 / 次级关键词 / selective | 表单项 + `activateWorldBook` | 已验证 | 通过 |
| 8.4 | 插入顺序 / before/after/depth / role | 表单项 + 引擎 | 已验证 | 通过 |
| 8.5 | 概率触发 | `extensions.probability` | 已验证 | 通过 |
| 8.6 | token 预算 / 截断 / 递归扫描 | `estimateTokens` + `MAX_RECURSION_STEPS` | 已验证 | 通过（引擎单测） |
| 8.7 | 分配给会长 / 取消分配 | `assignBook/unassignBook` | 已验证 | 通过 |
| 8.8 | 整本复制给另一位会长 | `cloneBooks` 服务动作 | 已验证 | 通过 |
| 8.9 | 导入世界书 JSON | `worldBookAction append/import` | 已验证 | 通过 |
| 8.10 | 角色卡内嵌世界书 | `convertCharacterBook` | 已验证 | 通过：cardImport 单测解析 + worldbook 单测覆盖 character_book/lorebook_v3 |

## 9. 记忆书

| # | Web 基准 | Android 实现 | 状态 | 设备验收 |
| --- | --- | --- | --- | --- |
| 9.1 | 永久记忆 / 会话记忆切换 | `app/memory.tsx` + `memoryData` | 已验证 | 通过 |
| 9.2 | 自动提取记忆 | `llm/tools add_memory` + 会话结束提取 | 已验证 | 通过 |
| 9.3 | 启用 / 停用 | `memoryAction toggle` | 已验证 | 通过 |
| 9.4 | 编辑 / 手动新增 | `memoryAction edit/add` | 已验证 | 通过 |
| 9.5 | 单条删除 / 批量删除 | `memoryAction delete` + 多选 | 已验证 | 通过 |
| 9.6 | 删除会话连带删除会话记忆 | `chatSessions.delete` 级联 | 已验证 | 通过 |
| 9.7 | 记忆注入对话提示词 | `llm/prompts.ts` + `memory.ts` | 已验证 | 通过（提示词单测） |

## 10. 记录归档

| # | Web 基准 | Android 实现 | 状态 | 设备验收 |
| --- | --- | --- | --- | --- |
| 10.1 | 搜索（委托名 / 台词） | `app/records.tsx` + `records()` | 已验证 | 未跑 |
| 10.2 | 类型筛选（全部/对话/结算） | 三页签 | 已验证 | 未跑 |
| 10.3 | 日期筛选（YYYY-MM-DD） | 日期输入 → `before` | 已验证 | 未跑 |
| 10.4 | 分页加载 / 按月分组 | PAGE + 月份标题 | 已验证 | 部分通过：250 条种子 + 按月分组 + 加载更早 |
| 10.5 | 结算卡展示 | `SettlementCard` | 已验证 | 未跑 |
| 10.6 | 空态 / 清除搜索 | 空态文案 + 清除 | 已验证 | 未跑 |

## 11. 冒险者卡 / R18 / 每日事件

| # | Web 基准 | Android 实现 | 状态 | 设备验收 |
| --- | --- | --- | --- | --- |
| 11.1 | 冒险者卡（称呼 / 一句话 / 描述） | `(tabs)/settings.tsx` + `userPersona*` | 已验证 | 未跑 |
| 11.2 | R18 开关（设置页常驻，无暗门） | `saveRp` + `app_settings` | 已验证 | 未跑 |
| 11.3 | R18 提示词注入 | `buildChatPrompt(adultContent)` + `R18_GUIDELINES` / `R18_POST_RULES` | 已验证 | 单测覆盖 |
| 11.4 | 每日事件（文本 / 金币加成 / 首次 XP） | `dailyEvent.ts` + 结算/商店 | 已验证 | 未跑 |

## 12. 签到 / 连击 / 周常 / 跨天

| # | Web 基准 | Android 实现 | 状态 | 设备验收 |
| --- | --- | --- | --- | --- |
| 12.1 | 每日签到 | `engine/checkin.ts` + 工具 | 已验证 | 未跑 |
| 12.2 | 连击 / 断签衰减 | `engine/streak.ts` | 已验证 | 未跑 |
| 12.3 | 周常自然重置 | `weeklyBoss.weekKey` 计算 | 已验证 | 未跑 |
| 12.4 | 启动补算（逐日逾期巡检） | `bootstrap.runCatchUp()` | 已验证 | 通过：日期推到 10-26 后 active→overdue，休整卷轴 1→0，last_sweep=10-26 |
| 12.5 | 回前台补算 | `watchForeground` + AppState | 已验证 | 未跑 |
| 12.6 | 本地通知（断签 / 每日 21:00 / 周常） | `expo-notifications` 调度 | 平台限制：无 Web 常驻 cron；改用启动/回前台补算 + 系统本地通知，精确后台执行受 Android Doze/厂商策略影响 |
| 12.7 | 通知权限申请 | `ensureNotificationPermission` | 已验证 | 未跑 |
| 12.8 | 通知不可用降级 | try/catch，不阻断玩法 | 已验证 | 未跑 |

## 13. 模型渠道 / 生图

| # | Web 基准 | Android 实现 | 状态 | 设备验收 |
| --- | --- | --- | --- | --- |
| 13.1 | DeepSeek 官方渠道 | `modelConfig.ts` + `llm/client.ts` | 已验证 | 未跑 |
| 13.2 | OpenCode Go 渠道 | 同上 | 已验证 | 未跑 |
| 13.3 | 自定义 OpenAI 兼容渠道 | 同上（baseUrl/model） | 已验证 | 未跑 |
| 13.4 | 渠道切换 / 默认模型 | `settings/model` + `saveLlm` | 已验证 | 未跑 |
| 13.5 | 复核判定模型 | 独立 reviewModel 配置 | 已验证 | 未跑 |
| 13.6 | API Key 进 SecureStore | `server/secure.ts`（Keystore/Keychain） | 已验证 | 未跑 |
| 13.7 | 测试连接（流式/非流式） | `testLlm` + 设置页 | 已验证 | 未跑 |
| 13.8 | 生图开关 / 地址 / 模型 / Key / 尺寸 / 画风 | `settings/image` + `image/config.ts` | 已验证 | 未跑 |
| 13.9 | 测试生图 / 停止 | `testImage` + AbortSignal | 已验证 | 未跑 |
| 13.10 | `images/generations` 响应（b64_json / url） | `image/api.ts` | 已验证 | 未跑 |
| 13.11 | 情景配图风格前缀 | `buildScenePrompt` | 已验证 | 未跑 |

## 14. Web API 路由 → Android 服务层映射

| Web 路由 | Android 等价 | 状态 |
| --- | --- | --- |
| `/api/onboarding/state`、`/complete` | `service.onboardingState/completeOnboarding` | 已验证 |
| `/api/masters` GET | `service.mastersData` | 已验证 |
| `/api/masters/activate` | `service.activateMaster` | 已验证 |
| `/api/masters/create` | `service.createMasterByFields` | 已验证 |
| `/api/masters/forge` | `service.forgeMaster` | 已验证 |
| `/api/masters/invite` | `masters.createCustomMaster`（forge 复用） | 平台限制：旧接口无独立 UI，功能由 forge 覆盖 |
| `/api/masters/import`、`/import/translate` | `previewImportedCard/commitImportedCard` + `translateJobs` | 已验证 |
| `/api/masters/avatar` | `uploadAvatar/saveMasterAvatar` | 已验证 |
| `/api/masters/card` GET/PATCH | `masterCard/updateMasterCard` | 已验证 |
| `/api/masters/delete` | `deleteMaster` | 已验证 |
| `/api/chat` GET/POST | `chatScreenData/sendChat` | 已验证 |
| `/api/chat/sessions` | `sessionAction/cycleGreeting` | 已验证 |
| `/api/chat/messages` DELETE | `deleteChatMessage` | 已验证 |
| `/api/chat/image` | `startScene/cancelScene/sceneStatus` | 已验证 |
| `/api/assets/upload` | `uploadAvatar/uploadBackground` | 已验证 |
| `/api/assets/[kind]/[file]` | `assetUrl()` → 本地 file URI | 平台限制：无 HTTP 静态资源路由，直接读应用私有目录 |
| `/api/character` | `characterPanel` | 已验证 |
| `/api/character/settlements` | `bill/exportBills` | 已验证 |
| `/api/quests` GET/POST | `questBoard/questArchive/repeatQuest` | 已验证 |
| `/api/records` | `records` | 已验证 |
| `/api/shop` GET/POST | `shopData/shopBuy/shopGift` | 已验证 |
| `/api/skills` | `skillsData/unlockSkill` | 已验证 |
| `/api/worldbook` | `worldBooks/worldBookDetail/worldBookAction` | 已验证 |
| `/api/memory` | `memoryData/memoryAction` | 已验证 |
| `/api/settings` | `settingsState/saveLlm/saveRp/saveChatMaster/saveImage` | 已验证 |
| `/api/user-persona` | `userPersonaGet/Save` | 已验证 |

## 15. server 模块映射

| Web 模块 | Android 模块 | 状态 |
| --- | --- | --- |
| `server/db/*`（DDL/migrate/seed/schema） | `server/db/*`（expo-sqlite + drizzle） | 已验证 |
| `server/llm/*`（client/conversation/prompts/tools/pending/reviewer/keys） | `server/llm/*` | 已验证 |
| `server/engine/*`（checkin/leveling/rarity/review/settlement/streak/config） | `server/engine/*` | 已验证 |
| `server/cron/scheduler.ts`（Node 定时器） | 无进程内长驻定时器；`bootstrap.runCatchUp` + 本地通知 | 平台限制：Android 无常驻 Node；启动/回前台补算等价，后台精确时点受系统限制 |
| `server/cron/jobs.ts` | `server/cron/jobs.ts` | 已验证 |
| `server/inflight.ts` | `server/inflight.ts` | 已验证 |
| `server/assets.ts` | `server/assets.ts`（FileSystem 目录） | 已验证 |
| `server/image/*` | `server/image/*`（仅 API） | 已验证 |
| `server/export.ts` | `server/export.ts` + `expo-sharing` | 已验证 |
| `server/translate.ts`、`translateJobs.ts` | 同名模块（本地任务表） | 已验证 |
| `server/weeklyBoss.ts`、`dailyEvent.ts`、`rankPromotion.ts`、`reviewPipeline.ts` | 同名模块 | 已验证 |
| `server/personaForge.ts`、`cardImport.ts`、`cards.ts` | 同名模块 | 已验证 |
| `server/rp.ts`、`userPersona.ts` | 同名模块 | 已验证 |
| `server/bootstrap.ts` | `server/bootstrap.ts` + `lib/bootstrap.ts` | 已验证 |

## 16. 明确排除（Goal 范围外，原生等价物）

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 本地生图（mflux / LoRA / 量化 / HF 镜像） | 平台限制 | Goal 排除；仅保留 OpenAI 兼容 `images/generations` |
| 本地模型 / 本地推理 | 平台限制 | Goal 排除；只连 DeepSeek / OpenCode / 自定义 API |
| 云端后端 / 数据上传 / 跨设备同步 | 平台限制 | Goal 禁止；全部本机 SQLite |
| Web 数据迁移 | 平台限制 | Goal 禁止；首次启动重置 seed |
| 浏览器文件下载 | 平台限制 | 用 `expo-sharing` 系统分享替代 |
| PWA / Service Worker / 浏览器通知 | 平台限制 | 原生 App + 本地通知 |
| Expo Go / Node / Termux 运行时 | 平台限制 | 交付独立 APK，业务层随包运行 |

## 17. 设备验收清单（APK 产出后逐项打勾）

| 验收项 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | 通过（本轮） |
| `npx vitest run --reporter=dot` | 通过（本轮） |
| `npx expo export --platform android` | 通过（exit 0） |
| release APK | 通过（`app-release.apk`，113MB，v2 签名） |
| `aapt dump badging`：`com.wlhpange.ngplus` + 启动 Activity | 通过（`.MainActivity`） |
| `apksigner verify` | 通过（v2） |
| `adb install -r` 冷启动 | 通过（COLD 3.7s，无 FATAL） |
| 本地 OpenAI 兼容 stub：chat 流式/非流式、工具调用、翻译、锻造、复核、场景提炼、`images/generations` | 锻造、复核已跑；翻译未跑（设备 picker 限制） |
| 杀进程重开数据仍在 | 通过（两轮：旧数据与全新 onboarding 数据；force-stop 后重启，时间线/结算卡完整） |
| 跨天启动补算 | 通过（日期推到 10-26 冷启动，active→overdue，休整卷轴 1→0） |
| 截图 / `adb screenrecord` / `dumpsys gfxinfo` | 通过：Metal GPU 0.49% janky / 50th 20ms；`and-tabs.mp4`；SwiftShader 数据无效 |
| `main` 的 `pnpm test/build` | 通过（44 个测试文件 / 469 用例全过；`pnpm build` 成功；Web 未改动） |

## 18. 设备验收运行记录

环境：`emulator-5554`（AVD `ngtest`，1080×2400），release APK，本机 stub `http://10.0.2.2:8787/v1`（`tools/stub-server.mjs`），模型 `stub-model`。

| 时间 | 步骤 | 结果 | 证据 |
| --- | --- | --- | --- |
| 15:55 | `adb install -r` + 冷启动 | 通过；`com.wlhpange.ngplus/.MainActivity`，无 FATAL | `android-gate.png`（旧数据） |
| 16:00 | `pm clear` 后首次启动 | 通过；弹出通知权限，允许后进入推门页 | `android-fresh-gate2.png` |
| 16:00 | 推门 → 首次选会长 | 通过；门动画后进入会长选择，官方三会长；选「加洛」完成 onboarding | `android-masters-first.png`、`android-onboarded.png` |
| 16:01 | 设置 → 模型与渠道 → 自定义 API | 通过；地址 `http://10.0.2.2:8787/v1`、模型 `stub-model` 保存成功 | `ui-model8.xml` |
| 16:01 | 测试连接 | 通过；「通了。模型 stub-model 应答正常，耗时 117ms」 | stub 日志 |
| 16:02 | 任务模式发送 `help` | 通过；流式返回「坐吧，茶刚沏上。今天想聊点什么？」 | `ui-chat2.xml` |
| 16:03 | 发送 `create running quest` | 通过；`create_quest` 工具调用 → 会长回复「先挂一张草稿」 | `ui-chat3.xml` |
| 16:03 | 委托告示板 | 通过；待接受 1 件「每天跑步 20 分钟」，日常/体魄×0.8/意志×0.2/难度 1.0 | `android-quest-proposed.png` |
| 16:04 | 发送 `accept` | 通过；`respond_to_quest` → 「好，挂上了」 | `ui-chat4.xml` |
| 16:04 | 发送 `done ran 30 minutes` | 通过；`settle_completion` → 结算卡 +12 XP / +5 金币 / 体魄+10 / 意志+2（含每日首笔 +20% XP） | `android-chat-settled.png` |
| 16:04 | 角色面板 | 通过；Lv.1 / F 评级 / 金币 5 / 本周悬赏 0/3 / 六维属性 / 称号 / 图鉴 0/14 / 技能 0/4 / 月账单 +12 XP +5 金币 1 笔 | `android-panel-after-settle.png` |
| 16:05 | 月账单「导出 CSV」 | 通过；系统分享面板出现 `ngplus-settlements-2026-10-25.csv` | `android-csv-share.png` |
| 16:05 | 聊天记录 | 通过；按月/日分组，含消息与结算卡，空态文案「到这里就是协会最早的记录了」 | `android-records.png` |
| 16:06 | `force-stop` 后重启 | 通过；会长、消息、任务、结算卡、金币全部保留，无 FATAL | `android-after-restart.png` |
| 16:07 | 切到聊天（酒馆）模式 | 通过；显示会长、开场白与「换一条开场白」 | `ui-chatmode.xml` |
| 16:07 | 换一条开场白 | 通过；开场白从「你来了……」变为「门没关……」 | `ui-greeting2.xml` |
| 16:07 | 新建会话 | 通过；会话数 1 → 2，新会话有独立开场白 | `android-session2.png` |
| 16:08 | 会话改名 | 通过；「新的对话」→「night chat」，会话栏即时更新 | `ui-rename3.xml` |
| 16:08 | 上传会话背景 | 通过；DocumentPicker 选 `/sdcard/Download/bg.png`，聊天页显示模糊背景 | `android-bg-set.png` |
| 16:08 | 生图设置 | 通过；开启、接口 `http://10.0.2.2:8787/v1`、模型 `stub-image` 保存 | `ui-image2.xml` |
| 16:09 | 测试生图 | 通过；「生成成功，耗时 576ms」 | `android-image-test.png` |
| 16:09 | 聊天消息「给这一幕配图」 | 通过；场景提炼 + `images/generations`，消息下出现配图 | `android-scene.png` |
| 16:09 | 配图灯箱 | 通过；全屏预览 + 关闭按钮 | `android-lightbox.png` |
| 16:10 | 删除消息 | 通过；确认框提示配图一并删除，删除后消息与配图消失 | `ui-delmsg2.xml` |
| 16:10 | 删除会话 | 通过；确认框提示聊天记录与会话记忆一并删除，会话数 2 → 1 | `ui-delsess2.xml` |
| 17:05 | 设置 → 世界书 | 通过；空态显示「这本还是空的」，新建「Lore Test」成功 | 截图、DB `world_books` |
| 17:08 | 世界书「挂给会长」 | 通过；勾选「加洛」后头部显示「加洛」，取消后回「未挂载」，再挂回 | DB `master_world_books` |
| 17:10 | 新增条目 | 通过；关键词 `clocktower,lore`、常驻、按深度、深度 4、顺序 100、概率 0.8；统计「共 1 条 · 常驻约 33 tokens」 | DB `world_book_entries`（keys/secondary/constant/selective/position/depth/role/extensions） |
| 17:10 | 复制世界书 | 通过；来源「加洛」→ 目标「薇拉」生成「Lore Test（副本）」1 条，原书不动 | 页面 chip、DB |
| 17:14 | 编辑条目 + 需两把钥匙 | 通过；改次级关键词 `second` 后保存，编辑表单回填一致 | DB `selective=1, secondary_keys=["second"]` |
| 17:15 | 删除条目 | 通过；确认后回到空态「这本还是空的」 | 截图、DB 条目数 0 |
| 17:18 | 追加导入世界书 JSON | 通过；粘贴 `{"entries":[...]}` 追加成功，常驻条目入册，统计 15 tokens | 截图、DB `extensions.cc_index=0` |
| 17:20 | 改名 / 删除整本 | 通过；「Lore Test」→「LoreRenamed」；删除副本后仅余一本 | 页面 chip、DB |
| 17:26 | 世界书引擎单测 | 通过；新增 `tests/server/worldbook.test.ts` 13 条，覆盖关键词/selective/位置分组/token 预算/递归/概率/装饰器/角色卡 `character_book` 与 `lorebook_v3` 导入 | `npx vitest run tests/server/worldbook.test.ts` |
| 17:30 | `force-stop` 后重开 → 世界书 | 通过；「LoreRenamed」1 条、挂载「加洛」、条目正文与 15 tokens 统计均保留 | `/tmp/wb-restart.png`、DB |
| 17:35 | 记忆书 · 手动新增永久记忆 | 通过；空态文案「加洛 的永久记忆还是空的」；偏好类「Prefers night walks and warm tea」入册，1 条 | 截图、DB `memory(session_id=NULL)` |
| 17:38 | 记忆书 · 编辑 / 停用 / 启用 | 通过；改为「Edited memory: likes rain」；停用后显示「已停用」、按钮变「启用」，再启用 | DB `content`、`enabled` |
| 17:41 | 酒馆模式发送 `hello there` | 通过；回复「收到。今天也慢慢来，我在。」；后台自动抽取会话记忆「冒险者完成了第一次委托」，永久记忆不受影响 | DB `memory(session_id=1402cb0e)` |
| 17:45 | 任务模式发送 `remember I prefer green tea` | 通过；`add_memory` 工具调用 →「嗯，我记下了。」，永久记忆 2 条 | DB `memory(profile, 冒险者喜欢在夜里散步)` |
| 17:50 | 会话记忆 · 手动新增 / 单删 / 批量删 | 通过；新增 A、B 后 3 条；删 B 余 2 条；全选「删除选中 2 条」确认后 0 条 | 截图、DB |
| 17:54 | 新增会话 → 删除含记忆旧会话 | 通过；会话 2 段；确认框「聊天记录和它的对话记忆会一起消失」；删除后 DB 中该会话与两条会话记忆一并消失，永久记忆保留 | 截图、DB `chat_sessions` / `memory` |
| 18:06 | 记忆注入提示词单测 | 通过；新增 `tests/server/memory.test.ts` 5 条，覆盖空记忆、类别聚合、优先级排序、未知类别与六类常量 | `npx vitest run tests/server/memory.test.ts` |
| 19:00 | 商店购买 休整卷轴 / 热茶 | 通过；金币 2000→1900→1850，持有 ×1；热茶送出后 ×0 | 截图、DB `items` |
| 19:05 | 技能树解锁 晨型人 | 通过；金币 1850→1550，已点亮 1/4 | 截图、DB `user_skills` |
| 19:10 | 一次性委托 创建/接受/结算 | 通过；stub 工具链创建「整理一次旧书箱」，接受后结算，quests.status=completed，settlement_log 落账 | 截图、DB `quests` / `settlement_log` |
| 19:12 | 档案室 | 通过；按月分组显示「整理一次旧书箱」，「再来一次」重挂为 active | `and-archive.png`、DB `quests` |
| 19:12 | 成就 | 通过；双位数 / 评级·D / 心意 解锁并进入时间线 | 截图、DB `settlement_log` |
| 19:20 | 复核/争议 | 通过；`file_dispute` → disputes(rejected) + 复核日志「维持原判」 | 截图、DB |
| 19:22 | Markdown | 通过；聊天气泡渲染粗体/斜体/行内代码，标记被去掉 | 截图 |
| 19:24 | 记录分页 | 通过；250 条种子 + 「加载更早」 | 截图、DB |
| 19:30 | 角色卡解析单测 | 通过；V2 + character_book entries=1 | `npx vitest run tests/server/cardImport.test.ts` |
| 19:31 | 跨天补算 | 通过；日期→10-26，daily active→overdue，rest_scroll 1→0，last_sweep=10-26 | DB |
| 19:33 | 性能 | 通过；Metal GPU 0.49% janky，50th 20ms；screenrecord | `and-tabs.mp4` |
| 19:34 | AI 锻造 | 通过；Aster/阿岚创建并上任 | 截图、DB |

本轮**未跑**：导入/翻译的系统文件选择器设备点选（模拟器自动化限制）、在途请求恢复、200+ 条逐页翻页、回前台补算。

## 19. 提示词逐字核对（2026-10-25）

对照 `main` 的 `src/server`，逐文件比对中文字符串字面量 + 文件哈希：

| 文件 | 结果 |
| --- | --- |
| `llm/prompts.ts`（五层提示词 + `R18_GUIDELINES` + `R18_POST_RULES`） | SHA-256 完全一致 |
| `rp.ts`（R18 开关与提示词策略） | SHA-256 完全一致 |
| `llm/tools.ts` | 仅 `randomUUID` 导入差异 |
| `personaForge.ts` / `translate.ts` / `image/scene.ts` / `memory.ts` / `reviewPipeline.ts` | 中文字符串 0 差异 |
| `llm/reviewer.ts` | 结算/记忆复核提示词一致；记忆抽取六类说明已恢复 Web 原文；仅新增 JSON 输出格式（客户端无 zod） |
| `llm/conversation.ts` | 提示词构建调用一致（`buildChatPrompt` + `adultContent: getRpSettings(db).enabled`）；差异仅为客户端/日志/错误文案 |

APK 内已验证：`assets/index.android.bundle` 可直接搜到
`Sexual content, smut, pornographic, and erotic content are encouraged.` 等 R18 原文。

`main` 回归已补：44 个测试文件 / 469 用例全过，`pnpm build` 成功（Web 未改动）。
