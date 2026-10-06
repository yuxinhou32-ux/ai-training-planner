# 「周期内同一个模板」执行方案（**已实施**）

> 用户 2026-09-30 原话：「周期内是不是同一个模板，这个事情我觉得可以考虑，因为这也会比较省 token……
> 我们可以第一次生成之后把那个模板写进去，然后第二次生成就直接基于模板上改了。」
>
> 用户核验方案后批准：「周期内同一个模板，我觉得可以，你这个落地方案可以。」
>
> **状态：已实施（2026-09-30）。实测量级见文末 §11。** 下方方案正文保持原样，便于对照「说的」与「做的」。

---

## 1. 目标与取舍

| 优先级 | 目标 | 衡量 |
|---|---|---|
| 1 | **省 token** | 第 2~4 周的 AI 输入从「完整摘要层」降到「模板 + 本周增量」 |
| 2 | **周期内稳定** | 动作构成不跳，用户能感到「这 4 周在练同一套东西」 |
| 3 | **不牺牲响应** | 遇到本周特殊情况（经期 / 临时不舒服）仍然减容 |

三条冲突时的顺序：**3 > 2 > 1**。省 token 不能换来「特殊情况下照抄模板」。
这条顺序也不是新立的 —— 现有的 prompt 优先级链条就是「硬约束 > 本周特殊情况 > 周期目标 > 长期目标 > …」。

前置条件已经就位：**周期目标没锁定就不给生成**（首页已做门控）。没有周期目标就没有可以沿用的东西，
所以这个功能天然只能挂在「已锁定周期」之下。

---

## 2. 心智模型：三个输入叠加

```
模板（第 1 周那份「被你改完的」计划）
  │  结构：哪天练、练什么动作、几组几次、休息多久
  ├─ ① 平移日期到本周（周一起，按训练日）
  ├─ ② 叠加增重建议（V5 progression：本地算好的 suggest_kg，第 4 周自动 −10%）
  ├─ ③ 叠加本周特殊情况（week_note，**最高优先级** → 减容，不禁用）
  └─ ④ 叠加本周该补该减（findings / focus / reduce）
      = 下周草稿
```

**「同一个模板」不等于「同一份计划」**：动作构成沿用，重量/组数按上面的 ②③④ 变。
进步体现在 ②，不是体现在换动作。

---

## 3. 模板存在哪：**不建新表**

**模板 = 同一周期上一周那份 plan**（`plan` / `plan_day` / `plan_exercise` 本来就在库里）。

理由：用户会在第 1 周把草稿改成自己要的样子，**那份改完的计划本身就是模板**。
另存一份 JSON 反而会跟用户的修改脱钩 —— 改完草稿还得记得「更新模板」，多一个会忘的动作。

取法（新函数 `templateFor(db, weekStart)`）：

1. 若该周是周期第 1 周 → 无模板 → 回落全量生成
2. 否则取「周期内、该周之前 7 天那一周」的 plan，要求 `status not in ('archived','cancelled')`
3. 取不到（用户删了/取消了上周计划）→ 回落全量生成，**不报错**

> **备选（不推荐）**：新表 `cycle_template(cycle_id, payload_json, created_from_plan_id)`。
> 多一张表、多一套同步与迁移，收益只覆盖「用户删了上周计划还想沿用模板」这一个场景 ——
> 而这个场景用「回落全量」就能交代过去。与「反对过度设计」相冲。

---

## 4. 两条路：AI 增量（默认） / 本地平移（兜底）

| | **A. AI 增量**（默认） | **B. 本地平移**（兜底） |
|---|---|---|
| 触发 | 正常路径 | AI 未配置 / 3 次校验不过熔断 / 模板缺失 |
| 输入 | 模板 + 本周特殊情况 + 增重建议 + findings（**目标 ≤4KB**） | 不需要 AI |
| 做法 | 让 AI 输出**完整的下周草稿**：结构沿用模板，只改该改的 | 机械平移：日期 → 套 `suggest_kg` → 按统一比例减容 |
| 校验 | 复用现有 V1~V5 validator | 同左（本地生成的天然满足） |
| UI 标注 | 「AI 生成 · 基于第 N 周模板」 | 「规则模板（非 AI）· 基于第 N 周模板」 |

### 为什么**不用**「AI 输出 diff / patch」

