/**
 * 脱敏日志（T1）。安全红线 §12.3：API Key 绝不进入日志。
 *
 * 双保险：
 *  1. 结构上 —— 调用方从不把 Key 传给 logger；
 *  2. 防御性 —— sanitize() 对任意文本做 Bearer 掩码，即使上游失误也不泄露。
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** 把 Bearer 凭据替换为掩码（§6.1 防御层）。 */
export function sanitize(text: string): string {
  return text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***');
}

/** 控制台实现；minLevel 默认 info（quiet 模式只保留 warn/error）。 */
export function createConsoleLogger(minLevel: LogLevel = 'info'): Logger {
  const emit = (level: LogLevel, message: string): void => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
    const text = sanitize(message);
    const stamp = new Date().toISOString().replace('T', ' ').replace('Z', '');
    const line = `[${stamp}] ${level.toUpperCase().padEnd(5)} ${text}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };
  return {
    debug: (m) => emit('debug', m),
    info: (m) => emit('info', m),
    warn: (m) => emit('warn', m),
    error: (m) => emit('error', m),
  };
}

/** 静默 logger（测试用）。 */
export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
