# 训记 Open API 探针报告

> 本报告由 `scripts/probe_xunji.mjs` 自动生成，是「能不能拿到训练数据」这件事的一手证据。
> 所有输出均经过脱敏处理，**不会出现 API Key 明文**。

| 项 | 值 |
| --- | --- |
| 开始时间 | 2025-03-26 13:29:29 |
| 结束时间 | 2025-03-26 13:31:49 |
| 运行环境 | Node v22.22.2 / win32/x64 |
| 执行命令 | `node scripts/probe_xunji.mjs --date 2025-03-26 --days 90 --full --delay-ms 1500 --dump-raw` |
| API 基址 | `https://trains.xunjiapp.cn/api_trains_for_llm_v2` |
| Key | 已掩码（不保留任何真实片段） |
| 拉取窗口 | 2024-12-27 ~ 2025-03-26（90 天） |
| 实际请求次数 | 91 次（同一日期+模式的结果会被跨阶段复用，避免重复触发冷却） |
| 探针结果 | 全部阶段通过 |

> ⚠️ **脱敏说明**：本报告中**所有逐日训练数据**（日期、训练条数、动作数、组数）、**样本片段**、以及**报告的生成时间与拉取窗口**，均为**示例数据** —— 字段结构与字段语义真实，数值已整体替换。这样做是为了保留这份实测报告的参考价值，同时不暴露任何真实训练记录。

## 0. 结论速览

| 问题 | 结论 | 状态 |
| --- | --- | --- |
| Q1 连通性与权限 | 通过：Key 有效且账号有权限（HTTP 200） | 已确认 |
| ★ 关键字段填充率 | 912 个组 / 214 个动作 / 31 条训练；RPE 填充 0% | 已确认 |
| Q2 字段结构 | 样本日 2025-03-11：轻量 26 条 / 完整 35 条；full 独有 9 条 | 已确认 |
| Q3 限频行为 | 同日二次请求返回 TOO_FREQUENT；跨日期 互不阻塞 | 已确认 |
| Q4 动作名覆盖 | 90 天 / 31 条训练 / 去重动作名 48 个 | 已确认 |

> §1 填充率决定哪些分析能落地；§3 的字段清单是后续建表与写解析器的一手依据；§5 的动作名清单是肌群映射冷启动的输入。

### 服务端自报的约束（`res.limits`，架构文档里没有的新事实）

```json
{
  "maxTrainsPerDay": 4,
  "maxMovesPerTrain": 40,
  "maxSetsPerMove": 60,
  "maxWriteMovesPerTrain": 15,
  "maxWriteSetsPerMove": 20,
  "maxPayloadBytes": 131072,
  "maxResponseBytes": 196608,
  "readRateLimitSeconds": 30,
  "readRateLimitSecondsLight": 15,
  "readRateLimitSecondsFull": 30,
  "writeRateLimitSeconds": 45
}
```

> 探针已按服务端自报值取最严者执行冷却（res.limits（候选 30 / 30 / 15 秒，取最严 30 秒））。
> 注：架构 §6.2.2 / §12.1 目前写的是"同一训练日 90 秒"，与服务端自报值不一致，需架构师确认后修订。

## 1. 关键字段填充率（决定哪些分析能落地）

| 指标 | 值 |
| --- | --- |
| 统计样本 | 31 条训练 / 214 个动作 / 912 个组 |
| 统计口径 | 非空占比（分母 = 该层级样本总数；"字段出现"数 < 样本数说明该字段只在部分对象里返回） |

| 字段 | 层级样本 | 字段出现 | 非空/命中 | 填充率 | 备注 |
| --- | --- | --- | --- | --- | --- |
| train.title 训练标题 | 31 | 31 | 4 | 13% |  |
| train.note 训练备注 | 31 | 31 | 28 | 90% |  |
| train.localid 本地 ID | 31 | 31 | 31 | 100% |  |
| train.start 开始时间 | 31 | 31 | 31 | 100% |  |
| train.end 结束时间 | 31 | 31 | 31 | 100% |  |
| movements[].note 动作备注 | 214 | 214 | 9 | 4% |  |
| movements[].restTime 组间歇 | 214 | 208 | 208 | 97% |  |
| movements[].type 动作类型 | 214 | 214 | 100 | 47% |  |
| movements[].exetype 动作子类 | 214 | 214 | 12 | 6% |  |
| movements[].singleSide 单侧动作 | 214 | 48 | 48 | 22% |  |
| sets[].rpe 主观强度 | 912 | 912 | 0 | 0% |  |
| sets[].note 组备注 | 912 | 912 | 0 | 0% |  |
| sets[].comment 组评论 | 912 | 912 | 0 | 0% |  |
| sets[].setType 组类型（热身等） | 912 | 912 | 57 | 6% |  |
| sets[].done === false 未打勾组 | 912 | 912 | 4 | 0% | 命中即"未完成组" |
| sets[].time > 0 实练秒数 | 912 | 912 | 638 | 70% |  |
| sets[].leftWeight 左侧重量 | 912 | 191 | 191 | 21% |  |
| sets[].weight 重量 | 912 | 912 | 902 | 99% |  |
| sets[].reps 次数 | 912 | 912 | 907 | 99% |  |
| sets[].selfWeight 自重 | 912 | 912 | 0 | 0% |  |
| sets[].metrics 有氧指标对象 | 912 | 2 | 2 | 0% |  |

### 1.1 由填充率推导的结论

