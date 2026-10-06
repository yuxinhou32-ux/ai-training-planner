/**
 * 统一 AI 入口（M16，§1.5 / §5.6.3）。
 *
 * 实现 AiGateway 接口：OpenAI 兼容 /chat/completions 直连（DeepSeek / 任意兼容端点）。
 * （原 workbuddy 文件契约模式已按 PRD-v2 砍除，2026-09-30）
 *
 * 三段式硬约束注入（§5.3）：① candidate_pool 物理前置过滤（AI 看不到违禁动作）
 * → ② prompt 文本注入用户 hard_rules → ③ V1~V5 输出校验。
 * 熔断状态机（§5.6.3）：最多 3 次尝试；仅剩 V4-WARN 时长违规 → 接受并标注；
 * 仍有 V4-BLOCK 或 AI 不可用 → rule_fallback（由 planService 落规则模板）。
 *
 * D12：本模块输入只有角色化类型，无 repository 句柄；唯一例外是 buildSummary
 * 需要 movement_muscle_map（只读肌群权重，不含任何训练明细）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.js';
import {
  planDraftSchema,
  planExplanationSchema,
  reviewSummarySchema,
  weeklyReviewSchema,
  PROMPT_FILE,
  type AiGateway,
  type AiRole,
  type DurationWarning,
  type PlanDraft,
  type PlanExplainInput,
  type PlanExplanation,
  type PlanGenerationInput,
  type PlanGenerationResult,
  type ReviewInput,
  type ReviewSummary,
  type Violation,
  type WeeklyReview,
  type WeeklyReviewInput,
} from './schemas.js';
import { buildSummary } from './summaryBuilder.js';
import { filterCandidatePool } from './poolFilter.js';
import { refIndexFromDigest, refIndexFromReport, validateDraft, validateExplanation } from './validator.js';
import { todayLocal } from '../plan/planService.js';

export class AiUnavailableError extends Error {}
/**
 * 可重试的 AI 故障（V4）：空 content / 5xx / 429 / 连接失败。
 *
 * 为什么要分开：DeepSeek JSON 模式**官方声明「有概率返回空的 content」**，
 * 属偶发而非不可用。旧实现把它和 401（Key 错）一样当致命错误直接降级到规则模板，
 * 等于把「再问一次就好」的问题变成「这周的计划没有 AI 参与」。
 * 超时不在此列：超时通常是端点慢或网络差，重试只会把等待时间翻三倍。
 */
export class AiTransientError extends AiUnavailableError {}
export class AiValidationError extends Error {
  constructor(message: string, public readonly violations: Violation[]) {
    super(message);
  }
}

export interface AiGatewayOptions {
  /** prompt 模板目录（server/ai/prompts）。 */
  promptsDir: string;
  maxAttempts: number;
  /**
   * 🔴 传**对象引用**而不是值：设置页保存配置时直接 mutate 这个对象即热更新，
   * gateway 每次调用都重新读取（V4）。
   */
  http: {
    mode: 'http' | 'off';
    baseUrl: string;
    model: string;
    apiKey: string | null;
    maxTokens: number;
    temperature: number;
    timeoutMs: number;
  };
  /** 测试注入；缺省用全局 fetch。 */
  fetchImpl?: typeof fetch;
}

const MAX_EXERCISES_PER_DAY = 15;

/** 兼容旧引用（规则模板与测试从本模块取同一份过滤）。实现已移到 poolFilter.ts。 */
export { filterCandidatePool } from './poolFilter.js';

