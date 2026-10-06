# 首次使用引导弹窗 · 实施方案

> 状态：**方案定稿，未实施**
> 日期：2026-10-06
> 决策：已与用户确认（见 §2）

## 1. 为什么做

现在第一次打开是「空首页 + 自己摸到设置页」。而设置页有 7 个区块、**全部默认收起**
（`Settings.tsx` 2026-09-30 改版：统一 `CollapsibleCard`），新用户看不出该先填哪个。

引导的价值不是「帮他填表单」，而是**告诉他顺序**：先配 Key 才有数据，先有目标才能排计划。

**本方案不新增任何写入逻辑。** 三条写入路径全部已存在，引导只是给它们套一个按顺序走的壳。

## 2. 已拍板的三个决策

| # | 问题 | 决定 |
|---|---|---|
| 1 | AI 配置（DeepSeek Key）是否进引导 | **不进**，保持 3 步 |
| 2 | 点 X / ESC / 点遮罩关闭，算不算「已引导」 | **算**，之后不再弹 |
| 3 | 现有库（已有 3 条 goal）升级后 | **自动豁免不弹** |

## 3. 触发判定

### 3.1 完成位

存 `app_config['onboarding_done']`（布尔）。

**为什么不用数据推断**：

- ❌ 靠「个人信息填没填」—— `BodyPatch` 全部字段可选。填了性别、跳过体重，下次打开又被判成没引导过。
- ❌ 靠「有没有配 Key」—— 新用户只要先摸到设置页配了 Key，就永远看不到引导。
- ✅ 显式布尔位。

`SettingsRepo.getJson/setJson` 已是通用 KV（`server/repo/settingsRepo.ts`，`ON CONFLICT(key) DO UPDATE`），
**不用改 repo，直接用**。

### 3.2 老用户豁免（关键）

**光有显式位不够**：现有库里没有这个键，若只判 `=== true` 才不弹，升级当天用户会被弹一次。

⇒ 在 `runStartupTasks` 里补一道迁移：

```
onboarding_done 键不存在 且 库里已有生效 goal  →  补种 done = true
```

判据用现成先例（`server/plan/resetService.ts:150` 一模一样）：

```sql
SELECT COUNT(*) AS n FROM user_goal WHERE is_active = 1
```

**为什么 goal 是可靠的「老用户」标志**：

- `user_goal` 是历史表（写入 = INSERT 新行 + 旧行 `is_active=0`），但**永远至少有一条 `is_active=1`**；
- 清空功能明确**不删** `user_goal`（见 `resetService.ts`）⇒ 即使用户清空过计划，判据依然成立；
- 不选「有没有配 Key」是因为 Key 在 `.env` 里、不在库中，迁移时读取链路更绕。

### 3.3 判定流程

```
服务端启动
   └─ 读 app_config['onboarding_done']
        ├─ = true               → 不弹
        ├─ 无标记 且 有 goal 行  → 补种 true，不弹     ← 老用户豁免
        └─ 无标记 且 无 goal 行  → 弹三步引导
```

## 4. 三步的内容与接口映射

字段沿用既有表单，**一个都不新增**。

| 步 | 标题 | 写入接口 | 前端 hook | 可跳过？ |
|---|---|---|---|---|
| 1 | 训记接入 | `PUT /api/xunji/config` `{ api_key }` | `useSaveXunjiConfig` | 可以（但没 Key 什么都拉不到） |
| 2 | 训练基础 | `PUT /api/goal` | `useSaveGoal` | **不能整步跳**，见下 |
| 3 | 个人基础信息 | `PUT /api/body` | `useSaveBody` | 可以，全部可空 |

### Step 2 的硬约束

- `GoalForm` 里 `savedGoalTypeEmpty` 会对空目标**直接禁用保存**，后端也拒绝；
- 训练日至少留一天（`sessions_per_week` 由训练日数量推导，后端 CHECK 1~7）。

⇒ 这一步必须选一个长期目标 + 至少一个训练日，因此**不提供「整步跳过」**，只提供「上一步」。

### Step 1 保存后的既有行为（要写进文案）

`server/index.ts:97` 的 `onXunjiApplied`：

1. 重建 `XunjiHttpClient` + `SyncEngine` + `writeDeps.deps`（热更新，**不用重启**）；
2. 若 `!hasCompletedFullSync(db)` → 自动入队 `sync_full`（**首次全量，实测 182 天约 9 秒**）。