- **RPE 填充率仅 0%** —— 依赖 RPE 的疲劳/强度判定必须降级为 `insufficient_data`（架构 §9.5 已列此风险），UI 需提示用户训练后补打 RPE。
- 未打勾组（done=false）占比 0% —— 有效组口径必须排除这些组（架构 §6.2.4 已定死：done=false 落库但不计入有效组）。
- 训练标题有 87% 为空 —— 列表/计划页不能只靠标题展示，需用日期 + 首个动作名兜底。
- 组级实练秒数（time>0）只有 70% 的组有值 —— 训练时长应以 train.start/end 为准，不要用组级 time 求和。
- 左侧重量字段填充 21%，其中左右不等重的组 0 个 —— 左右侧训练量折算口径需要用户确认（架构 Q5）。
- 有氧指标（metrics）在 0% 的组里出现 —— 解析器必须处理有氧分支（distance/kcal/心率）。
- 训练时长（由 start/end 推算）：中位数 67 分钟，区间 19 ~ 125 分钟（样本 31 条）。

### 1.2 分类字段分布

| 字段 | 取值分布 |
| --- | --- |
| movements[].type | =114  背=28  腿=21  胸=13  臀部=11  二头=10  肩=8  三头=4  全身=3  拉伸=1  腹部=1 |
| movements[].exetype | =202  help=7  cardio=2  plus_weight=2  weight=1 |
| sets[].setType | =855  热=57 |

> 分布里若大量是"（空）"，说明这些分类字段不可依赖，动作分类必须靠标准动作名表 + 关键词规则（T2 的活）。

## 2. Q1 连通性与权限

| 项 | 值 |
| --- | --- |
| 请求日期 | 2025-03-26 |
| 请求模式 | include_full_data=true |
| HTTP 状态 | 200 |
| 耗时 | 252 ms |
| 响应编码 | gzip（传输层已自动解压，无需处理） |
| 包体大小 | 606 B（压缩）→ 606 B（解压后） |
| 返回训练条数 | 0 |
| 判定码 | OK |
| 判定 | 成功 |

✅ Key 有效且账号有权限，读取链路打通。这是 MVP T1 最大的不确定性，现已消除。

## 3. Q2 真实字段结构

> 对比样本日：**2025-03-11**（窗口内训练内容最丰富的一天（1 条训练 / 9 个动作 / 49 个组））。
> 样本日必须是"有训练且含动作"的那天，否则两种模式的字段并集都是空集，会得出"没有差异"的错误结论。

### 3.1 响应外壳与容器

| 层级 | 字段清单 |
| --- | --- |
| 响应外壳（顶层） | res |
| `res` 对象 | datestr, includeFullData, include_full_data, limits, mode, movementCatalogUrl, movement_catalog_url, schema, schema_version, trains, truncated, version |
| `res.trains[]` 单条训练的一级字段 | （无） |
| 动作容器路径 | movements —— 命中候选容器名 |

### 3.2 `include_full_data: false`（轻量）字段清单

共 26 条路径（样本日 2025-03-11）。写法说明：`res.trains[]` 表示数组元素，`…[]` 表示数组。类型取自 `typeof` 与 JSON 实际值。

```text
res.trains: array(len=1)
res.trains[].datestr: string
res.trains[].end: number
res.trains[].ended_at: number
res.trains[].localid: number
res.trains[].movements: array(len=9)
res.trains[].movements[].exetype: string
res.trains[].movements[].index: number
res.trains[].movements[].name: string
res.trains[].movements[].sets: array(len=5)
res.trains[].movements[].sets: array(len=6)
res.trains[].movements[].sets[].done: boolean
res.trains[].movements[].sets[].index: number
res.trains[].movements[].sets[].reps: string
res.trains[].movements[].sets[].selfWeight: boolean
res.trains[].movements[].sets[].time: number
res.trains[].movements[].sets[].timeLabel: string
res.trains[].movements[].sets[].unit: string
res.trains[].movements[].sets[].weight: string
res.trains[].movements[].truncated: boolean
res.trains[].movements[].type: string
res.trains[].note: string
res.trains[].start: number
res.trains[].started_at: number
res.trains[].title: string
res.trains[].truncated: boolean
```

### 3.3 `include_full_data: true`（完整）字段清单

共 35 条路径（样本日 2025-03-11）。

```text
res.trains: array(len=1)
res.trains[].datestr: string
res.trains[].end: number
res.trains[].ended_at: number
res.trains[].localid: number
res.trains[].movements: array(len=9)
res.trains[].movements[].exetype: string
res.trains[].movements[].index: number
res.trains[].movements[].name: string
res.trains[].movements[].note: string
res.trains[].movements[].restTime: number
res.trains[].movements[].sets: array(len=5)
res.trains[].movements[].sets: array(len=6)
res.trains[].movements[].sets[].comment: string
res.trains[].movements[].sets[].done: boolean
res.trains[].movements[].sets[].index: number
res.trains[].movements[].sets[].leftWeight: string
res.trains[].movements[].sets[].note: string
res.trains[].movements[].sets[].reps: string
res.trains[].movements[].sets[].rpe: string
res.trains[].movements[].sets[].selfWeight: boolean
res.trains[].movements[].sets[].setType: string
res.trains[].movements[].sets[].time: number
res.trains[].movements[].sets[].timeLabel: string
res.trains[].movements[].sets[].unit: string
res.trains[].movements[].sets[].weight: string
res.trains[].movements[].singleSide: boolean
res.trains[].movements[].truncated: boolean
res.trains[].movements[].type: string
res.trains[].movements[].warn_restTime: number
res.trains[].note: string
res.trains[].start: number
res.trains[].started_at: number
res.trains[].title: string
res.trains[].truncated: boolean
```

### 3.4 差异对比

