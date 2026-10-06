import path from 'node:path';
import {
  DB_PATH_DEFAULT,
  HTTP_TIMEOUT_MS_DEFAULT,
  SYNC_DEFAULT_CONCURRENCY,
  XUNJI_BASE_URL,
} from './constants.js';

/**
 * 应用配置（T1）。来源优先级：进程环境变量 > 默认常量。
 * Key 只存在于进程内存（§6.1），本模块不提供任何把它落盘的途径。
 */
export type AiMode = 'http' | 'off';

export interface AppConfig {
  /** 训记 API 基址。 */
  xunjiBaseUrl: string;
  /** 训记 API Key（来自 XUNJI_API_KEY；未配置时为 null）。 */
  apiKey: string | null;
  /** 单次 HTTP 超时（ms）。 */
  httpTimeoutMs: number;
  /** SQLite 数据文件绝对路径。 */
  dbPath: string;
  /** 同步并发度（1~4）。 */
  syncConcurrency: number;
  /** AI 调用模式（V4）：http = 走 OpenAI 兼容端点；off = 显式关闭（即使有 Key 也不调用）。 */
  aiMode: AiMode;
  /** LLM API Key（来自 LLM_API_KEY；未配置时为 null）。 */
  llmApiKey: string | null;
  /** LLM 兼容 API 基址（来自 LLM_BASE_URL；默认 DeepSeek）。 */
  aiBaseUrl: string;
  /** LLM 模型名（来自 LLM_MODEL；默认 deepseek-flash）。 */
  aiModel: string;
  /** 输出上限（DeepSeek JSON 模式官方要求显式设置，否则 JSON 可能被截断）。 */
  aiMaxTokens: number;
  /** 采样温度：结构化输出要稳，默认 0.3。 */
  aiTemperature: number;
  /** LLM 单次调用超时（ms）。 */
  aiTimeoutMs: number;
}

export interface EnvSource {
  XUNJI_API_KEY?: string | undefined;
  XUNJI_BASE_URL?: string | undefined;
  ATP_DB_PATH?: string | undefined;
  ATP_HTTP_TIMEOUT_MS?: string | undefined;
  ATP_SYNC_CONCURRENCY?: string | undefined;
  LLM_MODE?: string | undefined;
  LLM_BASE_URL?: string | undefined;
  LLM_MODEL?: string | undefined;
  LLM_API_KEY?: string | undefined;
  LLM_MAX_TOKENS?: string | undefined;
  LLM_TEMPERATURE?: string | undefined;
  ATP_AI_TIMEOUT_MS?: string | undefined;
}

/** DeepSeek 官方默认值（https://api-docs.deepseek.com/zh-cn）。 */
export const AI_BASE_URL_DEFAULT = 'https://api.deepseek.com';
export const AI_MODEL_DEFAULT = 'deepseek-flash';

/**
 * 单次回复的 token 上限。
 *
 * 🔴 **它是「含推理内容」的总预算，不是「写 JSON 的预算」** —— 这是本项目踩过最贵的一个坑。
 *
 * 实测（2026-09-30，deepseek-flash，3 天周计划）：
 *   completion_tokens = 10479，其中 reasoning_tokens = 7711（74%），真正的 JSON 只占 2768。
 * 原来的默认值 8192 会在第 3 天中间被硬切断（finish_reason=length）→ JSON 解析失败 →
 * 3 次重试全废 → 降级规则模板。**连续采样 5 轮，AI 排计划 0 次成功**，
 * 而表面症状是「空 content / 不是合法 JSON」，看起来像端点不稳或模型不听话，其实只是预算不够。
 * 提到 32768 后一次通过（finish_reason=stop，content 6732 字符）。
 *
 * 上限只在触碰时才计费，所以给大不浪费钱；给小则必然偶发截断。
 */
export const AI_MAX_TOKENS_DEFAULT = 32768;

function toPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** 温度解析：0 是合法值，不能用 falsy 判断。 */
function toTemperature(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 2 ? n : fallback;
}

/** 解析配置。env 默认取 process.env；测试可显式注入。 */
export function loadConfig(env: EnvSource = process.env, cwd: string = process.cwd()): AppConfig {
  const apiKeyRaw = env.XUNJI_API_KEY ?? null;
  const apiKey = apiKeyRaw !== null && apiKeyRaw.trim() !== '' ? apiKeyRaw.trim() : null;

  const llmKeyRaw = env.LLM_API_KEY ?? null;
  const llmApiKey = llmKeyRaw !== null && llmKeyRaw.trim() !== '' ? llmKeyRaw.trim() : null;

  const dbPathRaw = env.ATP_DB_PATH?.trim() || DB_PATH_DEFAULT;
  const dbPath = path.isAbsolute(dbPathRaw) ? dbPathRaw : path.resolve(cwd, dbPathRaw);

  // 只有显式写 off 才关闭；其它任何值（含未配置）都按 http 处理（V4 默认）
  const aiMode: AiMode = env.LLM_MODE?.trim().toLowerCase() === 'off' ? 'off' : 'http';

  return {
    xunjiBaseUrl: env.XUNJI_BASE_URL?.trim() || XUNJI_BASE_URL,
    apiKey,
    httpTimeoutMs: toPositiveInt(env.ATP_HTTP_TIMEOUT_MS, HTTP_TIMEOUT_MS_DEFAULT),
    dbPath,
    syncConcurrency: Math.min(4, Math.max(1, toPositiveInt(env.ATP_SYNC_CONCURRENCY, SYNC_DEFAULT_CONCURRENCY))),
    aiMode,
    llmApiKey,
    aiBaseUrl: env.LLM_BASE_URL?.trim() || AI_BASE_URL_DEFAULT,
    aiModel: env.LLM_MODEL?.trim() || AI_MODEL_DEFAULT,
    aiMaxTokens: toPositiveInt(env.LLM_MAX_TOKENS, AI_MAX_TOKENS_DEFAULT),
    aiTemperature: toTemperature(env.LLM_TEMPERATURE, 0.3),
    aiTimeoutMs: toPositiveInt(env.ATP_AI_TIMEOUT_MS, 120_000),
  };
}