diff 协议要新 schema、新 validator、新的合并/回滚逻辑 —— 换来的只是「输出也变小」。
但输出本来就只有几 KB，**省 token 的大头是输入**（14KB → 4KB）。
而「输出完整草稿」可以**原样复用** `PLAN_OUTPUT_SCHEMA` + `validator.ts`，改动面最小。

> 结论：省 token 靠输入瘦身，不靠输出变协议。

---

## 5. 本周特殊情况怎么叠加（最高优先级，但不许禁用动作）

`week_note` 原文进 prompt 的独立高优先级段（现链条已就位）。允许的手段限定在**减容**：

1. 组数打到平时的 **60~70%**
2. **不追加重**（`suggest_kg` 不上调）
3. 换轻量变体（同肌群的替代动作）
4. 挪训练日（避开最难受的那天）

**红线不变**：特殊情况**不产生 `avoid` 硬约束**，也就是不出现「因为经期所以把深蹲删了」。
（现有红线：旧伤/特殊情况只作背景，不得禁用动作。）

**本地兜底路径的减容是机械的**（没有 AI 判断「经期第三天最难受」）：
`组数 × 0.6`、重量不上调、不换动作。UI 上要明说「本次是规则兜底，减容按统一比例」，
别让用户以为 AI 判断过了。

---

## 6. 什么时候**必须**重新全量生成（模板作废）

| # | 场景 | 行为 |
|---|---|---|
| 1 | 周期第 1 周 | 本来就没有模板 |
| 2 | 周期目标被「解锁」改过（`force_edited_at IS NOT NULL`） | 目标变了 → 模板作废，重新全量 |
| 3 | 上一周计划被删 / 取消 / 不在本周期 | 回落全量 |
| 4 | 用户显式点「重新全量生成」 | 见 §7 的入口设计 |
| 5 | 第 4 周（减量周） | **不必**全量 —— 模板平移 + `isDeload` 减量，本地就能做 |

---

## 7. 改动清单（最小面）

| 文件 | 改动 |
|---|---|
| `server/ai/prompts/planFromTemplate.md` | **新增**，短 prompt：模板 + 增量要求 |
| `server/ai/gateway.ts` | 新增 `generatePlanFromTemplate({ template, digest })`，复用现有重试/熔断骨架 |
| `server/ai/digest.ts` | 新增 `buildTemplateDigest()` —— 模板 + 本周特殊情况 + progression + findings，**不带全量候选池** |
| `server/ai/schemas.ts` | `PLAN_FROM_TEMPLATE_INPUT_VERSION = 1`；**输出 schema 复用现有那份** |
| `server/plan/planService.ts` | `templateFor()` / `draftFromTemplate()`；`createPlanFromAi` 里分叉 |
| `server/api/routes/plan.ts` | `POST /api/plans/generate` 加 `mode?: 'auto'\|'full'`；响应加 `used_template: boolean` |
| `src/components/plan/PlanBoard.tsx` | 生成按钮**下方一行小字**「本次：基于第 N 周模板调整」；「重新全量生成」塞进旁边的小链接 |

**按钮仍然只有一个**（用户明确：「下面直接就是生成计划就行了，就有一个生成的那个按钮」）。
「重新全量生成」不做第二个大按钮，做成一行文字链接，且默认不用。

---

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| 模板把上周手改的怪东西固化 4 周 | 第 1 周的模板就是用户自己改的，本来就该固化；改周期目标 = 重新全量 |
| 动作 4 周不变 → 适应性停滞 | 用户已定案「允许四周计划相同」；进步靠**重量**递增体现 |
| AI 借模板偷懒不改 | prompt 要求逐条给 why；validator 仍查硬约束 / 时长区间 / 增重基准 |
| 增重照抄模板里的重量 | **写入前本地覆盖**：重量一律取 `progression.suggest_kg`，不采信 AI 或模板里的数字 |
| 模板对应周不在周期内 | 取「周期内该周之前那一周」；取不到就回落全量（§6.3） |

---

## 9. 验收标准（实施后按这个验）

- 第 1 周：`used_template=false`，payload 与现在同量级（V6 实测 13.8~13.9KB）
- 第 2~3 周：`used_template=true`，**payload ≤4KB**；动作集合与第 1 周 **≥80% 重合**；重量 = `suggest_kg`
- 第 4 周：`is_deload=true`，容量约为第 3 周的 50~60%，重量不上调
- 填了特殊情况：组数下降，且**没有任何动作被禁用**（红线：特殊情况不产生 avoid）
- 把上一周计划删掉后点生成：自动回落全量，**不报错**