**仅在 full 模式出现的字段（共 9 条）** —— 这些就是"必须 include_full_data:true 才有"的部分：

```text
res.trains[].movements[].note: string
res.trains[].movements[].restTime: number
res.trains[].movements[].sets[].comment: string
res.trains[].movements[].sets[].leftWeight: string
res.trains[].movements[].sets[].note: string
res.trains[].movements[].sets[].rpe: string
res.trains[].movements[].sets[].setType: string
res.trains[].movements[].singleSide: boolean
res.trains[].movements[].warn_restTime: number
```

**仅在轻量模式出现的字段（共 0 条）** —— 正常情况下应为空，非空说明两种模式结构本身就有差异：

```text
（无）
```

### 3.5 关键字段存在性检查（只看"字段在不在"，填充率见 §1）

| 字段类别 | 轻量模式 | 完整模式 | 示例路径 |
| --- | --- | --- | --- |
| RPE / 主观强度 | 无 | 有 | res.trains[].movements[].sets[].rpe: string |
| 备注 note | 有 | 有 | res.trains[].movements[].note: string<br>res.trains[].movements[].sets[].comment: string<br>res.trains[].movements[].sets[].note: string |
| 完成感受 feeling | 无 | 无 | - |
| 是否完成 done | 有 | 有 | res.trains[].movements[].sets[].done: boolean |
| 左右侧 side | 无 | 有 | res.trains[].movements[].sets[].leftWeight: string |
| 实练秒数 time/duration | 有 | 有 | res.trains[].movements[].sets[].time: number |
| 重量与单位 weight/unit | 有 | 有 | res.trains[].movements[].sets[].leftWeight: string<br>res.trains[].movements[].sets[].selfWeight: boolean<br>res.trains[].movements[].sets[].unit: string |
| 次数 reps | 有 | 有 | res.trains[].movements[].sets[].reps: string |
| 距离 distance | 无 | 无 | - |
| 热量 kcal/calories | 无 | 无 | - |
| 心率 heartRate | 无 | 无 | - |
| 超级组/递减组子项 items | 无 | 无 | - |
| 有氧标记 cardio | 无 | 无 | - |
| 记录预设 recordPreset | 无 | 无 | - |

> 关注点：RPE、备注、完成感受、未打勾组、左右侧重量、实练秒数这几类（架构 §6.2 已核实需 full 模式才有）。
> 若某类在 full 模式仍为"无"，则该类数据确实不存在，依赖它的分析判定要按降级处理。

### 3.6 样本片段

**轻量模式：第一条训练（示例数据：字段结构真实，数值虚构）**

```json
{
  "localid": 1741651200000,
  "datestr": "2025-03-11",
  "title": "",
  "note": "calorie:",
  "start": 1741672800000,
  "end": 1741676820000,
  "started_at": 1741672800000,
  "ended_at": 1741676820000,
  "movements": [
    {
      "index": 1,
      "name": "杠铃划船",
      "type": "",
      "exetype": "",
      "sets": [
        {
          "index": 1,
          "done": true,
          "weight": "40",
          "unit": "kg",
          "reps": "10",
          "time": 60,
          "timeLabel": "",
          "selfWeight": false
        },
        {
          "index": 2,
          "done": true,
          "weight": "40",
          "unit": "kg",
          "reps": "10",
          "time": 0,
          "timeLabel": "",
          "selfWeight": false
        },
        {
          "index": 3,
          "done": true,
          "weight": "45",
          "unit": "kg",
          "reps": "10",
          "time": 60,
          "timeLabel": "",
          "selfWeight": false
        },
        {
          "index": 4,
          "done": true,
          "weight": "45",
          "unit": "kg",
          "reps": "10",
          "time": 60,
          "timeLabel": "",
          "selfWeight": false
        },
…（已截断，原长 3019 字符）
```

**完整模式：第一条训练（示例数据：字段结构真实，数值虚构）**

```json
{
  "localid": 1741651200000,
  "datestr": "2025-03-11",
  "title": "",
  "note": "calorie:",
  "start": 1741672800000,
  "end": 1741676820000,
  "started_at": 1741672800000,
  "ended_at": 1741676820000,
  "movements": [
    {
      "index": 1,
      "name": "杠铃划船",
      "type": "",
      "exetype": "",
      "sets": [
        {
          "index": 1,
          "done": true,
          "weight": "40",
          "unit": "kg",
          "reps": "10",
          "time": 60,
          "timeLabel": "",
          "selfWeight": false,
          "rpe": "",
          "note": "",
          "comment": "",
          "setType": ""
        },
        {
          "index": 2,
          "done": true,
          "weight": "40",
          "unit": "kg",
          "reps": "10",
          "time": 0,
          "timeLabel": "",
          "selfWeight": false,
          "rpe": "",
          "note": "",
          "comment": "",
          "setType": ""
        },
        {
          "index": 3,
          "done": true,
          "weight": "45",
          "unit": "kg",
          "reps": "10",
          "time": 60,
          "timeLabel": "",
          "selfWeight": false,
          "rpe": "",
          "note": "",

…（已截断，原长 3019 字符）
```

## 4. Q3 限频行为

### 4.1 同一天连续两次请求

| 项 | 值 |
| --- | --- |
| 请求间隔 | 立即（不等待冷却） |
| HTTP 状态 | 200 |
| 判定码 | TOO_FREQUENT |
| 判定 | 读取过于频繁，被限频（too frequent） |
| 服务端消息 | too frequent, retry after 30s |
| 建议等待（已解析） | 30000 ms（依据：提示文本 "too frequent, retry after 30s"） |