export function createAiGateway(db: Db, opts: AiGatewayOptions): AiGateway {
  const doFetch = opts.fetchImpl ?? fetch;

  // ------------------------------------------------------------------
  // prompt 渲染
  // ------------------------------------------------------------------

  function renderPrompt(role: AiRole, vars: Record<string, string> = {}): string {
    const file = path.join(opts.promptsDir, PROMPT_FILE[role]);
    let text = readFileSync(file, 'utf8');
    for (const [k, v] of Object.entries(vars)) {
      text = text.replaceAll(`{{${k}}}`, v);
    }
    return text;
  }

  /**
   * 周期上下文 → prompt 段落（V2 / V3：数据源改为摘要层的 week 切片）。
   * 周期目标优先级高于长期目标（PRD §5）：用户明确「减脂保肌是长期方向，
   * 这一个周期着重练胸，两者不冲突」。
   */
  function buildCycleContext(cycle: PlanGenerationInput['digest']['week']): string {
    if (cycle.cycle_goal === null) {
      return '（本次未开启训练周期。按长期目标与趋势判定正常安排即可。）';
    }
    const lines: string[] = [];
    lines.push(`- 本周期共 ${cycle.total_weeks} 周，本周是**第 ${cycle.week_no} 周**。`);
    lines.push(
      `- **周期目标（优先级最高，高于长期目标）**：${cycle.cycle_goal}。` +
        '在满足上面全部硬约束的前提下，本周计划必须体现这个焦点：优先给目标肌群安排主项动作与容量，' +
        '并在 why 里说明是如何体现的。',
    );
    if (cycle.long_term_goal) {
      lines.push(`- 长期目标（背景参考，优先级低于周期目标）：${cycle.long_term_goal}。`);
    }
    if (cycle.is_deload) {
      lines.push(
        `- ⚠️ **本周是本周期第 ${cycle.total_weeks} 周 = 减量周**：总容量约为平时的**一半**，` +
          '重量一律取 `progression.suggest_kg`（系统已按上期 −10% 算好），**不得加重**。' +
          '目的是让身体吸收前 3 周的进步。',
      );
    }
    return lines.join('\n');
  }

  /** 用户 hard_rules → 自然语言清单（§5.3 三段式之②）。 */
  function buildUserRules(constraints: PlanGenerationInput['digest']['constraints']): string {
    const lines: string[] = [];
    const goal = constraints.goal;
    if (goal) {
      lines.push(`- 训练日数量必须等于 ${goal.sessions_per_week}；每日时长目标区间 ${goal.min_duration_min}~${goal.max_duration_min} 分钟`);
      if (goal.preferred_dows?.length) {
        const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
        lines.push(`- 用户偏好训练日：${goal.preferred_dows.map((d) => names[d]).join('、')}`);
      }
    }
    for (const r of constraints.hard_rules ?? []) {
      const target = String(r.target_value);
      const reason = r.reason ? `（原因：${r.reason}）` : '';
      if (r.kind === 'keep') lines.push(`- 【保留】动作「${target}」必须出现${reason}`);
      if (r.kind === 'avoid') lines.push(`- 【禁止】动作「${target}」绝对不得出现${reason}`);
      if (r.kind === 'dislike') lines.push(`- 【不喜欢】动作「${target}」不得使用${reason}`);
      if (r.kind === 'limit_load') lines.push(`- 【关节限制】${target} 关节压力不得超过 ${JSON.stringify(r.param ?? {})}${reason}`);
      if (r.kind === 'limit_volume') lines.push(`- 【容量限制】肌群 ${target} 周组数不得超过 ${JSON.stringify(r.param ?? {})}${reason}`);
    }
    return lines.length > 0 ? lines.join('\n') : '-（无附加硬约束）';
  }

  // ------------------------------------------------------------------
  // 三段式之①：candidate_pool 物理前置过滤
  // ------------------------------------------------------------------

  function filterPool(pool: PlanGenerationInput['digest']['candidate_pool'], constraints: PlanGenerationInput['digest']['constraints']): {
    filtered: PlanGenerationInput['digest']['candidate_pool'];
    note: string;
  } {
    return filterCandidatePool(pool, constraints);
  }

  // ------------------------------------------------------------------
  // 双模式 LLM 调用
  // ------------------------------------------------------------------

  function stripFences(text: string): string {
    const t = text.trim();
    const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
    return m ? m[1] : t;
  }

  async function callHttp(system: string, userPayload: unknown): Promise<string> {
    // 每次调用都重新读：设置页保存后立即生效，不用重启进程（V4）
    const { mode, baseUrl, model, apiKey, maxTokens, temperature, timeoutMs } = opts.http;
    if (mode === 'off') throw new AiUnavailableError('AI 已按配置关闭（LLM_MODE=off）');
    if (!baseUrl || !model) {
      throw new AiUnavailableError('AI 未配置完整：需要 LLM_BASE_URL 与 LLM_MODEL');
    }
    // 非本地端点必须有 Key：宁可在这里明确失败，也不要拿一次 401 去换一次无意义的网络请求
    const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(baseUrl);
    if (!apiKey && !local) {
      throw new AiUnavailableError('AI 未配置完整：需要 LLM_API_KEY（非本地端点）');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            // 🔴 紧凑序列化，不要 null,2：摘要层本身 11.4 KB，缩进后变成 18.7 KB（+63%，
            // 每次调用白花约 1800 token）。模型读的是 JSON 结构，不需要给人看的缩进。
            { role: 'user', content: JSON.stringify(userPayload) },
          ],
          response_format: { type: 'json_object' },
          // DeepSeek JSON 模式官方要求显式设 max_tokens，否则 JSON 可能被中途截断
          max_tokens: maxTokens,
          temperature,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        // 429 / 5xx 是服务端临时状态，值得再试；401/402/400 重试没用
        if (res.status === 429 || res.status >= 500) {
          throw new AiTransientError(`LLM HTTP ${res.status}`);
        }
        throw new AiUnavailableError(`LLM HTTP ${res.status}`);
      }
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.trim() === '') {
        throw new AiTransientError('LLM 返回空内容（DeepSeek JSON 模式已知偶发，可重试）');
      }
      return content;
    } catch (e) {
      if (e instanceof AiUnavailableError) throw e;
      // 超时/网络中断：不再重试（会成倍拉长等待），交给上层降级
      const msg = (e as Error).name === 'AbortError' ? `LLM 调用超时（${timeoutMs}ms）` : `LLM 调用失败：${(e as Error).message}`;
      throw new AiUnavailableError(msg);
    } finally {
      clearTimeout(timer);
    }
  }

  async function callLlm(_role: AiRole, system: string, userPayload: unknown): Promise<string> {
    return callHttp(system, userPayload);
  }

  // ------------------------------------------------------------------
  // 生成内核：3 次尝试 + V1~V5 + 熔断（§5.6.3 状态机）
  // ------------------------------------------------------------------

  function v5ViolationsFromZod(issues: Array<{ path: PropertyKey[]; message: string }>): Violation[] {
    return issues.slice(0, 10).map((i) => ({
      check: 'V5' as const,
      level: 'BLOCK' as const,
      code: 'SCHEMA_INVALID',
      message: `字段 ${i.path.map(String).join('.') || '(root)'}: ${i.message}`,
    }));
  }

  function toDurationWarnings(violations: Violation[]): DurationWarning[] {
    return violations
      .filter((x) => x.level === 'WARN' && x.code === 'DURATION_OUT_OF_RANGE')
      .map((x) => {
        const d = x.detail as { datestr?: string; value?: number; range?: [number, number] } | undefined;
        return {
          code: 'DURATION_OUT_OF_RANGE' as const,
          datestr: d?.datestr ?? '',
          value: d?.value ?? 0,
          range: d?.range ?? [0, 0],
        };
      });
  }

  async function generateWithRetry(
    role: AiRole,
    system: string,
    buildPayload: (attempt: number, violations: Violation[]) => unknown,
    ctx: Parameters<typeof validateDraft>[1],
  ): Promise<PlanGenerationResult> {
    let lastViolations: Violation[] = [];
    let sawTransient = false;
    for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
      let raw: string;
      try {
        raw = await callLlm(role, system, buildPayload(attempt, lastViolations));
      } catch (e) {
        // 可重试故障（空 content / 429 / 5xx）：消耗一次尝试再问一遍，最后一次仍失败才降级
        if (e instanceof AiTransientError) {
          sawTransient = true;
          lastViolations = [{ check: 'V5', level: 'BLOCK', code: 'AI_TRANSIENT', message: e.message }];
          continue;
        }
        // 熔断结果 C：AI 完全不可用，直接降级，不消耗剩余重试
        return { status: 'rule_fallback', reason: 'ai_unavailable', attempts: attempt, lastViolations };
      }

      let json: unknown;
      try {
        json = JSON.parse(stripFences(raw));
      } catch {
        lastViolations = [{ check: 'V5', level: 'BLOCK', code: 'NOT_JSON', message: '输出不是合法 JSON（剥除围栏后仍解析失败）' }];
        continue;
      }

      const parsed = planDraftSchema.safeParse(json);
      if (!parsed.success) {
        lastViolations = v5ViolationsFromZod(parsed.error.issues);
        continue;
      }

      const outcome = validateDraft(parsed.data, ctx);
      const blocks = outcome.violations.filter((x) => x.level === 'BLOCK');
      if (blocks.length === 0) {
        const warnings = toDurationWarnings(outcome.violations);
        const summary = buildSummary(db, outcome.draft);
        return {
          status: 'accepted',
          draft: outcome.draft,
          summary,
          warnings,
          clamped: outcome.clamped,
          attempts: attempt,
        };
      }
      lastViolations = outcome.violations;
    }
    // 熔断结果 B：仍有 V4-BLOCK，丢弃（如果整轮都是可重试故障，如实说明原因）
    return {
      status: 'rule_fallback',
      reason: sawTransient && lastViolations.every((v) => v.code === 'AI_TRANSIENT') ? 'ai_transient' : 'v4_block_after_retries',
      attempts: opts.maxAttempts,
      lastViolations,
    };
  }

  // ------------------------------------------------------------------
  // AiGateway 四个方法
  // ------------------------------------------------------------------

  async function generatePlan(input: PlanGenerationInput): Promise<PlanGenerationResult> {
    const { digest } = input;
    const { filtered, note } = filterPool(digest.candidate_pool, digest.constraints);
    const digestForAi = { ...digest, candidate_pool: filtered };

    // ------------------------------------------------------------------
    // 模板路径（周期第 2~4 周，2026-09-30「周期内同一个模板」）
    //
    // 走的仍是**同一套** 3 次重试 + V1~V5 熔断 + `planDraftSchema` ——
    // 换的只是 prompt 与「多带一个 template」。省 token 靠输入瘦身（14 KB → ~6 KB），
    // 不靠输出改协议（不引入 diff/patch，那要新 schema + 新校验 + 合并回滚）。
    // ------------------------------------------------------------------
    if (input.template) {
      const system = renderPrompt('plan_from_template', {
        USER_HARD_RULES: buildUserRules(digest.constraints),
        FILTERED_NOTE: note,
        CYCLE_CONTEXT: buildCycleContext(digest.week),
      });
      return generateWithRetry(
        'plan_from_template',
        system,
        (attempt, violations) => ({
          digest: digestForAi,
          template: input.template,
          ...(attempt > 1 && violations.length > 0
            ? { correction_hints: { message: '你上一轮输出违反了以下校验，请逐条修正后重新输出完整 JSON：', violations } }
            : {}),
        }),
        {
          pool: filtered,
          constraints: digest.constraints,
          refs: refIndexFromDigest(digest),
          todayStr: todayLocal(),
        },
      );
    }

    const system = renderPrompt('plan_generator', {
      USER_HARD_RULES: buildUserRules(digest.constraints),
      FILTERED_NOTE: note,
      CYCLE_CONTEXT: buildCycleContext(digest.week),
    });
    return generateWithRetry(
      'plan_generator',
      system,
      (attempt, violations) => ({
        digest: digestForAi,
        ...(attempt > 1 && violations.length > 0
          ? { correction_hints: { message: '你上一轮输出违反了以下校验，请逐条修正后重新输出完整 JSON：', violations } }
          : {}),
      }),
      {
        pool: filtered,
        constraints: digest.constraints,
        refs: refIndexFromDigest(digest),
        todayStr: todayLocal(),
      },
    );
  }

  async function explainPlan(input: PlanExplainInput): Promise<PlanExplanation> {
    const system = renderPrompt('plan_explainer');
    const raw = await callLlm('plan_explainer', system, {
      plan: input.plan,
      plan_summary: input.planSummary,
      report: input.report,
      previous_plan_summary: input.previousPlanSummary,
    });
    let json: unknown;
    try {
      json = JSON.parse(stripFences(raw));
    } catch {
      throw new AiValidationError('解释输出不是合法 JSON', [
        { check: 'V5', level: 'BLOCK', code: 'NOT_JSON', message: 'parse failed' },
      ]);
    }
    const parsed = planExplanationSchema.safeParse(json);
    if (!parsed.success) {
      throw new AiValidationError('解释输出不符合 schema', v5ViolationsFromZod(parsed.error.issues));
    }
    const violations = validateExplanation(parsed.data, refIndexFromReport(input.report));
    const blocks = violations.filter((x) => x.level === 'BLOCK');
    if (blocks.length > 0) {
      throw new AiValidationError('解释输出未通过 evidence 校验', blocks);
    }
    return parsed.data;
  }

  async function summarizeReview(input: ReviewInput): Promise<ReviewSummary> {
    const system = renderPrompt('review_summarizer');
    const raw = await callLlm('review_summarizer', system, {
      data_summary: input.dataSummary,
      report: input.report,
      previous_review_suggestions: input.previousReviewSuggestions,
    });
    let json: unknown;
    try {
      json = JSON.parse(stripFences(raw));
    } catch {
      throw new AiValidationError('复盘输出不是合法 JSON', [
        { check: 'V5', level: 'BLOCK', code: 'NOT_JSON', message: 'parse failed' },
      ]);
    }
    const parsed = reviewSummarySchema.safeParse(json);
    if (!parsed.success) {
      throw new AiValidationError('复盘输出不符合 schema', v5ViolationsFromZod(parsed.error.issues));
    }
    return parsed.data;
  }

  /** V8：一周一次的简短复盘。输入只有一周事实 + 用户感受，刻意不给分析报告（那会让输出变长）。 */
  async function summarizeWeek(input: WeeklyReviewInput): Promise<WeeklyReview> {
    const system = renderPrompt('weekly_reviewer');
    const raw = await callLlm('weekly_reviewer', system, {
      week_summary: input.weekSummary,
      notes: input.notes,
      cycle_goal: input.cycleGoal,
    });
    let json: unknown;
    try {
      json = JSON.parse(stripFences(raw));
    } catch {
      throw new AiValidationError('周复盘输出不是合法 JSON', [
        { check: 'V5', level: 'BLOCK', code: 'NOT_JSON', message: 'parse failed' },
      ]);
    }
    const parsed = weeklyReviewSchema.safeParse(json);
    if (!parsed.success) {
      throw new AiValidationError('周复盘输出不符合 schema', v5ViolationsFromZod(parsed.error.issues));
    }
    // 用户没写感受时强行要求 note_reply 为空 —— 模型很容易忍不住「回应」一句空气。
    if (input.notes.length === 0 && parsed.data.note_reply !== '') {
      return { ...parsed.data, note_reply: '' };
    }
    return parsed.data;
  }

  return { generatePlan, explainPlan, summarizeReview, summarizeWeek };
}

export { MAX_EXERCISES_PER_DAY };