⇒ 保存 Key 后要显示「正在导入历史数据…」的进行态，约 9 秒。
这 9 秒是**已有的坑**（用户在设置页保存 Key 时同样会遇到），引导里必须给反馈，否则看起来像卡死。

## 5. 后端改动

**新增** `server/api/routes/onboarding.ts`（约 45 行）：

```
GET /api/onboarding        →  { done: boolean }
PUT /api/onboarding        →  body { done: true } → 写 app_config → { done: true }
```

- 用 `new SettingsRepo(db)` 的 `getJson/setJson`，key = `'onboarding_done'`；
- 非法 body 返回 400（照 `goal.ts` 的 `readBody` + `JSON.parse` try/catch 写法）；
- 只允许写 `true`，防止误传 `false` 把已完成状态回退。

**修改** `server/app.ts`：

- import 区（第 16-28 行）加一行 `handleOnboardingRoutes`；
- `routes: RouteHandler[]` 数组（第 52 行）加 `handleOnboardingRoutes(db)`。
  现有 13 个 handler 全是同一个工厂模式，照抄即可。

**修改** `server/jobs/startup.ts`：

- 在 `recoverStuckWrites(db)`（第 102 行）之后插入老用户豁免迁移；
- `StartupReport` 增加字段（如 `onboardingSeeded: boolean`），便于启动日志观察。

**不改动**：`/api/xunji/config`、`/api/goal`、`/api/body` 三个既有 PUT 的语义与校验。

## 6. 前端改动

| 文件 | 动作 |
|---|---|
| `src/components/common/Modal.tsx` | **新建**。项目目前没有 modal，这是第一个 |
| `src/components/onboarding/OnboardingDialog.tsx` | **新建**。三步向导，复用既有 hooks |
| `src/App.tsx` | 第 78 行 `<AppShell>` 内挂载 `<OnboardingDialog />` |
| `src/api/client.ts` | 加 `useOnboarding()` / `useCompleteOnboarding()` |
| `src/pages/Settings.tsx` | 底部（`DangerZone` 之前）加「重新运行首次引导」入口 |

**Modal 组件要求**：遮罩 + ESC 关闭 + 点遮罩关闭 + 焦点陷阱。
`src/components/common/ui.tsx` 现有导出仅 `StatCard / EmptyState / Badge / SeverityBadge /
SectionCard / CollapsibleCard / PaneHead`，**无 modal**。

**完成位写入时机**：任何退出路径（完成 / 跳过 / X / ESC / 点遮罩）都写 `done = true`。
设置页留「重新运行首次引导」入口兜底。

## 7. 验收标准

1. 新建空库启动 → 首次打开页面弹窗；
2. 走完三步 → `app_config['onboarding_done'] = true`，刷新不再弹；
3. 中途点 X 关闭 → 同样写 `true`，刷新不再弹；
4. **现有库（有 goal）启动 → 不弹**（老用户豁免生效）；
5. 设置页「重新运行首次引导」→ 弹窗再次出现；
6. 弹窗内填写的结果，与直接在设置页填写的结果**完全一致**（同一条写入路径）；
7. `npm test` 全绿（基线 482 条），typecheck 0 错，`npm run build:web` 通过。

## 8. 风险

| 风险 | 说明 | 对策 |
|---|---|---|
| 🔴 **出现第二套写路径** | `Settings.tsx:9-11` 的注释已记过一笔：「两个地方能改同一个东西，正是『说不清哪个才算数』的来源」 | 弹窗**必须**调用既有的 `useSaveGoal/useSaveBody/useSaveXunjiConfig`，绝不自己写 fetch |
| Step 1 保存后 9 秒无反馈 | 首次全量导入期间界面无变化 | 进行态 + 文案「正在导入历史数据…」 |
| 误把引导做成常驻面板 | 用户对视图形开关敏感（「忘了关过就变成刷新一下功能坏了」） | 引导是「办完事就走」，**不做可持久化的常驻形态** |
| 完成位写太早 | 若每步 PUT 成功就写 `done`，第 2 步后关页面则第 3 步再也不弹 | 只在整体退出时写 |
| 危险操作混入引导 | 清空数据的 `DangerZone` 属破坏性操作 | **不放进**首次引导 |

## 9. 明确不做

- 不做 AI 配置步骤（决策 1）；
- 不做「跳过引导」的独立按钮（跳过 = 关闭）；
- 不做引导进度持久化（下次打开不续上次的步数，重新从第 1 步开始 —— 但只会在「重新运行引导」时发生）；
- 不改任何既有写入接口的语义与校验规则。