**`too frequent` 原始响应片段（示例数据：字段结构真实，数值虚构）**

```json
{"success":false,"res":"too frequent, retry after 30s"}
```

> 这一条同时回答了架构 Q24（retry 时间的字段名是什么）。若上方"依据"显示"未找到明确提示"，
> 说明需要按固定 90 秒兜底，无法用服务端给出的精确值。

### 4.2 跨日期是否互不阻塞

| 日期 | HTTP | 判定码 | 判定 | 训练条数 | 耗时 |
| --- | --- | --- | --- | --- | --- |
| 2025-03-25 | 200 | OK | 成功 | 1 | 141 ms |
| 2025-03-24 | 200 | OK | 成功 | 1 | 52 ms |

> ✅ **结论：不同日期互不阻塞**，符合"限频按 datestr 维度"的事实。首次 84 天同步理论上可并发，但架构给的默认值仍是串行（并发 1），配置项 `sync.concurrency` 已预留。

> 备注：本次 --delay-ms=1500ms；若想做最严格的跨日测试，可用 --delay-ms 0 重跑。

### 4.3 对首次同步策略的影响

- 12 周 ≈ 84 个日期。若跨日期互不阻塞，瓶颈只在"同一天的重复读取"，而正常同步每个日期只拉一次 → 不构成限制。
- 失败重试时必须注意：重试同一天要重新进入限频窗口（服务端自报 30 秒），所以失败日期应单独入队、不与主流程争抢同一日期。
- 写入后回读校验同样受此限制（架构 §6.3.5 写的是"≥90 秒"，实际应以服务端自报的 30 秒为准）。
- ⚠ **架构 §6.2.2 / §12.1 的 `READ_COOL_DOWN_MS = 90_000` 与服务端自报的 30 秒不一致**，建议架构师以实测值修订。

## 5. Q4 动作名覆盖

| 指标 | 值 |
| --- | --- |
| 扫描天数 | 90 |
| 其中有训练的天数 | 29 |
| 失败天数 | 0 |
| 训练总条数 | 31 |
| 动作条目总数（含重复） | 237 |
| 去重动作名数量 | 48 |

> ⚠️ **脱敏说明（示例数据：字段结构真实，数值虚构）**：下表为**截取的示例片段**，用于演示逐日字段结构与判定码；**其「训练条数 / 动作条目数 / 组数」的逐日明细与合计，均与 §1 的样本汇总规模（31 条训练 / 214 个动作 / 912 个组）不对应** —— 请勿据此反推任何真实账号的样本量或训练构成。

