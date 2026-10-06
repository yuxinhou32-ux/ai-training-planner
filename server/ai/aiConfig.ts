/**
 * AI 配置（V4）：读 / 写 / 热更新。
 *
 * 三条红线（PRD-v2 §10.3 V4）：
 *  1. 🔴 **Key 只能进 `.env`，不得入库**。本模块唯一写目标是 `.env` 文件（原子替换），
 *     数据库、job 记录、日志、API 响应里都不出现 Key；
 *  2. **API 只回传掩码**（`****后四位`），且永远不回传明文；
 *  3. 改配置**立即生效**：`AiRuntime.http` 是同一个对象引用，gateway 在每次调用时读取它，
 *     所以 mutate 这个对象就等于热更新，不用重启服务。
 *
 * 为什么不用「重启服务才生效」：排计划是用户随手点的动作，改完配置还要去重启进程
 * 是没必要的心智负担（用户诉求：「就是个个人系统，别搞那么复杂」）。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  AI_BASE_URL_DEFAULT,
  AI_MODEL_DEFAULT,
  type AiMode,
  type AppConfig,
} from '../config/index.js';

export interface AiConfigView {
  mode: AiMode;
  base_url: string;
  model: string;
  max_tokens: number;
  temperature: number;
  /** 是否已配置 Key（只回布尔值，不回传内容）。 */
  has_key: boolean;
  /** Key 掩码：`****abcd`。未配置为 null。 */
  key_hint: string | null;
  /** 三样齐全（或本地端点免鉴权）才算可用。 */
  ready: boolean;
  /** 不可用的原因（ready 为 true 时是 null）。 */
  blocked_reason: string | null;
  /** 本机是本地端点 → 允许不带 Key。 */
  local_endpoint: boolean;
}

/** gateway 每次调用时读取的 http 配置（同一对象引用 = 热更新）。 */
export interface AiHttpConfig {
  mode: AiMode;
  baseUrl: string;
  model: string;
  apiKey: string | null;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
}

export interface AiRuntime {
  readonly http: AiHttpConfig;
  /** 当前配置（掩码后）。 */
  view(): AiConfigView;
  /** plan.ai_model_tag / review.ai_model_tag 的审计值。 */
  tag(): string;
  /** 把新配置应用进内存（热更新）。 */
  apply(next: Partial<AiHttpConfig>): void;
}

export class AiConfigError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

/** 掩码：只留后四位。长度不足 4 时全部打码。 */
export function maskKey(key: string | null): string | null {
  if (!key) return null;
  const tail = key.length > 4 ? key.slice(-4) : '';
  return `****${tail}`;
}

/** 本地端点（免鉴权即可用：ollama / llama.cpp / 本机 mock）。 */
export function isLocalEndpoint(baseUrl: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(baseUrl.trim());
}

function blockedReason(http: AiHttpConfig): string | null {
  if (http.mode === 'off') return '已按配置关闭 AI（LLM_MODE=off），排计划直接用规则模板';
  if (!http.baseUrl) return '缺少 LLM_BASE_URL';
  if (!http.model) return '缺少 LLM_MODEL';
  if (!http.apiKey && !isLocalEndpoint(http.baseUrl)) return '缺少 LLM_API_KEY（非本地端点必须配置）';
  return null;
}

export function createAiRuntime(cfg: AppConfig): AiRuntime {
  // 🔴 同一个对象引用一路传进 gateway：mutate 即热更新
  const http: AiHttpConfig = {
    mode: cfg.aiMode,
    baseUrl: cfg.aiBaseUrl,
    model: cfg.aiModel,
    apiKey: cfg.llmApiKey,
    maxTokens: cfg.aiMaxTokens,
    temperature: cfg.aiTemperature,
    timeoutMs: cfg.aiTimeoutMs,
  };
  return {
    http,
    view(): AiConfigView {
      const reason = blockedReason(http);
      return {
        mode: http.mode,
        base_url: http.baseUrl,
        model: http.model,
        max_tokens: http.maxTokens,
        temperature: http.temperature,
        has_key: http.apiKey !== null,
        key_hint: maskKey(http.apiKey),
        ready: reason === null,
        blocked_reason: reason,
        local_endpoint: isLocalEndpoint(http.baseUrl),
      };
    },
    tag(): string {
      return blockedReason(http) === null ? `http:${http.model}` : 'unconfigured';
    },
    apply(next: Partial<AiHttpConfig>): void {
      Object.assign(http, next);
    },
  };
}

