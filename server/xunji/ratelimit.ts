/**
 * 限频与退避（§6.2.2，T1）。
 *
 * 🔴 冷却时长三源优先级（读取侧）：
 *   ① 响应内解析值 —— 正则从限频文本提取（读取在 res 字段、写回在 error 字段，
 *      parseRetryMs 对两个字段都要试）；
 *   ② res.limits 常量（缓存于 app_config，缺失时用实测默认 30s）；
 *   ③ 90s 硬编码兜底 —— 仅当 limits 结构变化（①② 都失效）时使用。
 */
import { BACKOFF_BASE_MS, BACKOFF_CAP_MS, COOL_DOWN_MS_FALLBACK, READ_COOL_DOWN_MS } from '../config/constants.js';
import type { XunjiLimits } from './types.js';

/**
 * 解析 "too frequent, retry after 30s" → 30000。
 * 限频文本的字段位置不对称（实测）：读取在 `res`、写回在 `error` —— 调用侧两处都要看。
 * 单位兼容：`\d+s` 为主（实测），分钟/毫秒顺带支持；解析不出返回 null。
 */
export function parseRetryMs(payload: unknown): number | null {
  if (typeof payload !== 'string') return null;
  const m = /retry\s+after\s+(\d+(?:\.\d+)?)\s*(h|ms|s|sec|secs|second|seconds|min|mins|minute|minutes)?/i.exec(
    payload,
  );
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] ?? 's').toLowerCase();
  let ms: number;
  if (unit === 'ms') ms = n;
  else if (unit === 'h') ms = n * 3_600_000;
  else if (unit.startsWith('min')) ms = n * 60_000;
  else ms = n * 1000;
  // 上限 10 分钟：服务端提示再长也不值得等（直接走下一轮调度）
  return Math.min(Math.round(ms), 600_000);
}

/** 网络类错误的指数退避：起点 30s（对齐读侧冷却），×2 递增，上限 300s。 */
export function backoffMs(attempts: number): number {
  const a = Math.max(1, attempts);
  return Math.min(BACKOFF_BASE_MS * Math.pow(2, a - 1), BACKOFF_CAP_MS);
}

/**
 * 三源之②/③：从 res.limits 缓存推导读侧冷却。
 * - 无缓存 → ② 默认实测值 30s（READ_COOL_DOWN_MS）；
 * - 缓存存在但冷却字段缺失（结构变化）→ ③ 90s 兜底。
 */
export function readCooldownMs(limits: XunjiLimits | null): number {
  if (!limits) return READ_COOL_DOWN_MS;
  const s =
    typeof limits.readRateLimitSecondsFull === 'number' && limits.readRateLimitSecondsFull > 0
      ? limits.readRateLimitSecondsFull
      : typeof limits.readRateLimitSeconds === 'number' && limits.readRateLimitSeconds > 0
        ? limits.readRateLimitSeconds
        : null;
  if (s === null) return COOL_DOWN_MS_FALLBACK;
  return Math.min(s * 1000, 600_000);
}

/** 三源合成：① 响应解析值 ?? ② limits 缓存/默认 ?? ③ 90s。 */
export function resolveRetryMs(hintMs: number | null, limits: XunjiLimits | null): number {
  if (hintMs !== null && hintMs > 0) return hintMs;
  return readCooldownMs(limits);
}