| 日期 | 训练条数 | 动作条目数 | 组数 | 数据来源 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 2025-03-26 | 0 | 0 | 0 | reuse-full | 成功 |
| 2025-03-25 | 1 | 7 | 33 | reuse-full | 成功 |
| 2025-03-24 | 0 | 0 | 0 | reuse-full | 成功 |
| 2025-03-23 | 0 | 0 | 0 | full | 成功 |
| 2025-03-22 | 1 | 9 | 12 | full | 成功 |
| 2025-03-21 | 0 | 0 | 0 | full | 成功 |
| 2025-03-20 | 1 | 8 | 36 | full | 成功 |
| 2025-03-19 | 0 | 0 | 0 | full | 成功 |
| 2025-03-18 | 1 | 7 | 31 | full | 成功 |
| 2025-03-17 | 1 | 6 | 23 | full | 成功 |
| 2025-03-16 | 0 | 0 | 0 | full | 成功 |
| 2025-03-15 | 1 | 9 | 37 | full | 成功 |
| 2025-03-14 | 0 | 0 | 0 | full | 成功 |
| 2025-03-13 | 0 | 0 | 0 | full | 成功 |
| 2025-03-12 | 1 | 8 | 13 | full | 成功 |
| 2025-03-11 | 1 | 9 | 49 | full | 成功 |
| 2025-03-10 | 0 | 0 | 0 | full | 成功 |
| 2025-03-09 | 1 | 9 | 46 | full | 成功 |
| 2025-03-08 | 1 | 7 | 35 | full | 成功 |
| 2025-03-07 | 0 | 0 | 0 | full | 成功 |
| 2025-03-06 | 1 | 7 | 33 | full | 成功 |
| 2025-03-05 | 1 | 6 | 25 | full | 成功 |
| 2025-03-04 | 1 | 6 | 28 | full | 成功 |
| 2025-03-03 | 1 | 7 | 35 | full | 成功 |
| 2025-03-02 | 0 | 0 | 0 | full | 成功 |
| 2025-03-01 | 1 | 6 | 32 | full | 成功 |
| 2025-02-28 | 1 | 7 | 36 | full | 成功 |
| 2025-02-27 | 0 | 0 | 0 | full | 成功 |
| 2025-02-26 | 1 | 4 | 18 | full | 成功 |
| 2025-02-25 | 1 | 10 | 19 | full | 成功 |
| 2025-02-24 | 1 | 10 | 28 | full | 成功 |
| 2025-02-23 | 1 | 5 | 34 | full | 成功 |
| 2025-02-22 | 0 | 0 | 0 | full | 成功 |
| 2025-02-21 | 1 | 9 | 17 | full | 成功 |
| 2025-02-20 | 1 | 10 | 19 | full | 成功 |
| 2025-02-19 | 1 | 8 | 14 | full | 成功 |
| 2025-02-18 | 1 | 6 | 16 | full | 成功 |
| 2025-02-17 | 1 | 9 | 26 | full | 成功 |
| 2025-02-16 | 1 | 9 | 31 | full | 成功 |
| 2025-02-15 | 1 | 6 | 40 | full | 成功 |
| 2025-02-14 | 0 | 0 | 0 | full | 成功 |
| 2025-02-13 | 1 | 5 | 27 | full | 成功 |
| 2025-02-12 | 0 | 0 | 0 | full | 成功 |
| 2025-02-11 | 1 | 8 | 16 | full | 成功 |
| 2025-02-10 | 1 | 9 | 19 | full | 成功 |
| 2025-02-09 | 1 | 6 | 40 | full | 成功 |
| 2025-02-08 | 1 | 6 | 28 | full | 成功 |
| 2025-02-07 | 1 | 7 | 31 | full | 成功 |
| 2025-02-06 | 1 | 7 | 28 | full | 成功 |
| 2025-02-05 | 1 | 7 | 41 | full | 成功 |
| 2025-02-04 | 1 | 6 | 33 | full | 成功 |
| 2025-02-03 | 1 | 4 | 25 | full | 成功 |
| 2025-02-02 | 1 | 8 | 18 | full | 成功 |
| 2025-02-01 | 0 | 0 | 0 | full | 成功 |
| 2025-01-31 | 0 | 0 | 0 | full | 成功 |
| 2025-01-30 | 1 | 9 | 24 | full | 成功 |
| 2025-01-29 | 0 | 0 | 0 | full | 成功 |
| 2025-01-28 | 1 | 4 | 15 | full | 成功 |
| 2025-01-27 | 0 | 0 | 0 | full | 成功 |
| 2025-01-26 | 1 | 5 | 31 | full | 成功 |
| 2025-01-25 | 0 | 0 | 0 | full | 成功 |
| 2025-01-24 | 0 | 0 | 0 | full | 成功 |
| 2025-01-23 | 1 | 8 | 21 | full | 成功 |
| 2025-01-22 | 0 | 0 | 0 | full | 成功 |
| 2025-01-21 | 0 | 0 | 0 | full | 成功 |
| 2025-01-20 | 1 | 8 | 29 | full | 成功 |
| 2025-01-19 | 1 | 7 | 21 | full | 成功 |
| 2025-01-18 | 0 | 0 | 0 | full | 成功 |
| 2025-01-17 | 0 | 0 | 0 | full | 成功 |
| 2025-01-16 | 0 | 0 | 0 | full | 成功 |
| 2025-01-15 | 0 | 0 | 0 | full | 成功 |
| 2025-01-14 | 1 | 8 | 14 | full | 成功 |
| 2025-01-13 | 1 | 9 | 35 | full | 成功 |
| 2025-01-12 | 1 | 9 | 41 | full | 成功 |
| 2025-01-11 | 0 | 0 | 0 | full | 成功 |
| 2025-01-10 | 0 | 0 | 0 | full | 成功 |
| 2025-01-09 | 0 | 0 | 0 | full | 成功 |
| 2025-01-08 | 1 | 10 | 28 | full | 成功 |
| 2025-01-07 | 0 | 0 | 0 | full | 成功 |
| 2025-01-06 | 1 | 7 | 33 | full | 成功 |
| 2025-01-05 | 1 | 5 | 14 | full | 成功 |
| 2025-01-04 | 1 | 9 | 26 | full | 成功 |
| 2025-01-03 | 0 | 0 | 0 | full | 成功 |
| 2025-01-02 | 0 | 0 | 0 | full | 成功 |
| 2025-01-01 | 0 | 0 | 0 | full | 成功 |
| 2024-12-31 | 0 | 0 | 0 | full | 成功 |
| 2024-12-30 | 0 | 0 | 0 | full | 成功 |
| 2024-12-29 | 0 | 0 | 0 | full | 成功 |
| 2024-12-28 | 1 | 6 | 16 | full | 成功 |
| 2024-12-27 | 1 | 7 | 36 | full | 成功 |

### 5.1 去重动作中文名清单（共 48 个，按出现次数降序）

> ⚠️ **脱敏说明（示例数据：字段结构真实，数值虚构）**：以下清单为**等价规模的示例数据**，仅保留「条数 = 48」「出现次数合计 = 214」与原始统计对齐，**动作名与排序均为重新组合，不代表任何真实账号的训练动作构成**。
>
> 这份清单是后续肌群映射冷启动的输入：先和标准动作名表 https://github.com/Foveluy/Xunji-movements 比对，
> 命中不了的即为"自定义动作/别名"，需要走人工确认流程（架构 §6.2 / T2）。

