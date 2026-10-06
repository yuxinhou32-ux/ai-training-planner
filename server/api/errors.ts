/**
 * API 错误响应 helper（§2.3 server/api/errors.ts）。
 */
import type { ServerResponse } from 'node:http';

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
    'cache-control': 'no-store',
  });
  res.end(buf);
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

/** 业务错误：携带状态码抛出，由统一 catch 转成 JSON。 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