---

## 10. 明确不做

- 不做 diff / patch 输出协议
- 不建 `cycle_template` 新表
- 不做「模板可视化编辑器」（首页那份草稿就是编辑器）
- 不做「每周自动生成」（自动只到草稿，且仍然要人点一次 —— 现有语义不变）

---

## 11. 实施记录与实测（2026-09-30）

### 落点（与 §7 清单的差异）

| §7 计划 | 实际做法 | 为什么 |
|---|---|---|
| `gateway.generatePlanFromTemplate(...)` 新方法 | **不新增方法**，改为 `generatePlan(input)` 内部按 `input.template` 分叉 | `PlanGenerationInput` 本来就能带 `template`；少一个接口方法 = 少一处要同步的熔断骨架 |
| `PLAN_FROM_TEMPLATE_INPUT_VERSION = 1` | **不新增版本号**，复用 `PLAN_INPUT_SCHEMA_VERSION`（本轮 3.2 → **3.3**） | 模板路径的 digest 与全量是同一张表同一个 schema，只是字段被清空；两个版本号只会互相打架 |
| `planService` 里 `draftFromTemplate()` | 落在 `server/plan/template.ts` 的 `buildDraftFromCycleTemplate()` | 它是**规则兜底**，跟 `buildTemplateDraft` 是同一类东西，放一起才看得懂 |
| —— | **新增 schema v8**：`plan.template_week_no INTEGER` | 「本次是不是沿用了模板」事后**无法现算**（用户点过「重新全量生成」、上一周计划被删过都会让现算结果错），必须落库 |

### 新增/改动文件

- 新增 `server/ai/prompts/planFromTemplate.md`、`server/plan/cycleTemplate.ts`
- 新增 `buildTemplateDigest()`（`server/ai/digest.ts`）、`buildDraftFromCycleTemplate()`（`server/plan/template.ts`）、`applySuggestedWeights()`（`server/plan/planService.ts`）
- 新增 `dowOfDateStr` / `datestrForDow`（`server/util/dates.ts`，放 digest 与 cycleTemplate 共用，避免循环依赖）
- 新增路由参数 `mode: 'auto' \| 'full'` 与响应字段 `used_template` / `template_week_no`
- `src/components/plan/PlanBoard.tsx`：标题旁一行「本次沿用周期第 N 周模板」+ 一个「重新全量生成」文字链接

### 实测（真实库副本，2026-09-30）

| 项 | 实测 |
|---|---|
| 全量 digest | **13.94 KB**（池 30 / 画像 16 / findings 8） |
| 模板路径发给 AI 的合计 | **7.99 KB**（精简 digest 5.52 KB + 模板本体 2.45 KB），**省 43%** |
| 模板平移 | 3 天 → `2026-10-05 / 10-07 / 10-09`，星期几与第 1 周完全一致 |
| 重量 | 12 个动作**全部**等于 `suggest_kg`（AI 故意给 +3kg 也被覆盖） |
| `mode='full'` | `used_template=false`、`template_week_no=null`、AI 收到的输入里没有 template |
| 上一周计划被删 | 自动回落全量、HTTP 200、**不报错** |
| 非法 mode | HTTP 400（在缺 AI 依赖之前就拦掉） |

### 顺带修掉的一个真 bug（冒烟才发现）

`persistDraftInner` 的 INSERT 曾经**写死 `version_no = 1`**，而 `plan` 有 `UNIQUE (week_start, version_no)`。
v2「单版本覆盖」只覆盖 **draft**，已 approved / 已写入的那份要留着，于是必然新起一行 → 撞唯一约束 → **HTTP 500**。

真实可复现路径：**生成 → 导入训记（status=written）→ 回首页点「重新生成」**。
（在这次冒烟里就复现了：副本库里 2026-09-28 那周已经有一份 `partial` 计划。）

修法：`version_no` 改为 `SELECT COALESCE(MAX(version_no), 0) + 1 FROM plan WHERE week_start = ?`。
回归用例见 `tests/plan.test.ts` 的「单版本覆盖的边界：同周已有非草稿计划」。