| # | 动作名 | 出现次数 | 出现天数 |
| --- | --- | --- | --- |
| 1 | 深蹲 | 10 | 10 |
| 2 | 硬拉 | 10 | 10 |
| 3 | 杠铃卧推 | 9 | 9 |
| 4 | 引体向上 | 9 | 9 |
| 5 | 哑铃推肩 | 8 | 8 |
| 6 | 杠铃划船 | 8 | 8 |
| 7 | 罗马尼亚硬拉 | 8 | 8 |
| 8 | 腿举 | 7 | 7 |
| 9 | 面拉 | 7 | 7 |
| 10 | 侧平举 | 7 | 7 |
| 11 | 绳索下压 | 7 | 7 |
| 12 | 杠铃弯举 | 6 | 6 |
| 13 | 坐姿划船 | 6 | 6 |
| 14 | 高位下拉 | 6 | 6 |
| 15 | 腿弯举 | 6 | 6 |
| 16 | 腿屈伸 | 6 | 6 |
| 17 | 哑铃卧推 | 5 | 5 |
| 18 | 上斜哑铃卧推 | 5 | 5 |
| 19 | 保加利亚分腿蹲 | 5 | 5 |
| 20 | 臀冲 | 5 | 5 |
| 21 | 反向飞鸟 | 5 | 5 |
| 22 | 前平举 | 5 | 5 |
| 23 | 三头臂屈伸 | 4 | 4 |
| 24 | 锤式弯举 | 4 | 4 |
| 25 | 直臂下压 | 4 | 4 |
| 26 | 农夫行走 | 4 | 4 |
| 27 | 箭步蹲 | 4 | 4 |
| 28 | 髋外展 | 4 | 4 |
| 29 | 提踵 | 3 | 3 |
| 30 | 卷腹 | 3 | 3 |
| 31 | 悬垂举腿 | 3 | 3 |
| 32 | 平板支撑 | 3 | 3 |
| 33 | 双杠臂屈伸 | 3 | 3 |
| 34 | 阿诺德推举 | 3 | 3 |
| 35 | 史密斯深蹲 | 3 | 3 |
| 36 | 器械夹胸 | 2 | 2 |
| 37 | 绳索夹胸 | 2 | 2 |
| 38 | 划船机 | 2 | 2 |
| 39 | 蝴蝶机反向飞鸟 | 2 | 2 |
| 40 | 颈后推举 | 2 | 2 |
| 41 | 山羊挺身 | 2 | 2 |
| 42 | 哑铃飞鸟 | 1 | 1 |
| 43 | 器械推肩 | 1 | 1 |
| 44 | 坐姿推胸 | 1 | 1 |
| 45 | 绳索面拉 | 1 | 1 |
| 46 | 杠铃耸肩 | 1 | 1 |
| 47 | 有氧慢跑 | 1 | 1 |
| 48 | 拉伸放松 | 1 | 1 |

### 5.2 纯文本清单（可直接复制去做比对）

```text
深蹲
硬拉
杠铃卧推
引体向上
哑铃推肩
杠铃划船
罗马尼亚硬拉
腿举
面拉
侧平举
绳索下压
杠铃弯举
坐姿划船
高位下拉
腿弯举
腿屈伸
哑铃卧推
上斜哑铃卧推
保加利亚分腿蹲
臀冲
反向飞鸟
前平举
三头臂屈伸
锤式弯举
直臂下压
农夫行走
箭步蹲
髋外展
提踵
卷腹
悬垂举腿
平板支撑
双杠臂屈伸
阿诺德推举
史密斯深蹲
器械夹胸
绳索夹胸
划船机
蝴蝶机反向飞鸟
颈后推举
山羊挺身
哑铃飞鸟
器械推肩
坐姿推胸
绳索面拉
杠铃耸肩
有氧慢跑
拉伸放松
```

> 架构预计用户实际用过的动作在 30~150 个之间。若实测数量明显偏离，说明要么窗口太短，要么动作命名习惯不同，值得回头看一眼。

## 6. 后续影响与建议

- **建表依据**：以本报告 §3.3 的完整模式字段清单为准，`raw_json` 字段兜底保存未知字段（架构 §6.2.4）。
- **解析器写法**：超级组/递减组取 `sets[].items[]` 子项；有氧类取 `sets[].metrics` 的距离/热量/心率；具体路径以实测清单为准。
- **分析可行性**：先看 §1 填充率。RPE 这类"字段存在但没人填"的数据，不能作为判定的唯一依据。
- **同步策略**：默认串行、并发 1；若 §4.2 确认跨日期互不阻塞且实测稳定，再考虑把 `sync.concurrency` 调到 2~3。
- **冷启动顺序**：先把 §5.1 的清单与 1187 个标准名比对 → 生成预测映射 → 用户确认 → 再算趋势与结论。

## 7. 附录

### 7.1 本次请求参数

```json
{
  "method": "POST",
  "url": "https://trains.xunjiapp.cn/api_trains_for_llm_v2",
  "headers": {
    "Content-Type": "application/json",
    "Authorization": "Bearer ***REDACTED***",
    "Accept-Encoding": "gzip"
  },
  "body": {
    "schema_version": "train_open_api_v2",
    "datestr": "2025-03-26",
    "include_full_data": true
  }
}
```

### 7.2 原始响应落盘位置

