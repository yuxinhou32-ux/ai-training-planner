import { sanitize } from '../shared/logger.js';
import type { XunjiEnvelope } from './types.js';
import { parseRetryMs } from './ratelimit.js';

/**
 * 错误归一（§6.4 错误码处理矩阵，T1）。
 *
 * kind → 同步引擎的处理策略：
 *   'fatal'     不重试，终止整轮并通知（apikey missing/invalid、仅 VIP）
 *   'ratelimit' 三源取等待值，写 next_retry_at，移队尾；**不消耗重试次数**
 *   'retryable' 指数退避（30s 起，上限 300s），消耗重试次数，上限 5 次
 *   'failed'    该天直接标记失败（4xx 未知 / success!==true / 解析失败）
 */
export type XunjiErrorKind = 'fatal' | 'ratelimit' | 'retryable' | 'failed';

export type XunjiErrorCode =
  | 'API_KEY_MISSING'
  | 'API_KEY_INVALID'
  | 'VIP_REQUIRED'
  | 'TOO_FREQUENT'
  | 'NETWORK_ERROR'
  | 'HTTP_5XX'
  | 'HTTP_4XX'
  | 'JSON_PARSE'
  | 'UNKNOWN_API_ERROR';

export class XunjiError extends Error {
  readonly code: XunjiErrorCode;
  readonly kind: XunjiErrorKind;
  /** ① 响应内解析出的等待毫秒（仅 ratelimit；null = 响应里没给）。 */
  retryMs: number | null;
  readonly httpStatus: number;
  /** 原始响应信封（已可安全序列化；不含请求头，Key 不在其中）。 */
  readonly raw: unknown;

  constructor(opts: {
    code: XunjiErrorCode;
    kind: XunjiErrorKind;
    message: string;
    retryMs?: number | null;
    httpStatus?: number | null;
    raw?: unknown;
  }) {
    super(sanitize(opts.message));
    this.name = 'XunjiError';
    this.code = opts.code;
    this.kind = opts.kind;
    this.retryMs = opts.retryMs ?? null;
    this.httpStatus = opts.httpStatus ?? 0;
    this.raw = opts.raw ?? null;
  }
}

const FATAL_EXIT_MESSAGE: Record<string, string> = {
  API_KEY_MISSING: '未配置训记 API Key，请到设置页配置（XUNJI_API_KEY）',
  API_KEY_INVALID: 'API Key 无效，请重新配置（训记 App 内重新生成）',
  VIP_REQUIRED: '该接口仅训记 VIP 可用，请确认账号状态',
};

/** 面向用户的中文文案（§6.4 矩阵最后一列）。 */
export function userMessageOf(e: XunjiError): string {
  return FATAL_EXIT_MESSAGE[e.code] ?? e.message;
}

/**
 * 在响应 JSON 里收集可疑错误文本（自探针脚本移植，防御性遍历所有字符串）。
 * 读取限频文本在 `res`（字符串字段）、写回在 `error` —— 全字符串收集天然兼容两处。
 */
function findErrorMessages(node: unknown, depth = 0): string[] {
  const out: string[] = [];
  if (depth > 6 || node === null || node === undefined) return out;
  if (typeof node === 'string') return [node];
  if (typeof node === 'object') {
    if (Array.isArray(node)) {
      for (const item of node) out.push(...findErrorMessages(item, depth + 1));
    } else {
      for (const v of Object.values(node as Record<string, unknown>)) {
        out.push(...findErrorMessages(v, depth + 1));
      }
    }
  }
  return out;
}

/**
 * 响应分类（§6.4 矩阵）。成功返回 null；失败返回已归一的 XunjiError。
 * 判定顺序：解析失败 → apikey missing → apikey invalid → VIP → too frequent
 *           → success===true → 5xx → 4xx → success===false → **兜底成功**。
 *
 * 🔴 实测关键（probe-report §2 / data/probe/*.json）：成功响应外壳是
 *    `{ res: {...} }`，**没有顶层 success 字段**；`success===false` 才是错误。
 *    因此「success 缺失」按成功处理，结构合法性由 reader 的 res/trains 校验兜底。
 */
export function classifyResponse(
  httpStatus: number,
  json: unknown,
  jsonParseError: string | null,
): XunjiError | null {
  if (jsonParseError !== null) {
    return new XunjiError({
      code: 'JSON_PARSE',
      kind: 'failed',
      message: `响应不是合法 JSON：${jsonParseError}（原始文本已留证 raw_train_raw）`,
      httpStatus,
      raw: null,
    });
  }

  const envelope: XunjiEnvelope = typeof json === 'object' && json !== null ? (json as XunjiEnvelope) : {};
  const messages = findErrorMessages(envelope);
  const joined = messages.join(' | ');
  const successFlag = envelope.success;

  // 判定顺序：先具体权限类，再限频，再按 success / HTTP 状态兜底
  if (/apikey\s*is\s*missing|apikey\s*missing/i.test(joined)) {
    return new XunjiError({
      code: 'API_KEY_MISSING',
      kind: 'fatal',
      message: '服务端未识别到 API Key（apikey missing）',
      httpStatus,
      raw: envelope,
    });
  }
  if (/apikey\s*invalid|invalid\s*apikey|key\s*无效/i.test(joined)) {
    return new XunjiError({
      code: 'API_KEY_INVALID',
      kind: 'fatal',
      message: 'API Key 无效（apikey invalid）',
      httpStatus,
      raw: envelope,
    });
  }
  if (/\bvip\b/i.test(joined)) {
    return new XunjiError({
      code: 'VIP_REQUIRED',
      kind: 'fatal',
      message: '该接口仅 VIP 可用（账号权限不足）',
      httpStatus,
      raw: envelope,
    });
  }
  if (/too\s*frequent|频繁/i.test(joined)) {
    // 🔴 双字段解析兜底：读取限频文本实测在 res，写回在 error（§6.4）
    const hint = parseRetryMs(envelope.res) ?? parseRetryMs(envelope.error);
    return new XunjiError({
      code: 'TOO_FREQUENT',
      kind: 'ratelimit',
      message: `读取过于频繁，被限频（${joined || 'too frequent'}${hint !== null ? `，提示等待 ${Math.round(hint / 1000)}s` : ''}）`,
      retryMs: hint,
      httpStatus,
      raw: envelope,
    });
  }

  // success 显式为 true 时以响应体为准（HTTP 状态即使异常也判成功）
  if (successFlag === true) return null;

  if (httpStatus >= 500) {
    return new XunjiError({
      code: 'HTTP_5XX',
      kind: 'retryable',
      message: `服务端错误（HTTP ${httpStatus}）${joined ? `：${joined}` : ''}`,
      httpStatus,
      raw: envelope,
    });
  }
  if (httpStatus >= 400) {
    return new XunjiError({
      code: 'HTTP_4XX',
      kind: 'failed',
      message: `HTTP 错误 ${httpStatus}：${joined || '(无错误文本)'}`,
      httpStatus,
      raw: envelope,
    });
  }
  if (successFlag === false) {
    // success !== true 且无已知模式（§6.4「未知错误」行：不重试，标记 failed）
    return new XunjiError({
      code: 'UNKNOWN_API_ERROR',
      kind: 'failed',
      message: `服务返回未知错误（success = false）：${joined || '(响应中没有可读的错误文本)'}`,
      httpStatus,
      raw: envelope,
    });
  }
  // success 字段缺失（实测成功形态 { res: {...} }）→ 按成功；
  // res/trains 结构校验在 reader，异常结构照样会被拒绝。
  return null;
}
