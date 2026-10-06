import { createHash } from 'node:crypto';

/**
 * 稳定序列化：对象键按字典序递归排序（数组保持原序）。
 * 用于 content_hash / payload_hash —— 同一语义内容必然产出同一字符串。
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => sortValue(v));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** sha256 十六进制摘要（小写）。 */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