- `<PROJECT_ROOT>\data\probe\2025-03-26.json`
- `<PROJECT_ROOT>\data\probe\2025-03-25.json`
- `<PROJECT_ROOT>\data\probe\2025-03-24.json`
- `<PROJECT_ROOT>\data\probe\2025-03-23.json`
- `<PROJECT_ROOT>\data\probe\2025-03-22.json`
- `<PROJECT_ROOT>\data\probe\2025-03-21.json`
- `<PROJECT_ROOT>\data\probe\2025-03-20.json`
- `<PROJECT_ROOT>\data\probe\2025-03-19.json`
- `<PROJECT_ROOT>\data\probe\2025-03-18.json`
- `<PROJECT_ROOT>\data\probe\2025-03-17.json`
- `<PROJECT_ROOT>\data\probe\2025-03-16.json`
- `<PROJECT_ROOT>\data\probe\2025-03-15.json`
- `<PROJECT_ROOT>\data\probe\2025-03-14.json`
- `<PROJECT_ROOT>\data\probe\2025-03-13.json`
- `<PROJECT_ROOT>\data\probe\2025-03-12.json`
- `<PROJECT_ROOT>\data\probe\2025-03-11.json`
- `<PROJECT_ROOT>\data\probe\2025-03-10.json`
- `<PROJECT_ROOT>\data\probe\2025-03-09.json`
- `<PROJECT_ROOT>\data\probe\2025-03-08.json`
- `<PROJECT_ROOT>\data\probe\2025-03-07.json`
- `<PROJECT_ROOT>\data\probe\2025-03-06.json`
- `<PROJECT_ROOT>\data\probe\2025-03-05.json`
- `<PROJECT_ROOT>\data\probe\2025-03-04.json`
- `<PROJECT_ROOT>\data\probe\2025-03-03.json`
- `<PROJECT_ROOT>\data\probe\2025-03-02.json`
- `<PROJECT_ROOT>\data\probe\2025-03-01.json`
- `<PROJECT_ROOT>\data\probe\2025-02-28.json`
- `<PROJECT_ROOT>\data\probe\2025-02-27.json`
- `<PROJECT_ROOT>\data\probe\2025-02-26.json`
- `<PROJECT_ROOT>\data\probe\2025-02-25.json`
- `<PROJECT_ROOT>\data\probe\2025-02-24.json`
- `<PROJECT_ROOT>\data\probe\2025-02-23.json`
- `<PROJECT_ROOT>\data\probe\2025-02-22.json`
- `<PROJECT_ROOT>\data\probe\2025-02-21.json`
- `<PROJECT_ROOT>\data\probe\2025-02-20.json`
- `<PROJECT_ROOT>\data\probe\2025-02-19.json`
- `<PROJECT_ROOT>\data\probe\2025-02-18.json`
- `<PROJECT_ROOT>\data\probe\2025-02-17.json`
- `<PROJECT_ROOT>\data\probe\2025-02-16.json`
- `<PROJECT_ROOT>\data\probe\2025-02-15.json`
- `<PROJECT_ROOT>\data\probe\2025-02-14.json`
- `<PROJECT_ROOT>\data\probe\2025-02-13.json`
- `<PROJECT_ROOT>\data\probe\2025-02-12.json`
- `<PROJECT_ROOT>\data\probe\2025-02-11.json`
- `<PROJECT_ROOT>\data\probe\2025-02-10.json`
- `<PROJECT_ROOT>\data\probe\2025-02-09.json`
- `<PROJECT_ROOT>\data\probe\2025-02-08.json`
- `<PROJECT_ROOT>\data\probe\2025-02-07.json`
- `<PROJECT_ROOT>\data\probe\2025-02-06.json`
- `<PROJECT_ROOT>\data\probe\2025-02-05.json`
- `<PROJECT_ROOT>\data\probe\2025-02-04.json`
- `<PROJECT_ROOT>\data\probe\2025-02-03.json`
- `<PROJECT_ROOT>\data\probe\2025-02-02.json`
- `<PROJECT_ROOT>\data\probe\2025-02-01.json`
- `<PROJECT_ROOT>\data\probe\2025-01-31.json`
- `<PROJECT_ROOT>\data\probe\2025-01-30.json`
- `<PROJECT_ROOT>\data\probe\2025-01-29.json`
- `<PROJECT_ROOT>\data\probe\2025-01-28.json`
- `<PROJECT_ROOT>\data\probe\2025-01-27.json`
- `<PROJECT_ROOT>\data\probe\2025-01-26.json`
- `<PROJECT_ROOT>\data\probe\2025-01-25.json`
- `<PROJECT_ROOT>\data\probe\2025-01-24.json`
- `<PROJECT_ROOT>\data\probe\2025-01-23.json`
- `<PROJECT_ROOT>\data\probe\2025-01-22.json`
- `<PROJECT_ROOT>\data\probe\2025-01-21.json`
- `<PROJECT_ROOT>\data\probe\2025-01-20.json`
- `<PROJECT_ROOT>\data\probe\2025-01-19.json`
- `<PROJECT_ROOT>\data\probe\2025-01-18.json`
- `<PROJECT_ROOT>\data\probe\2025-01-17.json`
- `<PROJECT_ROOT>\data\probe\2025-01-16.json`
- `<PROJECT_ROOT>\data\probe\2025-01-15.json`
- `<PROJECT_ROOT>\data\probe\2025-01-14.json`
- `<PROJECT_ROOT>\data\probe\2025-01-13.json`
- `<PROJECT_ROOT>\data\probe\2025-01-12.json`
- `<PROJECT_ROOT>\data\probe\2025-01-11.json`
- `<PROJECT_ROOT>\data\probe\2025-01-10.json`
- `<PROJECT_ROOT>\data\probe\2025-01-09.json`
- `<PROJECT_ROOT>\data\probe\2025-01-08.json`
- `<PROJECT_ROOT>\data\probe\2025-01-07.json`
- `<PROJECT_ROOT>\data\probe\2025-01-06.json`
- `<PROJECT_ROOT>\data\probe\2025-01-05.json`
- `<PROJECT_ROOT>\data\probe\2025-01-04.json`
- `<PROJECT_ROOT>\data\probe\2025-01-03.json`
- `<PROJECT_ROOT>\data\probe\2025-01-02.json`
- `<PROJECT_ROOT>\data\probe\2025-01-01.json`
- `<PROJECT_ROOT>\data\probe\2024-12-31.json`
- `<PROJECT_ROOT>\data\probe\2024-12-30.json`
- `<PROJECT_ROOT>\data\probe\2024-12-29.json`
- `<PROJECT_ROOT>\data\probe\2024-12-28.json`
- `<PROJECT_ROOT>\data\probe\2024-12-27.json`

### 7.3 运行提示

```bash
# 复制环境变量模板并填入 Key
cp .env.example .env

# 默认：最近 7 天 + 字段对比 + 限频实验
node scripts/probe_xunji.mjs

# 只要字段结构，跳过耗时约 3 分钟的限频实验
node scripts/probe_xunji.mjs --no-rate-test --days 1

# 扩大动作名覆盖采样
node scripts/probe_xunji.mjs --days 30 --dump-raw
```

