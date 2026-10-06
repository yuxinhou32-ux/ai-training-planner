/**
 * AI 层 zod schema + 输入/输出类型（M19，§1.3 / §5.2~§5.5）。
 *
 * D12 纪律（类型签名即为纪律）：PlanGenerationInput 等输入类型不含任何
 * repository / train_session 句柄——想违规投喂原始数据必须先改本文件，
 * 属于 code review 可拦截的显式变更。
 *
 * V5（§5.6.1）：全部输出 schema 使用 strict——AI 输出里的未知字段一律拒绝。
 */
import { z } from 'zod';
import type { AnalysisReport } from '../analysis/reportSchema.js';
import type { PlanInputDigest } from './digest.js';

export const AI_ROLES = [
  'data_analyst',
  'plan_generator',
  'plan_from_template',
  'plan_explainer',
  'review_summarizer',
  'weekly_reviewer',
] as const;
export type AiRole = (typeof AI_ROLES)[number];

/** 角色 → prompt 文件（§2.1 M18；文件名按 §1.4 目录树）。 */
export const PROMPT_FILE: Record<AiRole, string> = {
  data_analyst: 'dataAnalyst.md',
  plan_generator: 'planGenerator.md',
  /**
   * 周期第 2~4 周：沿用上一周那份计划的结构，只按本周增量调整（2026-09-30 用户定案）。
   * 单独一份 prompt 而不是往 planGenerator 里加分支：这两条路径的输入、任务、纪律都不同，
   * 揉在一起会让「全量生成」那份 prompt 变长，反而两边的 token 都涨。
   */
  plan_from_template: 'planFromTemplate.md',
  plan_explainer: 'planExplainer.md',
  review_summarizer: 'reviewSummarizer.md',
  /** V8：每周一次的简短复盘（达标吗 / 下周微调）。 */
  weekly_reviewer: 'weeklyReviewer.md',
};

// ---------------------------------------------------------------------------
// 计划 summary（§5.6.1「配套设计」：summary 是算出来的，不是校验出来的）
// ---------------------------------------------------------------------------

export interface PlanSummary {
  total_sessions: number;
  total_sets: number;
  est_total_min: number;
  /** 肌群码 → 周有效组（primary ×1、secondary ×0.5，按 movement_muscle_map 权重折算）。 */
  muscle_distribution: Record<string, number>;
}

// ---------------------------------------------------------------------------
// 输入类型（AiGateway 的参数，D12：无 repository 句柄）
// ---------------------------------------------------------------------------

/**
 * 周期上下文（PRD-v2 §5 / V2）。**计划期才有的输入**，不属于分析报告。
 *
 * 与 `constraints.goal.goal_type`（长期目标）语义不同：
 *   - 长期目标 = 背景方向（减脂保肌）
 *   - 周期目标 = 这 4 周的焦点（着重练胸），**优先级更高**
 * 两者一起给 AI，由 AI 在满足硬约束的前提下体现焦点。
 */
export interface PlanCycleContext {
  /** 周期目标文案 */
  goalText: string;
  /** 长期目标（背景参考，优先级低于周期目标） */
  longTermGoal: string | null;
  /** 本周是周期第几周（1~4） */
  weekNo: number;
  totalWeeks: number;
  /** 第 4 周 = 减量周：容量减半、强度降 10%~15% */
  isDeload: boolean;
}

export interface PlanGenerationInput {
  /**
   * 摘要层输出（V3）：训练画像 + 本周切片 + 精选候选池。
   * **AI 的唯一合法输入**——不再是整份 AnalysisReport（66.5 KB → ~11 KB）。
   *
   * 模板路径下这份 digest 是**精简版**（见 `buildTemplateDigest`）：没有 `profile` 画像与
   * `findings`（模板已经承载了长期结构），候选池也只含模板用到的那些动作。
   */
  digest: PlanInputDigest;
  /**
   * 模板路径（周期第 2~4 周）：给了它就切到 `plan_from_template`，让 AI 沿用上一周的结构。
   * 不给 = 全量生成（周期第 1 周、模板缺失、用户显式要求重新全量）。
   */
  template?: PlanTemplate;
}

// ---------------------------------------------------------------------------
// 周期模板（2026-09-30 用户定案：「周期内同一个模板」）
// ---------------------------------------------------------------------------

/**
 * 模板里的一个动作。
 *
 * `suggest_kg` / `progression_action` 是**系统本地算好的本周建议**（V5）——
 * 直接放进模板，AI 不必再去候选池里查一遍；模板里的 `weight_kg` 只是「上一周实际用的」，
 * **不得照抄**（减量周、上周未达成都会让它过时）。
 */
