/**
 * 训记接入配置：让用户在设置页填 `XUNJI_API_KEY`，不必去改 `.env` 文件。
 *
 * 🔴 安全红线（与 AI 配置同一套，PRD-v2 §10.3 V4）：
 *  - Key 的唯一落盘位置是 `.env`（已被 .gitignore 忽略）。网页输入只是**换个入口**，
 *    最终仍然写进 `.env`；**不入库、不写日志、不回传明文**；
 *  - 读接口只回 `has_key`（布尔）与 `key_hint`（`****后四位`）；
 *  - 请求里不带 `api_key` 就保持原值不动 —— 前端拿不到明文，所以不会「保存一次就被清空」。
 *
 * ⚠️ 与 AI 配置的关键差异：训记的 `SyncEngine` 与写回客户端都是**启动时一次性装配**的，
 *    换了 Key 必须**重建**它们。所以这里通过 `onApplied` 回调把新 Key 交给
 *    server/index.ts 去换掉那两个活引用；AI 那边是个可变 runtime，改字段即可。
 */
import { updateEnvFile, envPathOf } from '../ai/aiConfig.js';

/** 训记 Key 的环境变量名（`.env` 里的键）。 */
export const XUNJI_KEY_ENV = 'XUNJI_API_KEY';

const LIMITS = { keyMaxLen: 512 };

export class XunjiConfigError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'XunjiConfigError';
  }
}

export interface XunjiKeyPatch {
  /** 新 Key；undefined = 保持原样。 */
  apiKey?: string;
  /** 显式清空。 */
  clearKey?: boolean;
}

/** 读接口的返回形状：**只有**有无与掩码，永不包含明文。 */
export interface XunjiKeyView {
  has_key: boolean;
  key_hint: string | null;
}

/** 只露后 4 位；不足 4 位则整体打码。 */
export function maskKey(key: string | null): string | null {
  if (key === null || key === '') return null;
  return key.length <= 4 ? '****' : `****${key.slice(-4)}`;
}

export function xunjiKeyView(current: string | null): XunjiKeyView {
  return { has_key: current !== null && current !== '', key_hint: maskKey(current) };
}

export function validateXunjiKeyPatch(src: unknown): XunjiKeyPatch {
  if (src === null || typeof src !== 'object' || Array.isArray(src)) {
    throw new XunjiConfigError(400, '请求体需为 JSON 对象');
  }
  const o = src as Record<string, unknown>;
  const out: XunjiKeyPatch = {};

  if (o.clear_key === true) {
    out.clearKey = true;
    return out;
  }
  if (typeof o.api_key === 'string' && o.api_key.trim() !== '') {
    const key = o.api_key.trim();
    if (key.length > LIMITS.keyMaxLen) {
      throw new XunjiConfigError(400, 'API Key 过长，请确认粘贴内容');
    }
    if (/\s/.test(key)) {
      throw new XunjiConfigError(400, 'API Key 不能含空格/换行，请确认粘贴内容');
    }
    out.apiKey = key;
  }
  return out;
}

export interface ApplyXunjiOptions {
  /** `.env` 绝对路径。 */
  envPath: string;
  patch: XunjiKeyPatch;
  /** 当前生效的 Key（通常读 process.env）。 */
  current: string | null;
  /** 热更新：把新 Key（或 null）装到活着的同步引擎 / 写回客户端上。 */
  onApplied: (key: string | null) => void;
}

/**
 * 写 `.env` + 进程环境变量 + 重建引擎。返回**掩码后**的新状态（不含明文）。
 *
 * `updateEnvFile` 只改 `XUNJI_API_KEY` 那一行，用户的注释、训记之外的键（含 LLM_*）原样保留。
 */
export function applyXunjiKey(opts: ApplyXunjiOptions): XunjiKeyView {
  const { patch } = opts;
  const unchanged = patch.clearKey !== true && patch.apiKey === undefined;

  // 🔴 没变更就**不要**惊动 onApplied：回调会重建同步引擎，而 index.ts 那边顺手
  //    判断「从未全量过 → 立刻全量」。空保存（PUT {}）若也走回调，一个从没全量过的
  //    用户只要在设置页点一下保存，就会莫名其妙触发一次 26 周导入（2026-10-01 独立验证发现）。
  if (unchanged) return xunjiKeyView(opts.current === '' ? null : opts.current);

  let next: string | null = opts.current === '' ? null : opts.current;

  if (patch.clearKey === true) {
    updateEnvFile(opts.envPath, { [XUNJI_KEY_ENV]: null });
    delete process.env[XUNJI_KEY_ENV];
    next = null;
  } else if (patch.apiKey !== undefined) {
    updateEnvFile(opts.envPath, { [XUNJI_KEY_ENV]: patch.apiKey });
    process.env[XUNJI_KEY_ENV] = patch.apiKey;
    next = patch.apiKey;
  }

  opts.onApplied(next);
  return xunjiKeyView(next);
}

export { envPathOf };