---

*报告生成时间：2025-03-26 13:31:49。生成器：scripts/probe_xunji.mjs（对应探针脚本 scripts/probe_xunji.mjs）。*

---

# 补充实测：全量 182 天的真实耗时与限频行为（2026-10-01）

**触发背景**：分析窗口由 12 周扩到 26 周（182 天），`SYNC_INITIAL_WEEKS` 随之变 26。
原先依据本文 §4 与 `PRD.md:507` 的「≈1 秒/天」推断「182 天约 3 分钟」，**实测证明这个推断是错的**。

**方法与安全边界**：
- 全程用 `node dist/sync.js --db=tmp/qps/<name>.db` 指向**独立空库**，源库 `data/app.db` 全程只读；
- 实测前后对源库取 sha256（`ada98aea661c0c77…`）与 mtime 比对，**完全一致，未被污染**；
- 只调用读取接口，未触发任何写回。

## 实测数据

| # | 窗口 | 并发 | 前置状态 | 耗时 | 限频次数 |
|---|---|---|---|---|---|
| 1 | 3 天 | 1 | — | 0.4s | 0 |
| 2 | 182 天 | 1 | 距上次 60s | 48.3s | 6 |
| 3 | 182 天 | 2 | 紧接 #2 | 58.3s | 4（降并发 1 次） |
| 4 | 182 天 | 4 | 紧接 #3 | 28.5s | 1（降并发 1 次） |
| 5 | 60 天 | 1 | 距上次 15s | 2.9s | 0 |
| 6 | 182 天 | 1 | 紧接 #5 | 43.8s | **108** |
| 7 | **182 天** | **1** | **静默 95s** | **8.9s** | **0** |
| 8 | **182 天** | **1** | **静默 95s** | **8.6s** | **0** |
| 9 | 182 天 | 1 | 紧接 #8 | 被限频（19s 后重试） | 大量 |

## 结论

### ✅ 修正 1：单请求远快于旧记录，「1 秒/天」不成立
日志实测单日读取 **0.04~0.32s**（有数据的日子 5~8KB 响应 ≈ 40~60ms；空日 606B ≈ 40ms；含未预热的首个请求 0.32s）。
**干净状态下 182 天串行仅 8.6~8.9 秒**（第 7、8 轮，两次独立复现，零限频）。

> 本文 §4.2 与 `PRD.md:507` 的「纯网络 ≈91 秒 / 84 天」应为 2025-03-26 那次探针的特定条件（含 `--delay-ms=1500` 注入、探针额外开销、当时网络），**不代表引擎的真实吞吐**。

### ✅ 修正 2：§4.2「不同日期互不阻塞」的结论不完整，会误导
第 6 轮出现 **108 次限频，且被限频的是 60 个各不相同的日期**（10-01 连续到 08-03）——
若限频只按「同一训练日」计算，这不可能发生。§4.2 之所以得出乐观结论，是因为那次测试**带 `--delay-ms=1500ms`**，请求稀疏，恰好没有踩到窗口。

**真实行为**：短时间内在同一批日期上重复读取 → **必然成批触发限频**（第 3、4、6、9 轮），耗时从 ~9s 涨到 30~60s。
第 9 轮做了干净的配对实验：静默 95 秒后首轮 8.6s 零限频，**紧接着再读同一批 182 天立刻被限频**。

### ✅ 修正 3：服务端返回的是**动态** retry 值
第 6 轮日志中等待值为 `1s / 12s / 13s / 30s` 混杂。解析链见 `server/xunji/errors.ts:144`（`parseRetryMs(envelope.res) ?? parseRetryMs(envelope.error)`）
与 `ratelimit.ts` 的 `resolveRetryMs(hint ?? readCooldownMs(limits))` ——
**1s/12s/13s 只能来自服务端响应文本**，30s 才是 `readRateLimitSecondsFull` 兜底值。
即服务端会按惩罚窗口的剩余时间动态回话，而非固定 30 秒。

### ⚠️ 仍未锁定：限频的**精确**触发条件
第 3、4 轮（并发 2/4，紧接前一轮）只报 4 次和 1 次限频却耗时 58.3s / 28.5s，与第 9 轮「紧接即大量限频」的模式对不上。
怀疑 `rateLimitHits` **只统计首次撞限频**、不统计「已在冷却中反复移队尾」的等待（见 `syncEngine.ts:282-291` 的分支不计数），但这未能证实。
**需要一次不互相污染的实验矩阵才能定论**；在此之前，「并发能否提速」**没有可信结论**。

## 对实现的实际影响

1. **首次导入不是性能问题** —— 干净状态下 182 天 ≈ 9 秒，无需并发优化、无需渐进式导入。
2. **需要防的是「短时间内重复同步同一批日期」**（第 9 轮场景）。
   现有 `freshnessOk`（历史日期 30 天 TTL、近 7 天 6h TTL，`syncEngine.ts:195-203`）恰好能挡住：同步成功后 30 天内再点全量会全部 skipped、不发请求，因此**生产路径不会出现第 9 轮的情形**。
3. 失败重试会重新进入冷却窗口（`probe-report.md` §4.3 已指出），应继续让失败日期单独入队。
4. 限频**不丢数据**：全部 9 轮 `失败 0`，引擎等待后重试并最终 `SUCCESS`。

*补充实测时间：2026-10-01 15:20（北京时间）。执行：`node dist/sync.js --db=tmp/qps/*.db`，源库未触碰。*