export interface PlanTemplateExercise {
  name: string;
  catalog_id: number;
  /** 上一周的组数（本周可沿用；特殊情况要减容时在它基础上打折） */
  sets: number;
  reps: number | null;
  rest_s: number | null;
  /** 有氧动作标记（照抄即可，不要让 AI 自己判断） */
  is_cardio: boolean;
  /** 上一周实际写的重量（仅供理解上下文，不要照抄） */
  last_week_weight_kg: number | null;
  /** 本周建议重量（本地算好，0.5 刻度；null = 无历史数据） */
  suggest_kg: number | null;
  progression_action: string;
}

export interface PlanTemplateDay {
  /**
   * **平移后**的本周日期（YYYY-MM-DD）。
   * 由服务端按「上一周那天的星期几」映射到本周，AI 不需要做任何日期算术。
   */
  datestr: string;
  day_type: string;
  title: string;
  target_muscles: string[];
  exercises: PlanTemplateExercise[];
}

export interface PlanTemplate {
  /** 模板来源周（周期内的上一周） */
  source_week_start: string;
  source_week_end: string;
  /** 来源周在周期内的周次（1~4），供 AI 说「沿用第 N 周」 */
  source_week_no: number;
  days: PlanTemplateDay[];
}

export interface PlanExplainInput {
  plan: PlanDraft;
  /** 系统从 plan 确定性计算的 summary；A3 的一切计划侧汇总数字只能引用此处。 */
  planSummary: PlanSummary;
  report: AnalysisReport;
  /** 上一版计划的 summary，用于说明差异，可为空。 */
  previousPlanSummary: PlanSummary | null;
}

export interface ReviewInput {
  /** 4 周周期数据总结（§5.5 输入契约；固定日口径 + 弹性日单列）。 */
  dataSummary: Record<string, unknown>;
  report: AnalysisReport;
  previousReviewSuggestions: string[];
}

/**
 * 周复盘输入（V8）。**注意与 ReviewInput 的区别**：
 *   - ReviewInput：4 周窗口 + 整份分析报告 → 中期总结
 *   - WeeklyReviewInput：**只有 1 周**的结构化事实 + 用户自己写的感受。**不给报告** ——
 *     一周的复盘不需要 12 周的画像，给了只会让输出变长（用户明确要求「复盘要简短」）。
 */
export interface WeeklyReviewInput {
  /** 本地确定性算好的周事实（完成率 / 每天练没练 / 未达成动作）。 */
  weekSummary: Record<string, unknown>;
  /** 用户这一周写的日感受（按日期升序），可能为空数组。 */
  notes: Array<{ datestr: string; text: string }>;
  /** 本周所属周期目标（如「着重练胸」），无周期时为 null。 */
  cycleGoal: string | null;
}

// ---------------------------------------------------------------------------
// AiGateway 接口（§1.3）
// ---------------------------------------------------------------------------

/** V4-WARN 熔断放行时的告警条目（写入 plan.warnings_json）。 */
export interface DurationWarning {
  code: 'DURATION_OUT_OF_RANGE';
  datestr: string;
  value: number;
  range: [number, number];
}

export type PlanGenerationResult =
  | {
      status: 'accepted';
      draft: PlanDraft;
      summary: PlanSummary;
      warnings: DurationWarning[];
      /** V2 数值钳制记录（审计用，非违规）。 */
      clamped: string[];
      attempts: number;
    }
  | {
      status: 'rule_fallback';
      /**
       * ai_unavailable = 缺配置 / Key 无效 / 超时 / 连接失败（重试无意义）
       * ai_transient  = 整轮都是可重试故障（空 content / 429 / 5xx），V4 新增
       * v4_block_after_retries = 模型有输出但始终违反硬校验
       */
      reason: 'v4_block_after_retries' | 'ai_unavailable' | 'ai_transient';
      attempts: number;
      lastViolations: Violation[];
    };

export interface AiGateway {
  generatePlan(input: PlanGenerationInput): Promise<PlanGenerationResult>;
  explainPlan(input: PlanExplainInput): Promise<PlanExplanation>;
  summarizeReview(input: ReviewInput): Promise<ReviewSummary>;
  /** V8：一周一次的简短复盘（达标吗 / 下周微调）。 */
  summarizeWeek(input: WeeklyReviewInput): Promise<WeeklyReview>;
}

// ---------------------------------------------------------------------------
// A2 输出：PlanDraft（§5.3；只含 days，周级汇总由 summaryBuilder 确定性计算）
// ---------------------------------------------------------------------------

export const evidenceRefSchema = z.object({
  type: z.enum(['movement_trend', 'muscle_trend', 'finding', 'structure', 'basic_stat', 'generic']),
  ref: z.string(),
  text: z.string(),
});

export const exerciseSchema = z
  .object({
    ord: z.number().int(),
    catalog_id: z.number().int(),
    name: z.string().min(1),
    sets: z.number().int().min(1).max(20),
    reps: z.number().int().nullable(),
    weight_kg: z.number().nullable().optional(),
    weight_source: z.enum(['history_best', 'history_avg', 'estimate', 'user_input']).optional(),
    rest_s: z.number().int().nullable().optional(),
    is_cardio: z.boolean(),
    record_preset: z.string().nullable().optional(),
    why: z.string().max(200),
  })
  .strict();

