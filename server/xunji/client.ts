import { inflateRawSync, inflateSync, brotliDecompressSync, gunzipSync } from 'node:zlib';
import { HTTP_TIMEOUT_MS_DEFAULT, READ_PATH, SCHEMA_VERSION, INCLUDE_FULL_DATA } from '../config/constants.js';
import { sanitize } from '../shared/logger.js';
import { XunjiError } from './errors.js';

/**
 * HTTP 传输层（T1，§6.2.1）。
 *
 * - 所有对外 HTTP 请求必须走本模块（红线 §12.3-5，统一脱敏与错误归一）；
 * - Transport 可注入：单元测试用 MockTransport，绝不真实联网（红线 §12.3-6）；
 * - gzip：Node fetch 传输层实测会自动解压（probe-report §2），因此**只有魔数
 *   1f 8b 才手工 gunzip**（防「头部声明 gzip 但字节已是明文」的双重解压错误）。
 */
export interface XunjiHttpRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

export interface XunjiHttpResponse {
  status: number;
  headers: Record<string, string>;
  bodyBytes: Buffer;
}

export type Transport = (req: XunjiHttpRequest) => Promise<XunjiHttpResponse>;

/** 默认传输：global fetch + AbortController 超时。 */
export const fetchTransport: Transport = async (req) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);
  try {
    const resp = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: controller.signal,
    });
    const headers: Record<string, string> = {};
    resp.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const bodyBytes = Buffer.from(await resp.arrayBuffer());
    return { status: resp.status, headers, bodyBytes };
  } catch (e) {
    const err = e as { name?: string; message?: string };
    if (err?.name === 'AbortError') {
      throw new XunjiError({
        code: 'NETWORK_ERROR',
        kind: 'retryable',
        message: `请求超时（超过 ${req.timeoutMs}ms）`,
      });
    }
    throw new XunjiError({
      code: 'NETWORK_ERROR',
      kind: 'retryable',
      message: `网络错误：${err?.message ?? String(e)}`,
    });
  } finally {
    clearTimeout(timer);
  }
};

export interface DecodedBody {
  text: string;
  encoding: string;
}

/**
 * 响应体解码（自探针 decodeBody 移植）：
 * 魔数 1f 8b → 手工 gunzip；declared deflate/br → 对应解压；否则按明文。
 * 解压失败按原文继续（交给 JSON.parse 判定，失败则走「解析失败留证」路径）。
 */
export function decodeBody(headers: Record<string, string>, buf: Buffer): DecodedBody {
  const headerEnc = (headers['content-encoding'] ?? '').toLowerCase();
  const isGzip = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  const encList = headerEnc
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const declared = encList[encList.length - 1] ?? '';

  if (isGzip) {
    try {
      return { text: gunzipSync(buf).toString('utf8'), encoding: 'gzip（已手动解压）' };
    } catch {
      return { text: buf.toString('utf8'), encoding: 'gzip（解压失败，已按原文解析）' };
    }
  }
  if (declared === 'deflate') {
    try {
      return { text: inflateSync(buf).toString('utf8'), encoding: 'deflate（已解压）' };
    } catch {
      try {
        return { text: inflateRawSync(buf).toString('utf8'), encoding: 'deflate-raw（已解压）' };
      } catch {
        return { text: buf.toString('utf8'), encoding: 'deflate（解压失败，已按原文解析）' };
      }
    }
  }
  if (declared === 'br') {
    try {
      return { text: brotliDecompressSync(buf).toString('utf8'), encoding: 'br（已解压）' };
    } catch {
      return { text: buf.toString('utf8'), encoding: 'br（解压失败，已按原文解析）' };
    }
  }
  // 未压缩，或传输层已自动解压（实测主路径）
  return {
    text: buf.toString('utf8'),
    encoding: declared ? `${declared}（传输层已自动解压，无需处理）` : 'identity（未压缩）',
  };
}

export interface ClientResult {
  httpStatus: number;
  text: string;
  json: unknown | null;
  parseError: string | null;
  encoding: string;
  bytes: number;
}

/**
 * 训记 HTTP 客户端：传输 + 解码 + JSON 解析（不做业务判定——那在 errors/reader）。
 */
export class XunjiHttpClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly transport: Transport;

  constructor(opts: {
    baseUrl: string;
    apiKey: string;
    timeoutMs?: number;
    transport?: Transport;
  }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? HTTP_TIMEOUT_MS_DEFAULT;
    this.transport = opts.transport ?? fetchTransport;
  }

  /** 读取请求体（全程 full 模式，§6.2.1 硬约束，不提供开关）。 */
  buildReadBody(datestr: string): { schema_version: string; datestr: string; include_full_data: boolean } {
    return {
      schema_version: SCHEMA_VERSION,
      datestr,
      include_full_data: INCLUDE_FULL_DATA,
    };
  }

  buildReadRequest(datestr: string): XunjiHttpRequest {
    return {
      url: `${this.baseUrl}${READ_PATH}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // 已核实：鉴权只能放请求头（§6.1），Key 绝不进 body/query/日志
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
      },
      body: JSON.stringify(this.buildReadBody(datestr)),
      timeoutMs: this.timeoutMs,
    };
  }

  async post(path: string, bodyObj: unknown): Promise<ClientResult> {
    const req: XunjiHttpRequest = {
      url: `${this.baseUrl}${path}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
      },
      body: JSON.stringify(bodyObj),
      timeoutMs: this.timeoutMs,
    };
    let resp: XunjiHttpResponse;
    try {
      resp = await this.transport(req);
    } catch (e) {
      if (e instanceof XunjiError) throw e;
      throw new XunjiError({
        code: 'NETWORK_ERROR',
        kind: 'retryable',
        message: `网络错误：${(e as Error)?.message ?? String(e)}`,
      });
    }
    const { text, encoding } = decodeBody(resp.headers, resp.bodyBytes);
    let json: unknown = null;
    let parseError: string | null = null;
    try {
      json = JSON.parse(text) as unknown;
    } catch (e) {
      parseError = (e as Error).message;
    }
    void sanitize; // 防御性引用：错误文本统一在 XunjiError 构造时脱敏
    return {
      httpStatus: resp.status,
      text,
      json,
      parseError,
      encoding,
      bytes: resp.bodyBytes.length,
    };
  }
}