// ---------------------------------------------------------------------------
// .env 文件读写（唯一落盘位置）
// ---------------------------------------------------------------------------

/** `.env` 解析：返回行数组 + 键值（值不落日志、不回传）。 */
export function parseEnvText(text: string): { lines: string[]; values: Map<string, string> } {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = clean.split(/\r?\n/);
  const values = new Map<string, string>();
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) value = value.slice(1, -1);
    values.set(key, value);
  }
  return { lines, values };
}

/**
 * 更新 `.env`：只改动指定键所在的「非注释行」，其余内容（含用户的训记 Key 与注释）原样保留。
 * 键不存在时追加到文件末尾。写临时文件再 rename（原子，避免写一半崩掉把 .env 写坏）。
 */
export function updateEnvFile(envPath: string, patch: Record<string, string | null>): void {
  const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const hadBom = existing.charCodeAt(0) === 0xfeff;
  const { lines } = parseEnvText(existing);
  const pending = new Map(Object.entries(patch));
  const out: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    const isComment = trimmed.startsWith('#');
    const withoutExport = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const eq = withoutExport.indexOf('=');
    const key = !isComment && eq > 0 ? withoutExport.slice(0, eq).trim() : null;
    if (key === null || !pending.has(key)) {
      out.push(line);
      continue;
    }
    const value = pending.get(key);
    pending.delete(key);
    if (value === null) continue; // 删除该行（clear_key）
    out.push(`${key}=${value}`);
  }
  // 追加新键之前先去掉尾随空行 —— 否则新键会跟已有内容隔着一个空行（2026-10-01 独立验证
  // 报的外观瑕疵：文件末尾本来有换行 → 解析出一个空行元素 → 新键被塞在它后面）。
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
  for (const [key, value] of pending) {
    if (value === null) continue;
    out.push(`${key}=${value}`);
  }
  // 去掉尾随空行再补一个换行，避免反复保存把文件越写越空
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
  const text = `${hadBom ? '\uFEFF' : ''}${out.join('\n')}\n`;

  const tmp = `${envPath}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, envPath);
}

export interface AiConfigPatch {
  mode?: AiMode;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** 新 Key；undefined = 保持原样（前端不回传原值，也就不会误清）。 */
  apiKey?: string;
  /** 显式清空 Key。 */
  clearKey?: boolean;
}

const LIMITS = { modelMaxLen: 64, urlMaxLen: 200, keyMaxLen: 400, tokens: [256, 32768] as const };

/** 校验并规范化设置页提交的 AI 配置。非法一律 400。 */
export function validateAiConfigPatch(raw: unknown): AiConfigPatch {
  const src = (raw ?? {}) as Record<string, unknown>;
  const out: AiConfigPatch = {};

  if (src.mode !== undefined) {
    const mode = String(src.mode).trim().toLowerCase();
    if (mode !== 'http' && mode !== 'off') throw new AiConfigError(400, 'mode 只能是 http 或 off');
    out.mode = mode;
  }

  if (src.base_url !== undefined) {
    const url = String(src.base_url).trim();
    if (url.length > LIMITS.urlMaxLen) throw new AiConfigError(400, `base_url 最多 ${LIMITS.urlMaxLen} 个字符`);
    if (url !== '') {
      if (!/^https?:\/\/\S+$/i.test(url)) throw new AiConfigError(400, 'base_url 必须是 http(s):// 开头的地址');
    }
    out.baseUrl = url || AI_BASE_URL_DEFAULT;
  }

  if (src.model !== undefined) {
    const model = String(src.model).trim();
    if (model === '') throw new AiConfigError(400, 'model 不能为空');
    if (model.length > LIMITS.modelMaxLen) throw new AiConfigError(400, `model 最多 ${LIMITS.modelMaxLen} 个字符`);
    if (/\s/.test(model)) throw new AiConfigError(400, 'model 不能含空格');
    out.model = model;
  }

  if (src.max_tokens !== undefined && src.max_tokens !== null && src.max_tokens !== '') {
    const n = Number(src.max_tokens);
    if (!Number.isInteger(n) || n < LIMITS.tokens[0] || n > LIMITS.tokens[1]) {
      throw new AiConfigError(400, `max_tokens 需为 ${LIMITS.tokens[0]}~${LIMITS.tokens[1]} 的整数`);
    }
    out.maxTokens = n;
  }

  if (src.temperature !== undefined && src.temperature !== null && src.temperature !== '') {
    const t = Number(src.temperature);
    if (!Number.isFinite(t) || t < 0 || t > 2) throw new AiConfigError(400, 'temperature 需在 0~2 之间');
    out.temperature = t;
  }

  if (src.clear_key === true) {
    out.clearKey = true;
    out.apiKey = '';
  } else if (typeof src.api_key === 'string' && src.api_key.trim() !== '') {
    const key = src.api_key.trim();
    if (key.length > LIMITS.keyMaxLen) throw new AiConfigError(400, 'API Key 过长，请确认粘贴内容');
    if (/\s/.test(key)) throw new AiConfigError(400, 'API Key 不能含空格/换行，请确认粘贴内容');
    out.apiKey = key;
  }
  return out;
}

export interface ApplyAiConfigOptions {
  envPath: string;
  patch: AiConfigPatch;
}

/**
 * 落盘 + 热更新。返回值是掩码后的新配置（不含 Key）。
 * `.env` 的写是「更新 LLM_* 行」，不碰其它键。
 */
export function applyAiConfig(runtime: AiRuntime, opts: ApplyAiConfigOptions): AiConfigView {
  const { patch } = opts;
  const nextHttp: Partial<AiHttpConfig> = {};
  if (patch.mode !== undefined) nextHttp.mode = patch.mode;
  if (patch.baseUrl !== undefined) nextHttp.baseUrl = patch.baseUrl;
  if (patch.model !== undefined) nextHttp.model = patch.model;
  if (patch.maxTokens !== undefined) nextHttp.maxTokens = patch.maxTokens;
  if (patch.temperature !== undefined) nextHttp.temperature = patch.temperature;
  if (patch.apiKey !== undefined) nextHttp.apiKey = patch.apiKey.trim() === '' ? null : patch.apiKey.trim();

  // 先算写盘内容：只有「用户真的改了」的项才写，避免把默认值固化进 .env
  const pending: Record<string, string | null> = {};
  if (patch.mode !== undefined) pending.LLM_MODE = patch.mode;
  if (patch.baseUrl !== undefined) pending.LLM_BASE_URL = patch.baseUrl;
  if (patch.model !== undefined) pending.LLM_MODEL = patch.model;
  if (patch.maxTokens !== undefined) pending.LLM_MAX_TOKENS = String(patch.maxTokens);
  if (patch.temperature !== undefined) pending.LLM_TEMPERATURE = String(patch.temperature);
  if (patch.clearKey === true) pending.LLM_API_KEY = null;
  else if (patch.apiKey !== undefined) pending.LLM_API_KEY = patch.apiKey;

  updateEnvFile(opts.envPath, pending);
  runtime.apply(nextHttp);

  // 写盘后同步进程环境变量，让「重启后仍一致」（.env 已是唯一真相源）
  if (patch.mode !== undefined) process.env.LLM_MODE = patch.mode;
  if (patch.baseUrl !== undefined) process.env.LLM_BASE_URL = patch.baseUrl;
  if (patch.model !== undefined) process.env.LLM_MODEL = patch.model;
  if (patch.maxTokens !== undefined) process.env.LLM_MAX_TOKENS = String(patch.maxTokens);
  if (patch.temperature !== undefined) process.env.LLM_TEMPERATURE = String(patch.temperature);
  if (pending.LLM_API_KEY === null) delete process.env.LLM_API_KEY;
  else if (pending.LLM_API_KEY !== undefined) process.env.LLM_API_KEY = pending.LLM_API_KEY;

  return runtime.view();
}

/** 默认 env 路径（与 loadEnvFile 保持一致：cwd 下的 .env）。 */
export function envPathOf(cwd: string = process.cwd()): string {
  return path.resolve(cwd, '.env');
}