export const planDaySchema = z
  .object({
    datestr: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    day_type: z.string().min(1),
    title: z.string().min(1),
    target_muscles: z.array(z.string()).optional(),
    est_duration_min: z.number().int().min(20).max(180),
    exercises: z.array(exerciseSchema).min(1).max(15),
    why: z
      .object({
        summary: z.string(),
        evidence_refs: z.array(evidenceRefSchema),
      })
      .strict(),
  })
  .strict();

export const planDraftSchema = z
  .object({
    week_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    week_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    days: z.array(planDaySchema).min(1).max(7),
  })
  .strict();

export type PlanDraft = z.infer<typeof planDraftSchema>;
export type PlanDay = z.infer<typeof planDaySchema>;
export type PlanExercise = z.infer<typeof exerciseSchema>;
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;

// ---------------------------------------------------------------------------
// A3 输出：PlanExplanation（§5.4）
// ---------------------------------------------------------------------------

export const planExplanationSchema = z
  .object({
    days: z.array(
      z
        .object({
          datestr: z.string(),
          summary: z.string().max(300),
          evidence_refs: z.array(evidenceRefSchema),
          exercises: z.array(
            z
              .object({
                ord: z.number().int(),
                why: z.string().max(200),
                basis: z.enum(['data', 'generic_principle']),
                evidence_refs: z.array(z.record(z.string(), z.unknown())).optional(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();

export type PlanExplanation = z.infer<typeof planExplanationSchema>;

// ---------------------------------------------------------------------------
// A4 输出：ReviewSummary（§5.5）—— **4 周中期总结，简短版**
// ---------------------------------------------------------------------------

/**
 * 用户明确要求「复盘要简短，不需要复盘很多」。所以：
 *   strengths 1~3 条（原 1~4）、issues ≤2 条（原 ≤4）、suggestions 1~3 条（原 1~4）。
 * 数字本身是长度约束——提高上限只会让模型把话写长。
 */
export const reviewSummarySchema = z
  .object({
    strengths: z
      .array(z.object({ text: z.string().max(120), evidence: z.string() }).strict())
      .min(1)
      .max(3),
    issues: z.array(z.record(z.string(), z.unknown())).max(2),
    suggestions: z
      .array(
        z
          .object({
            text: z.string().max(120),
            action_type: z.enum(['split_change', 'movement_swap', 'volume_change', 'intensity_change', 'deload', 'other']),
            executable: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(3),
  })
  .strict();

export type ReviewSummary = z.infer<typeof reviewSummarySchema>;

// ---------------------------------------------------------------------------
// A5 输出：WeeklyReview（V8）—— 一周一次，必须短
// ---------------------------------------------------------------------------

/**
 * 长度是硬要求，不是建议：用户原话「复盘要简短，不需要复盘很多」。
 * 完成率不由 AI 说 —— 那是本地算好的确定性数字，AI 只给判断与调整。
 */
export const weeklyReviewSchema = z
  .object({
    /** 一句话：这周达标吗、大概什么水平。≤80 字。 */
    verdict: z.string().min(1).max(80),
    /** 下周微调，1~2 条，每条 ≤60 字。必须是可执行的改动，不是鼓励。 */
    adjustments: z.array(z.string().min(1).max(60)).min(1).max(2),
    /** 回应一条用户写的感受（不超过 60 字）；用户没写感受时必须为空字符串。 */
    note_reply: z.string().max(60),
  })
  .strict();

export type WeeklyReview = z.infer<typeof weeklyReviewSchema>;

// ---------------------------------------------------------------------------
// A1 输出：补充结论（§5.2；MVP 默认关闭，schema 先行就位）
// ---------------------------------------------------------------------------

export const aiFindingsSchema = z
  .object({
    findings: z
      .array(
        z
          .object({
            code: z.string().regex(/^R-AI-[0-9]{2}$/),
            severity: z.enum(['info', 'warn', 'high']),
            title: z.string().max(40),
            detail: z.string().max(200),
            evidence: z.object({
              metric: z.string(),
              value: z.unknown(),
              baseline: z.unknown().optional(),
              compare: z.string().optional(),
              window: z.string(),
            }),
            suggestion: z.string().optional(),
            priority: z.number().int().min(1).max(5),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();

// ---------------------------------------------------------------------------
// V1~V5 校验结果类型（§5.6）
// ---------------------------------------------------------------------------

export type ViolationCheck = 'V1' | 'V2' | 'V3' | 'V4' | 'V5';

export interface Violation {
  check: ViolationCheck;
  level: 'BLOCK' | 'WARN';
  code: string;
  message: string;
  /** 结构化明细（如时长违规的 {datestr, value, range}），供熔断放行时写入 warnings_json。 */
  detail?: Record<string, unknown>;
}
