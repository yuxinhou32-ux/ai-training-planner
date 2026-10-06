#!/usr/bin/env node
/**
 * scripts/probe_xunji.mjs — 训记 Open API 连通性探针
 *
 * ============================ 这个脚本要解决什么 ============================
 * MVP T1 的第一步：先把「能不能拿到训练数据」这个最大不确定性打掉。
 * 在它跑通之前，不写任何分析层 / AI 代码。脚本只回答四个问题：
 *
 *   Q1 连通性    —— Key 是否有效、账号是否有权限（是否有 VIP）
 *   Q2 字段结构  —— res.trains[] 每一层的真实字段清单，并对比
 *                   include_full_data = false / true 两种模式的差异
 *   Q3 限频行为  —— 同一天连打两次会返回什么？不同日期是否互不阻塞？
 *                   （决定首次 12 周同步能不能并发）
 *   Q4 动作名覆盖 —— 最近 N 天出现过的去重动作中文名清单与数量
 *                   （后续肌群映射冷启动的输入）
 *
 * ============================ 用法 ============================
 *   cp .env.example .env            # 复制后填入 XUNJI_API_KEY
 *   node scripts/probe_xunji.mjs                       # 默认：最近 7 天
 *   node scripts/probe_xunji.mjs --date 2026-04-02 --days 30
 *   node scripts/probe_xunji.mjs --no-rate-test        # 跳过限频实验（约省 3 分钟）
 *
 * 参数：
 *   --date=YYYY-MM-DD   锚点日期（默认今天）。拉取窗口 = [锚点-(N-1)天, 锚点]
 *   --days=N            拉取窗口天数，默认 7；0 表示跳过 Q4 覆盖扫描
 *   --full / --no-full  是否做 include_full_data=true 的字段对比（默认开）
 *   --delay-ms=N        不同日期之间的礼貌间隔，默认 1500ms（设 0 = 最严格的跨日测试）
 *   --timeout-ms=N      单次 HTTP 超时，默认 20000ms
 *   --no-rate-test      跳过 Q3 的同日限频实验
 *   --dump-raw          额外把每日原始 JSON 存到 data/probe/（供后续写解析器用）
 *   --out=<path>        报告输出路径，默认 docs/probe-report.md
 *   -h / --help         查看帮助
 *
 * 依赖：Node 22+（原生 fetch + zlib），零第三方依赖。
 *
 * ============================ 安全红线 ============================
 * Key 只从环境变量 XUNJI_API_KEY 读取，任何输出（含报告）都经过 safe() 掩码，
 * 报告与日志中绝不出现 Key 明文。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* ============================================================================
 * 1. 常量（集中定义，禁止散落硬编码）
 * ==========================================================================*/

const XUNJI_BASE_URL = 'https://trains.xunjiapp.cn';
const READ_PATH = '/api_trains_for_llm_v2';
const SCHEMA_VERSION = 'train_open_api_v2';

/**
 * 架构 §12.1 写的是"同一训练日 90 秒内最多读一次"，作为**兜底值**使用。
 * 实测发现服务端会在 res.limits 里自报真实限频（更短），探测到后以服务端为准。
 */
const READ_COOL_DOWN_MS = 90_000;

const HTTP_TIMEOUT_MS = 20_000;
const DEFAULT_DAYS = 7;
const DEFAULT_DELAY_MS = 1_500;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_REPORT_PATH = 'docs/probe-report.md';
const DEFAULT_RAW_DIR = 'data/probe';

/** .env 加载顺序：前者优先，环境变量优先级最高（不覆盖已存在的 process.env） */
const ENV_FILES = ['.env', '.env.local'];

/** 字段树递归上限与数组采样上限：防止异常数据把内存/报告撑爆 */
const MAX_DEPTH = 10;
const MAX_ARRAY_SAMPLES = 25;
const MAX_SNIPPET_CHARS = 3_000;

/** 出口码语义 */
const EXIT_OK = 0;
const EXIT_UNEXPECTED = 1;
const EXIT_NO_KEY = 2;
const EXIT_FATAL_API = 3;

/**
 * 关键字段检查表：针对 PRD/架构里点名关心的那一批"必须 include_full_data:true 才有"的字段。
 * 用正则而不是写死路径，因为字段名还没实测确认，先做存在性嗅探。
 */
const CRITICAL_FIELDS = [
  { label: 'RPE / 主观强度', re: /\brpe\b|rpe_|perceived|exertion/i },
  { label: '备注 note', re: /\bnotes?\b|remark|comment/i },
  { label: '完成感受 feeling', re: /feel|感受|feedback/i },
  { label: '是否完成 done', re: /\bdone\b|completed|is_done|finished/i },
  { label: '左右侧 side', re: /\bside\b|left|right|左右/i },
  { label: '实练秒数 time/duration', re: /\btime\b|second|duration|秒数/i },
  { label: '重量与单位 weight/unit', re: /weight|unit/i },
  { label: '次数 reps', re: /\breps?\b|repetition|repeat/i },
  { label: '距离 distance', re: /distance|\bdist\b/i },
  { label: '热量 kcal/calories', re: /kcal|calor/i },
  { label: '心率 heartRate', re: /heart|心率/i },
  { label: '超级组/递减组子项 items', re: /\bitems?\b|superset|dropset|child/i },
  { label: '有氧标记 cardio', re: /cardio|有氧/i },
  { label: '记录预设 recordPreset', re: /recordPreset|record_preset|preset/i },
];

/** 动作名可能落在哪些 key 上（未实测，先做候选兼容） */
const MOVEMENT_NAME_KEYS = new Set([
  'name',
  'movementName',
  'movement_name',
  'exerciseName',
  'exercise_name',
  'actionName',
  'title',
]);

/** 动作容器可能叫这些名字；找不到时会在 phase Q2 里做一次结构化嗅探 */
const MOVEMENT_CONTAINER_CANDIDATES = [
  'movements',
  'movementList',
  'movement_list',
  'exercises',
  'exerciseList',
  'records',
  'actions',
  'items',
];

/* ============================================================================
 * 2. 通用工具：日志（带脱敏）、睡眠、日期
 * ==========================================================================*/

/** 运行期注册的需要掩码的字符串（目前只有 API Key） */
const REGISTERED_SECRETS = [];

/**
 * 注册敏感串。长度过短的不注册（避免把 "ab" 这种短串误伤到正常文本）。
 * @param {string} value
 */
function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 6 && !REGISTERED_SECRETS.includes(value)) {
    REGISTERED_SECRETS.push(value);
  }
}

/**
 * 把任意输出中的敏感串替换为 ***REDACTED***。
 * 这是最后一道兜底：即使某个分支忘记手动掩码，也不会把 Key 打出去。
 * @param {unknown} input
 * @returns {string}
 */
function safe(input) {
  let text = typeof input === 'string' ? input : String(input ?? '');
  for (const secret of REGISTERED_SECRETS) {
    if (secret) text = text.split(secret).join('***REDACTED***');
  }
  // 兜底：任何 Bearer 令牌形态
  return text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/g, 'Bearer ***REDACTED***');
}

/**
 * 安全日志输出。
 * @param {...unknown} parts
 */
function log(...parts) {
  console.log(safe(parts.join(' ')));
}

/**
 * Key 展示形态：只留后 4 位 + 长度，符合架构 §6.1 的 UI 掩码约定。
 * @param {string} key
 * @returns {string}
 */
function maskKey(key) {
  if (!key) return '(空)';
  const last4 = key.slice(-4);
  return `****${last4}（长度 ${key.length}）`;
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {Date} d
 * @returns {string} YYYY-MM-DD（本地时区，避免 toISOString 的 UTC 偏移导致日期串错一天）
 */
function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** @returns {string} 今天的本地日期串 */
function todayStr() {
  return toDateStr(new Date());
}

/**
 * 日期加减。用 Date 构造器而非时间戳减法，避免夏令时/时区偏移问题。
 * @param {string} dateStr
 * @param {number} delta 正数向后，负数向前
 * @returns {string}
 */
function shiftDays(dateStr, delta) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  return toDateStr(dt);
}

/**
 * @param {string} s
 * @returns {boolean}
 */
function isValidDateStr(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const dt = new Date(`${s}T00:00:00`);
  return !Number.isNaN(dt.getTime()) && toDateStr(dt) === s;
}

/**
 * @returns {string} 本地时间戳字符串
 */
function nowStamp() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return `${toDateStr(d)} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/**
 * 生成窗口日期列表：从锚点往前推 days 天（含锚点）。
 * @param {string} anchor
 * @param {number} days
 * @returns {string[]}
 */
function buildDateWindow(anchor, days) {
  const out = [];
  for (let i = 0; i < days; i += 1) out.push(shiftDays(anchor, -i));
  return out;
}

/* ============================================================================
 * 3. .env 加载（不引入 dotenv：Node 22 自带 process.loadEnvFile，且这里要自定义解析）
 * ==========================================================================*/

/**
 * 极简 .env 解析：KEY=VALUE，支持 # 注释、export 前缀、成对引号。
 * 已存在的环境变量优先级更高（方便命令行临时覆盖）。
 * 注意：这里只写 process.env，绝不打印 VALUE。
 *
 * @param {string} cwd
 * @returns {string[]} 实际加载到的文件名列表
 */
function loadDotEnv(cwd) {
  const loaded = [];
  for (const name of ENV_FILES) {
    const filePath = path.resolve(cwd, name);
    if (!fs.existsSync(filePath)) continue;
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    let count = 0;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
      const eq = withoutExport.indexOf('=');
      if (eq <= 0) continue;
      const key = withoutExport.slice(0, eq).trim();
      let value = withoutExport.slice(eq + 1).trim();
      const isQuoted =
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"));
      if (isQuoted && value.length >= 2) value = value.slice(1, -1);
      if (process.env[key] === undefined) {
        process.env[key] = value;
        count += 1;
      }
    }
    loaded.push(`${name}(${count} 项)`);
  }
  return loaded;
}

/* ============================================================================
 * 4. CLI 参数解析
 * ==========================================================================*/

const HELP_TEXT = `
训记 Open API 连通性探针

用法:
  node scripts/probe_xunji.mjs [选项]

选项:
  --date=YYYY-MM-DD   锚点日期，默认今天。拉取窗口 = [锚点-(days-1)天, 锚点]
  --days=N            拉取窗口天数，默认 ${DEFAULT_DAYS}；传 0 跳过 Q4 覆盖扫描
  --full              做 include_full_data=true 的字段对比（默认开启）
  --no-full           只跑 include_full_data=false（更快，但拿不到 RPE/备注等字段）
  --delay-ms=N        不同日期之间的礼貌间隔，默认 ${DEFAULT_DELAY_MS}ms（0 = 最严格跨日测试）
  --timeout-ms=N      单次 HTTP 超时，默认 ${DEFAULT_TIMEOUT_MS}ms
  --no-rate-test      跳过 Q3 同日限频实验（可省约 3 分钟等待）
  --dump-raw          把每日原始 JSON 额外写入 ${DEFAULT_RAW_DIR}/
  --out=<path>        报告输出路径，默认 ${DEFAULT_REPORT_PATH}
  -h, --help          显示本帮助

环境变量:
  XUNJI_API_KEY       必填，训记 Open API Key（也可写入 .env）
  XUNJI_BASE_URL      可选，覆盖 API 基址，默认 ${XUNJI_BASE_URL}

示例:
  node scripts/probe_xunji.mjs
  node scripts/probe_xunji.mjs --date 2026-04-02 --days 30
  node scripts/probe_xunji.mjs --no-rate-test --days 0
`;

/**
 * @param {string[]} argv
 * @returns {{ok: true, opts: object} | {ok: false, error: string, help?: boolean}}
 */
function parseArgs(argv) {
  const opts = {
    date: todayStr(),
    days: DEFAULT_DAYS,
    full: true,
    delayMs: DEFAULT_DELAY_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    rateTest: true,
    dumpRaw: false,
    out: DEFAULT_REPORT_PATH,
    help: false,
  };

  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') {
      opts.help = true;
      continue;
    }
    const [rawKey, rawValue] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, ''];
    switch (rawKey) {
      case '--date':
        if (!isValidDateStr(rawValue)) return { ok: false, error: `--date 需要合法的 YYYY-MM-DD 日期，收到：${rawValue || '(空)'}` };
        opts.date = rawValue;
        break;
      case '--days': {
        const n = Number(rawValue);
        if (!Number.isInteger(n) || n < 0) return { ok: false, error: `--days 需要非负整数，收到：${rawValue || '(空)'}` };
        opts.days = n;
        break;
      }
      case '--delay-ms': {
        const n = Number(rawValue);
        if (!Number.isInteger(n) || n < 0) return { ok: false, error: `--delay-ms 需要非负整数，收到：${rawValue || '(空)'}` };
        opts.delayMs = n;
        break;
      }
      case '--timeout-ms': {
        const n = Number(rawValue);
        if (!Number.isInteger(n) || n < 1_000) return { ok: false, error: `--timeout-ms 需要 >=1000 的整数，收到：${rawValue || '(空)'}` };
        opts.timeoutMs = n;
        break;
      }
      case '--full':
        opts.full = true;
        break;
      case '--no-full':
        opts.full = false;
        break;
      case '--no-rate-test':
        opts.rateTest = false;
        break;
      case '--dump-raw':
        opts.dumpRaw = true;
        break;
      case '--out':
        if (!rawValue) return { ok: false, error: '--out 需要指定报告输出路径' };
        opts.out = rawValue;
        break;
      default:
        return { ok: false, error: `未知参数：${arg}（用 --help 查看可用参数）` };
    }
  }
  return { ok: true, opts };
}

/* ============================================================================
 * 5. HTTP 请求：gzip 解压 + 错误归一
 * ==========================================================================*/

/**
 * 解压响应体。
 *
 * 关键坑（实测）：我们显式声明了 `Accept-Encoding: gzip`，但 Node 的 fetch（undici）
 * 在部分版本/路径下仍会在传输层自动解压，交回给我们的已经是明文。
 * 因此**判定的唯一可靠依据是 gzip 魔数 1f 8b，而不是 content-encoding 头**：
 * 内容是 gzip 才解压，否则直接按 UTF-8 原文解析——这样既不会误解压，
 * 也不会像旧版本那样明明拿到明文却打一条"解压失败"，误导后续排查。
 *
 * @param {Response} resp
 * @param {Buffer} buf
 * @returns {{text: string, encoding: string}}
 */
function decodeBody(resp, buf) {
  const headerEnc = (resp.headers.get('content-encoding') || '').toLowerCase();
  const isGzip = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  // zlib 的 deflate 没有魔数可用，只在头部明确声明且不是 gzip 时才尝试
  const encList = headerEnc.split(',').map((s) => s.trim()).filter(Boolean);
  const declared = encList[encList.length - 1] || '';

  if (isGzip) {
    try {
      return { text: zlib.gunzipSync(buf).toString('utf8'), encoding: 'gzip（已手动解压）' };
    } catch {
      // 真的是 gzip 但解压失败（包体损坏）：如实记录，并退回原文
      return { text: buf.toString('utf8'), encoding: 'gzip（解压失败，已按原文解析）' };
    }
  }
  if (declared === 'deflate') {
    try {
      return { text: zlib.inflateSync(buf).toString('utf8'), encoding: 'deflate（已解压）' };
    } catch {
      try {
        return { text: zlib.inflateRawSync(buf).toString('utf8'), encoding: 'deflate-raw（已解压）' };
      } catch {
        return { text: buf.toString('utf8'), encoding: 'deflate（解压失败，已按原文解析）' };
      }
    }
  }
  if (declared === 'br') {
    try {
      return { text: zlib.brotliDecompressSync(buf).toString('utf8'), encoding: 'br（已解压）' };
    } catch {
      return { text: buf.toString('utf8'), encoding: 'br（解压失败，已按原文解析）' };
    }
  }
  // 未压缩，或传输层已经帮我们解压好了
  return {
    text: buf.toString('utf8'),
    encoding: declared ? `${declared}（传输层已自动解压，无需处理）` : 'identity（未压缩）',
  };
}

/**
 * 在响应 JSON 里递归找错误消息文本。
 * 字段名还没实测确认，所以候选 key 一起找。
 *
 * @param {unknown} node
 * @param {number} depth
 * @returns {string[]}
 */
function findErrorMessages(node, depth = 0) {
  const out = [];
  if (depth > 6 || node === null || node === undefined) return out;
  if (typeof node === 'string') return [node];
  if (typeof node !== 'object') return out;
  const ERROR_KEYS = new Set(['error', 'errMsg', 'errmsg', 'message', 'msg', 'reason', 'error_message', 'tip', 'tips']);
  if (Array.isArray(node)) {
    for (const item of node) out.push(...findErrorMessages(item, depth + 1));
    return out;
  }
  for (const [k, v] of Object.entries(node)) {
    if (ERROR_KEYS.has(k) && (typeof v === 'string' || typeof v === 'number')) out.push(String(v));
    else out.push(...findErrorMessages(v, depth + 1));
  }
  return out;
}

/**
 * 从响应里提取服务端给出的重试等待毫秒数。
 * Q24（retry 字段名未知）：先按字段名候选找，再从文本里挖「等 X 秒」这类提示。
 * 都找不到就退回已核实的 90 秒。
 *
 * @param {unknown} json
 * @param {string[]} messages
 * @returns {{retryMs: number, source: string}}
 */
function extractRetryMs(json, messages) {
  const RETRY_KEY_RE = /retry|wait|cooldown|cool_down|interval|again/i;
  const found = [];

  /** @param {unknown} node @param {number} depth */
  const walk = (node, depth) => {
    if (depth > 6 || !node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'number' && RETRY_KEY_RE.test(k)) found.push({ key: k, value: v });
      else if (typeof v === 'string' && RETRY_KEY_RE.test(k)) found.push({ key: k, text: v });
      else walk(v, depth + 1);
    }
  };
  walk(json, 0);

  for (const item of found) {
    if (typeof item.value === 'number' && item.value > 0) {
      // 单位未知：>= 500 视为毫秒，否则视为秒（常见的两套约定）
      const ms = item.value >= 500 ? item.value : item.value * 1000;
      return { retryMs: Math.min(ms, 300_000), source: `字段 ${item.key}=${item.value}` };
    }
    if (typeof item.text === 'string') {
      const m = item.text.match(/(\d+(?:\.\d+)?)\s*(毫秒|ms|秒|秒钟|s|sec|secs|second|seconds|min|分钟|分)/i);
      if (m) {
        const n = Number(m[1]);
        const unit = m[2].toLowerCase();
        const ms = /毫秒|ms/.test(unit) ? n : /分|min/.test(unit) ? n * 60_000 : n * 1000;
        return { retryMs: Math.min(ms, 300_000), source: `字段 ${item.key}="${item.text}"` };
      }
    }
  }

  for (const msg of messages) {
    const m = String(msg).match(/(\d+(?:\.\d+)?)\s*(毫秒|ms|秒|秒钟|s|sec|secs|second|seconds|min|分钟|分)/i);
    if (m) {
      const n = Number(m[1]);
      const unit = m[2].toLowerCase();
      const ms = /毫秒|ms/.test(unit) ? n : /分|min/.test(unit) ? n * 60_000 : n * 1000;
      return { retryMs: Math.min(ms, 300_000), source: `提示文本 "${msg}"` };
    }
  }
  return { retryMs: READ_COOL_DOWN_MS, source: '未找到明确提示，按已核实的 90 秒兜底' };
}

/**
 * 错误分类：把训记的几种已知错误翻译成可读中文 + 是否致命 + 是否可重试。
 * 对照错误码处理矩阵。
 *
 * @param {number} httpStatus
 * @param {unknown} json
 * @returns {{code: string, kind: 'ok'|'fatal'|'retryable'|'unknown', cn: string, advice: string, messages: string[], retryMs?: number, retrySource?: string}}
 */
function classifyResponse(httpStatus, json) {
  const messages = findErrorMessages(json);
  const joined = messages.join(' | ');
  const successFlag = json && typeof json === 'object' ? json.success : undefined;

  // 注意顺序：先判更具体的权限类，再兜底 unknown
  if (/apikey\s*is\s*missing|apikey\s*missing/i.test(joined)) {
    return {
      code: 'API_KEY_MISSING',
      kind: 'fatal',
      cn: '服务端未识别到 API Key（apikey missing）',
      advice: '检查 XUNJI_API_KEY 是否正确写入 .env，且没有被多余空格/引号包裹',
      messages,
    };
  }
  if (/apikey\s*invalid|invalid\s*apikey|key\s*无效/i.test(joined)) {
    return {
      code: 'API_KEY_INVALID',
      kind: 'fatal',
      cn: 'API Key 无效（apikey invalid）',
      advice: '请到训记 App 重新生成/复制 Key，注意不要截断首尾字符',
      messages,
    };
  }
  if (/vip/i.test(joined)) {
    return {
      code: 'VIP_REQUIRED',
      kind: 'fatal',
      cn: '该接口仅 VIP 可用（账号权限不足）',
      advice: '确认账号 VIP 状态是否在有效期内；非 VIP 无法使用该读取接口',
      messages,
    };
  }
  if (/too\s*frequent|frequent|频繁/i.test(joined)) {
    const { retryMs, source } = extractRetryMs(json, messages);
    return {
      code: 'TOO_FREQUENT',
      kind: 'retryable',
      cn: '读取过于频繁，被限频（too frequent）',
      advice: `等待后重试。判定依据：${source}`,
      messages,
      retryMs,
      retrySource: source,
    };
  }

  // success 显式为 true 时以响应体为准（此时 HTTP 状态码即使异常也判定为成功）
  if (successFlag === true) {
    return { code: 'OK', kind: 'ok', cn: '成功', advice: '', messages };
  }
  if (httpStatus >= 500) {
    return {
      code: 'SERVER_ERROR',
      kind: 'retryable',
      cn: `服务端错误（HTTP ${httpStatus}）`,
      advice: '指数退避后重试',
      messages,
    };
  }
  if (httpStatus >= 400) {
    return {
      code: 'HTTP_ERROR',
      kind: 'unknown',
      cn: `HTTP 错误 ${httpStatus}：${joined || '(无错误文本)'}`,
      advice: '不重试，需人工看原始响应（常见原因：路径写错、鉴权头缺失）',
      messages,
    };
  }
  if (successFlag === false) {
    return {
      code: 'UNKNOWN_API_ERROR',
      kind: 'unknown',
      cn: `服务返回未知错误：${joined || '(响应中没有可读的错误文本)'}`,
      advice: '不重试，需人工看原始响应（已记录在下方的原始响应片段）',
      messages,
    };
  }
  return { code: 'OK', kind: 'ok', cn: '成功', advice: '', messages };
}

/**
 * 单天读取请求（原始层，不含重试与冷却逻辑）。
 *
 * @param {{baseUrl: string, key: string, timeoutMs: number}} cfg
 * @param {string} datestr
 * @param {boolean} includeFullData
 * @returns {Promise<object>} 观测记录
 */
async function requestDayRaw(cfg, datestr, includeFullData) {
  const url = `${cfg.baseUrl}${READ_PATH}`;
  const payload = {
    schema_version: SCHEMA_VERSION,
    datestr,
    include_full_data: includeFullData,
  };
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  const record = {
    datestr,
    mode: includeFullData ? 'full' : 'light',
    url,
    requestBody: payload,
    httpStatus: 0,
    encoding: '',
    compressedBytes: 0,
    decodedBytes: 0,
    elapsedMs: 0,
    parseError: '',
    json: null,
    rawText: '',
    trains: [],
    classification: null,
    networkError: '',
    // 服务端在 res.limits 里自报的限频与容量约束（实测发现，架构里没有，属于新增事实）
    resLimits: null,
    // 数据完整性标记：res.truncated / trains[].truncated / movements[].truncated
    resTruncated: null,
    resMeta: null,
  };

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // 已核实：鉴权只能放请求头，不能放 body / query
        Authorization: `Bearer ${cfg.key}`,
        Accept: 'application/json',
        // 显式声明 gzip：见 decodeBody 上方的注释，这样就必须自己解压
        'Accept-Encoding': 'gzip',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const buf = Buffer.from(await resp.arrayBuffer());
    const { text, encoding } = decodeBody(resp, buf);
    record.httpStatus = resp.status;
    record.encoding = encoding;
    record.compressedBytes = buf.length;
    record.decodedBytes = text.length;
    record.rawText = text;

    try {
      record.json = JSON.parse(text);
    } catch (e) {
      record.parseError = `JSON 解析失败：${e.message}`;
    }
    record.trains = extractTrains(record.json);
    const resNode = record.json && typeof record.json === 'object' ? record.json.res : null;
    if (resNode && typeof resNode === 'object') {
      record.resLimits = typeof resNode.limits === 'object' && resNode.limits ? resNode.limits : null;
      record.resTruncated = typeof resNode.truncated === 'boolean' ? resNode.truncated : null;
      record.resMeta = {
        schema: resNode.schema ?? null,
        schema_version: resNode.schema_version ?? null,
        version: resNode.version ?? null,
        mode: resNode.mode ?? null,
        includeFullData: resNode.includeFullData ?? null,
        movementCatalogUrl: resNode.movementCatalogUrl ?? resNode.movement_catalog_url ?? null,
      };
    }
    record.classification = record.parseError
      ? { code: 'JSON_PARSE_FAILED', kind: 'unknown', cn: record.parseError, advice: '把原始字节留证（--dump-raw）', messages: [record.parseError] }
      : classifyResponse(resp.status, record.json);
  } catch (e) {
    const name = e?.name || '';
    if (name === 'AbortError') record.networkError = `请求超时（超过 ${cfg.timeoutMs}ms）`;
    else record.networkError = `网络错误：${e?.message || String(e)}`;
    record.classification = {
      code: 'NETWORK_ERROR',
      kind: 'retryable',
      cn: record.networkError,
      advice: '检查网络连通性与代理设置，指数退避后重试',
      messages: [record.networkError],
    };
  } finally {
    clearTimeout(timer);
    record.elapsedMs = Date.now() - startedAt;
  }
  return record;
}

/**
 * 取 res.trains（已核实：成功时核心数据在 res，训练数组在 res.trains）。
 * @param {unknown} json
 * @returns {any[]}
 */
function extractTrains(json) {
  if (!json || typeof json !== 'object') return [];
  const resNode = json.res;
  if (!resNode || typeof resNode !== 'object') return [];
  const trains = resNode.trains;
  return Array.isArray(trains) ? trains : [];
}

/* ============================================================================
 * 6. 冷却与重试（限频是按 datestr 维度的）
 * ==========================================================================*/

/** @type {Map<string, {lastAttemptAt: number, nextAllowedAt: number}>} */
const dayClock = new Map();

/**
 * 服务端自报的读取限频（实测发现：真实响应里带 `res.limits`，里面写明了
 * readRateLimitSeconds / readRateLimitSecondsFull / readRateLimitSecondsLight）。
 * 这比架构里"已核实"的 90 秒更可信，所以一旦探测到就以服务端为准；
 * 探测不到才退回 90 秒常量。
 * @type {number|null}
 */
let serverReadCooldownMs = null;

/**
 * 采纳服务端自报的限频。
 * @param {unknown} limits res.limits 对象
 * @returns {{seconds: number, source: string}|null}
 */
function adoptServerLimits(limits) {
  if (!limits || typeof limits !== 'object') return null;
  const candidates = [
    limits.readRateLimitSeconds,
    limits.readRateLimitSecondsFull,
    limits.readRateLimitSecondsLight,
  ].filter((v) => typeof v === 'number' && v > 0);
  if (candidates.length === 0) return null;
  // 取最大值：无法确认服务端是按模式分桶还是按日期分桶，保守起见按最严的那个来
  const seconds = Math.max(...candidates);
  serverReadCooldownMs = Math.min(seconds * 1000, 300_000);
  return { seconds, source: `res.limits（候选 ${candidates.join(' / ')} 秒，取最严 ${seconds} 秒）` };
}

/**
 * @returns {number} 当前生效的冷却窗口（毫秒）
 */
function currentCooldownMs() {
  return serverReadCooldownMs ?? READ_COOL_DOWN_MS;
}

/**
 * 记录一次请求，并按限定窗口推进该日期的"下次可用时间"。
 * @param {string} datestr
 * @param {number} [forcedWaitMs]
 */
function markAttempt(datestr, forcedWaitMs) {
  const now = Date.now();
  const wait = typeof forcedWaitMs === 'number' && forcedWaitMs > 0 ? forcedWaitMs : currentCooldownMs();
  dayClock.set(datestr, { lastAttemptAt: now, nextAllowedAt: now + wait });
}

/**
 * 按日期等待冷却。限频是**按 datestr 维度**的，所以不同日期之间互不影响。
 * @param {string} datestr
 * @returns {Promise<number>} 实际等待毫秒数
 */
async function waitForCooldown(datestr) {
  const st = dayClock.get(datestr);
  if (!st) return 0;
  const waitMs = st.nextAllowedAt - Date.now();
  if (waitMs <= 0) return 0;
  log(`  ⏳ ${datestr} 处于冷却窗口，等待 ${(waitMs / 1000).toFixed(1)} 秒…（elapsed 计时不停，可去泡杯茶）`);
  await sleep(waitMs);
  return waitMs;
}

/* ============================================================================
 * 7. 字段结构分析（Q2）
 * ==========================================================================*/

/**
 * 递归收集字段路径 → 类型。
 * 数组用 [] 表示，并采样前 MAX_ARRAY_SAMPLES 个元素做字段并集（不同动作可能少了某些可选字段）。
 *
 * @param {unknown} value
 * @param {Set<string>} sink
 * @param {string} prefix
 * @param {number} depth
 */
function collectShape(value, sink, prefix = '', depth = 0) {
  if (depth > MAX_DEPTH) {
    sink.add(`${prefix}: ...(超过递归深度上限)`);
    return;
  }
  if (Array.isArray(value)) {
    // 数组本身记一条（带上长度），元素路径统一用 `前缀[]` 表示，全部元素做字段并集
    sink.add(`${prefix}: array(len=${value.length})`);
    const n = Math.min(value.length, MAX_ARRAY_SAMPLES);
    for (let i = 0; i < n; i += 1) collectShape(value[i], sink, `${prefix}[]`, depth + 1);
    return;
  }
  if (value === null) {
    sink.add(`${prefix}: null`);
    return;
  }
  if (value === undefined) {
    sink.add(`${prefix}: undefined`);
    return;
  }
  if (typeof value === 'object') {
    if (Object.keys(value).length === 0) sink.add(`${prefix}: object(空)`);
    for (const [k, v] of Object.entries(value)) {
      collectShape(v, sink, prefix ? `${prefix}.${k}` : k, depth + 1);
    }
    return;
  }
  sink.add(`${prefix}: ${typeof value}`);
}

/**
 * 对一批 trains 做全量字段并集。
 * @param {any[]} trains
 * @returns {string[]}
 */
function shapeOfTrains(trains) {
  const sink = new Set();
  // 注意前缀不带 []：数组自身会产出 `res.trains: array(len=N)`，元素产出 `res.trains[].xxx`
  collectShape(trains, sink, 'res.trains', 0);
  return [...sink].sort();
}

/**
 * 关键字段存在性检查：给出每个类别是否出现 + 最多 3 条示例路径。
 * @param {string[]} paths
 * @returns {Array<{label: string, exists: boolean, samples: string[]}>}
 */
function checkCriticalFields(paths) {
  return CRITICAL_FIELDS.map((f) => {
    const hits = paths.filter((p) => f.re.test(p));
    return { label: f.label, exists: hits.length > 0, samples: hits.slice(0, 3) };
  });
}

/* ============================================================================
 * 8. 动作名提取（Q4）
 * ==========================================================================*/

/**
 * 判断一个对象是否"像一个动作条目"。
 * @param {unknown} obj
 * @returns {boolean}
 */
function looksLikeMovement(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const name = obj.name ?? obj.movementName ?? obj.exerciseName ?? obj.actionName;
  if (typeof name !== 'string' || name.trim() === '') return false;
  // 至少要带一点动作才有的痕迹，避免把无关对象误当动作
  return Boolean(obj.sets || obj.metrics || obj.cardio || obj.recordPreset || obj.notes || obj.comment || obj.suggestWeight);
}

/**
 * 取出单条训练里的动作数组（含容器路径发现）。
 * @param {any} train
 * @returns {{items: any[], container: string, how: string}}
 */
function extractMovements(train) {
  if (!train || typeof train !== 'object') return { items: [], container: '', how: 'train 不是对象' };
  for (const key of MOVEMENT_CONTAINER_CANDIDATES) {
    const arr = train[key];
    if (Array.isArray(arr)) return { items: arr, container: key, how: '命中候选容器名' };
  }
  // 结构化嗅探：找"元素看起来像动作"的数组字段（容器名未实测确认时的兜底）
  for (const [key, value] of Object.entries(train)) {
    if (Array.isArray(value) && value.length > 0 && value.some(looksLikeMovement)) {
      return { items: value, container: key, how: '结构化嗅探命中（非常规容器名，值得注意）' };
    }
  }
  return { items: [], container: '', how: '未找到动作容器（该训练可能为空/结构不同）' };
}

/**
 * 在一个动作对象内部递归收集所有疑似动作名（含超级组/递减组的子项名）。
 * @param {unknown} node
 * @param {Set<string>} sink
 * @param {number} depth
 */
function collectMovementNames(node, sink, depth = 0) {
  if (depth > MAX_DEPTH || node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const item of node) collectMovementNames(item, sink, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (MOVEMENT_NAME_KEYS.has(k) && typeof v === 'string') {
      const clean = v.trim();
      if (clean !== '') sink.add(clean);
    }
    if (typeof v === 'object') collectMovementNames(v, sink, depth + 1);
  }
}

/**
 * 把一天的数据汇入统计。
 * @param {string} datestr
 * @param {any[]} trains
 * @param {Map<string, {count: number, days: Set<string>}>} nameStat
 * @param {Set<string>} containerPaths
 * @returns {{trains: number, movements: number}}
 */
function accumulateDay(datestr, trains, nameStat, containerPaths) {
  let movements = 0;
  for (const train of trains) {
    const { items, container, how } = extractMovements(train);
    if (container) containerPaths.add(`${container} —— ${how}`);
    for (const mv of items) {
      movements += 1;
      const names = new Set();
      collectMovementNames(mv, names, 0);
      for (const nm of names) {
        const stat = nameStat.get(nm) ?? { count: 0, days: new Set() };
        stat.count += 1;
        stat.days.add(datestr);
        nameStat.set(nm, stat);
      }
    }
  }
  return { trains: trains.length, movements };
}

/* ============================================================================
 * 8.5 关键字段填充率统计
 *
 * 为什么单独做这一节：字段"存在"不等于字段"有值"。实测里 sets[].rpe 字段是存在的，
 * 但 12 周上千个组里一次都没填过——如果只看字段清单会误判成"RPE 可得"。
 * 填充率才决定哪些分析能落地（统计逻辑与 scripts/analyze_probe.mjs 保持一致）。
 * ==========================================================================*/

/**
 * 值是否算"非空"。训记大量用空字符串表示未填（如 rpe: ""），不能用简单 truthy 判断。
 * @param {unknown} v
 * @returns {boolean}
 */
function isNonEmpty(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (typeof v === 'number') return !Number.isNaN(v);
  return true;
}

/**
 * 需要统计填充率的字段清单。
 * level 决定分母：train=训练条数、movement=动作条目数、set=组数。
 * seen 统计"该字段在对象里出现过"，filled 统计"出现过且非空"——
 * 两者不同：seen=0 说明这个模式下服务端根本没返回该字段（典型如轻量模式下的 rpe）。
 */
const FILL_FIELDS = [
  { level: 'train', key: 'title', label: 'train.title 训练标题', test: isNonEmpty },
  { level: 'train', key: 'note', label: 'train.note 训练备注', test: isNonEmpty },
  { level: 'train', key: 'localid', label: 'train.localid 本地 ID', test: isNonEmpty },
  { level: 'train', key: 'start', label: 'train.start 开始时间', test: (v) => typeof v === 'number' && v > 0 },
  { level: 'train', key: 'end', label: 'train.end 结束时间', test: (v) => typeof v === 'number' && v > 0 },
  { level: 'movement', key: 'note', label: 'movements[].note 动作备注', test: isNonEmpty },
  { level: 'movement', key: 'restTime', label: 'movements[].restTime 组间歇', test: isNonEmpty },
  { level: 'movement', key: 'type', label: 'movements[].type 动作类型', test: isNonEmpty },
  { level: 'movement', key: 'exetype', label: 'movements[].exetype 动作子类', test: isNonEmpty },
  { level: 'movement', key: 'singleSide', label: 'movements[].singleSide 单侧动作', test: (v) => v === true || v === 'true' || v === 1 },
  { level: 'set', key: 'rpe', label: 'sets[].rpe 主观强度', test: isNonEmpty },
  { level: 'set', key: 'note', label: 'sets[].note 组备注', test: isNonEmpty },
  { level: 'set', key: 'comment', label: 'sets[].comment 组评论', test: isNonEmpty },
  { level: 'set', key: 'setType', label: 'sets[].setType 组类型（热身等）', test: isNonEmpty },
  { level: 'set', key: 'done', label: 'sets[].done === false 未打勾组', test: (v) => v === false, hit: '未完成组' },
  { level: 'set', key: 'time', label: 'sets[].time > 0 实练秒数', test: (v) => typeof v === 'number' && v > 0 },
  { level: 'set', key: 'leftWeight', label: 'sets[].leftWeight 左侧重量', test: isNonEmpty },
  { level: 'set', key: 'weight', label: 'sets[].weight 重量', test: isNonEmpty },
  { level: 'set', key: 'reps', label: 'sets[].reps 次数', test: isNonEmpty },
  { level: 'set', key: 'selfWeight', label: 'sets[].selfWeight 自重', test: (v) => v === true },
  { level: 'set', key: 'metrics', label: 'sets[].metrics 有氧指标对象', test: (v) => Boolean(v) && typeof v === 'object' && Object.keys(v).length > 0 },
];

/**
 * 新建填充率统计容器。
 * @returns {object}
 */
function newFillStats() {
  return {
    levels: { train: 0, movement: 0, set: 0 },
    fields: FILL_FIELDS.map((f) => ({
      label: f.label,
      level: f.level,
      key: f.key,
      hit: f.hit || '',
      test: f.test,
      seen: 0,
      filled: 0,
    })),
    durationsMin: [],
    leftAsym: 0,
    setTypeDist: new Map(),
    movementTypeDist: new Map(),
    exetypeDist: new Map(),
    truncatedDays: 0,
    truncatedTrains: 0,
    truncatedMovements: 0,
  };
}

/**
 * 把一天的数据汇入填充率统计。
 *
 * @param {object} stats newFillStats() 的返回值
 * @param {any[]} trains
 * @param {boolean|null} resTruncated 该天 res.truncated 标记
 */
function accumulateFill(stats, trains, resTruncated) {
  if (resTruncated === true) stats.truncatedDays += 1;
  const bump = (map, key) => map.set(key ?? '(空)', (map.get(key ?? '(空)') ?? 0) + 1);

  for (const train of trains) {
    stats.levels.train += 1;
    if (train?.truncated === true) stats.truncatedTrains += 1;
    if (typeof train?.start === 'number' && typeof train?.end === 'number' && train.end > train.start) {
      stats.durationsMin.push((train.end - train.start) / 60_000);
    }
    for (const f of stats.fields) {
      if (f.level !== 'train') continue;
      if (train && Object.prototype.hasOwnProperty.call(train, f.key)) {
        f.seen += 1;
        if (f.test(train[f.key])) f.filled += 1;
      }
    }

    for (const mv of train?.movements ?? []) {
      stats.levels.movement += 1;
      if (mv?.truncated === true) stats.truncatedMovements += 1;
      bump(stats.movementTypeDist, typeof mv?.type === 'string' && mv.type.trim() !== '' ? mv.type : '');
      bump(stats.exetypeDist, typeof mv?.exetype === 'string' && mv.exetype.trim() !== '' ? mv.exetype : '');
      for (const f of stats.fields) {
        if (f.level !== 'movement') continue;
        if (mv && Object.prototype.hasOwnProperty.call(mv, f.key)) {
          f.seen += 1;
          if (f.test(mv[f.key])) f.filled += 1;
        }
      }

      for (const s of mv?.sets ?? []) {
        stats.levels.set += 1;
        bump(stats.setTypeDist, typeof s?.setType === 'string' && s.setType.trim() !== '' ? s.setType : '');
        if (
          isNonEmpty(s?.leftWeight) && isNonEmpty(s?.weight) &&
          String(s.leftWeight) !== String(s.weight)
        ) {
          stats.leftAsym += 1;
        }
        for (const f of stats.fields) {
          if (f.level !== 'set') continue;
          if (s && Object.prototype.hasOwnProperty.call(s, f.key)) {
            f.seen += 1;
            if (f.test(s[f.key])) f.filled += 1;
          }
        }
      }
    }
  }
}

/* ============================================================================
 * 9. 探针主流程
 * ==========================================================================*/

/**
 * 带冷却/重试的单天拉取：用于正常（期望成功）的请求。
 * @param {object} cfg 同 requestDayRaw 的 cfg
 * @param {string} datestr
 * @param {boolean} includeFullData
 * @param {number} maxRetry
 * @returns {Promise<{record: object, waitsMs: number}>}
 */
async function fetchDay(cfg, datestr, includeFullData, maxRetry = 2) {
  let totalWait = 0;
  let attempts = 0;
  let last = null;
  while (attempts <= maxRetry) {
    attempts += 1;
    totalWait += await waitForCooldown(datestr);
    const record = await requestDayRaw(cfg, datestr, includeFullData);
    last = record;
    markAttempt(datestr, record.classification?.retryMs);
    const kind = record.classification?.kind;
    if (kind === 'ok') return { record, waitsMs: totalWait };
    if (kind === 'fatal' || kind === 'unknown') return { record, waitsMs: totalWait };
    if (attempts > maxRetry) return { record, waitsMs: totalWait };
    // retryable：网络错误 / 5xx / too frequent
    const backoffMs = Math.min(record.classification?.retryMs ?? READ_COOL_DOWN_MS, 300_000);
    log(`  ↻ ${datestr} 第 ${attempts} 次失败（${record.classification.cn}），等待 ${(backoffMs / 1000).toFixed(1)} 秒后重试`);
    await sleep(backoffMs);
    totalWait += backoffMs;
  }
  return { record: last, waitsMs: totalWait };
}

/**
 * 打印一条请求记录的单行摘要。
 * @param {object} record
 * @param {string} indent
 */
function logRecord(record, indent = '  ') {
  const c = record.classification ?? { code: '?', cn: '?' };
  const sizeInfo = `${record.compressedBytes}B→${record.decodedBytes}B`;
  log(
    `${indent}HTTP ${record.httpStatus || '-'} | ${record.mode} | ${record.elapsedMs}ms | ${sizeInfo} | ${record.encoding} | trains=${record.trains.length} | ${c.code} ${c.cn}`,
  );
}

/**
 * 执行全部探针阶段。
 *
 * @param {{baseUrl: string, key: string, timeoutMs: number}} cfg
 * @param {object} opts 命令行选项
 * @returns {Promise<object>} 报告数据
 */
async function runProbe(cfg, opts) {
  const report = {
    startedAt: nowStamp(),
    finishedAt: '',
    nodeVersion: process.version,
    platform: `${process.platform}/${process.arch}`,
    options: opts,
    baseUrl: cfg.baseUrl,
    keyMasked: maskKey(cfg.key),
    exitReason: '',
    verdict: {},
    /** 服务端自报的限频与容量约束（res.limits），实测发现，架构文档里没有 */
    serverLimits: null,
    serverLimitsNote: '',
    // Q1
    connectivity: null,
    // Q2
    fieldShape: {
      envelopeKeys: [],
      resKeys: [],
      trainKeys: [],
      movementContainerPaths: [],
      lightPaths: [],
      fullPaths: [],
      onlyFull: [],
      onlyLight: [],
      criticalLight: [],
      criticalFull: [],
      lightSample: '',
      fullTrainsSample: '',
      /** 做 true/false 对比用的样本日：必须是"有训练且含动作"的那天，否则对比全是空集 */
      sampleDate: '',
      sampleReason: '',
      /** 没能完成对比时，必须显式说明原因，而不是输出"（无）"让人误以为没有差异 */
      comparisonNote: '',
    },
    // 填充率（决定哪些分析能落地，比字段是否存在更重要）
    fill: null,
    // Q3
    ratelimit: {
      enabled: opts.rateTest,
      sameDaySecondCall: null,
      recoveryCall: null,
      crossDay: [],
      observedTooFrequentRaw: '',
      retryExtractSource: '',
      crossDayBlocked: false,
      note: '',
    },
    // Q4
    coverage: {
      daysScanned: 0,
      daysRequested: [],
      daysWithTrains: 0,
      daysFailed: 0,
      trainsCount: 0,
      movementsCount: 0,
      names: [],
      perDay: [],
    },
    rawDumps: [],
    requestCount: 0,
  };

  /**
   * 同一天同一模式的返回在短时间内不会变化，缓存起来跨阶段复用。
   * 为什么必须缓存：每多打一次同一个日期，就要多等一轮冷却；
   * 而且阶段 3 会先拉 anchor-1 / anchor-2，若阶段 4 再重拉一遍就是纯粹的浪费。
   * @type {Map<string, object>} key = `${datestr}#${mode}`
   */
  const cache = new Map();

  /**
   * @param {object} record
   * @returns {object}
   */
  const cachePut = (record) => {
    cache.set(`${record.datestr}#${record.mode}`, record);
    report.requestCount += 1;
    return record;
  };

  /**
   * @param {string} datestr
   * @param {'light'|'full'} mode
   * @param {boolean} allowCrossMode 是否允许拿另一种模式的同日数据顶替（统计动作名时可以）
   * @returns {object|null}
   */
  const cacheFind = (datestr, mode, allowCrossMode) => {
    const isOk = (r) => r && (r.classification ?? {}).kind === 'ok';
    const exact = cache.get(`${datestr}#${mode}`);
    if (isOk(exact)) return exact;
    if (!allowCrossMode) return null;
    const other = cache.get(`${datestr}#${mode === 'full' ? 'light' : 'full'}`);
    return isOk(other) ? other : null;
  };

  /**
   * 取某天某模式的数据：命中缓存直接复用，未命中才真正发请求。
   *
   * @param {string} datestr
   * @param {'light'|'full'} mode
   * @param {{respectCooldown?: boolean, maxRetry?: number, allowCrossMode?: boolean}} [options]
   * @returns {Promise<{record: object, reused: boolean}>}
   */
  const obtain = async (datestr, mode, options = {}) => {
    const { respectCooldown = true, maxRetry = 1, allowCrossMode = true } = options;
    const hit = cacheFind(datestr, mode, allowCrossMode);
    if (hit) return { record: hit, reused: true };
    let record;
    if (!respectCooldown) {
      // 首次请求 / 刻意做限频实验：不等冷却
      record = await requestDayRaw(cfg, datestr, mode === 'full');
      markAttempt(datestr, record.classification?.retryMs);
    } else {
      record = (await fetchDay(cfg, datestr, mode === 'full', maxRetry)).record;
    }
    return { record: cachePut(record), reused: false };
  };

  /* ---------- 阶段 1：Q1 连通性 ---------- */
  // 用与后续扫描相同的模式，这样阶段 4 的第一天能直接命中缓存，不多打一次请求、不多等一轮冷却
  const scanMode = opts.full ? 'full' : 'light';
  log(`\n【阶段 1 / 5】Q1 连通性与权限：读取 ${opts.date}（include_full_data=${opts.full}）`);
  const firstRun = await obtain(opts.date, scanMode, { respectCooldown: false });
  const first = firstRun.record;
  logRecord(first);
  report.connectivity = recordToSummary(first);

  // 服务端会在 res.limits 里自报限频与容量约束，比文档里的"90 秒"更可信，探测到就以它为准
  const adopted = adoptServerLimits(first.resLimits);
  if (adopted) {
    report.serverLimits = first.resLimits;
    report.serverLimitsNote = adopted.source;
    log(`  ℹ 服务端自报读取限频：${adopted.seconds} 秒（依据 ${adopted.source}）→ 后续冷却按此值执行`);
  }

  const firstClass = first.classification ?? { kind: 'unknown', code: '?', cn: '?', advice: '' };
  if (firstClass.kind === 'fatal') {
    report.exitReason = `FATAL:${firstClass.code}`;
    report.fieldShape.lightSample = snippet(first.rawText);
    log(`\n✗ 连通性失败（致命）：${firstClass.cn}`);
    log(`  处理建议：${firstClass.advice}`);
    log('  按架构 §6.4 约定：该错误不重试，立即终止整轮探针。');
    report.finishedAt = nowStamp();
    report.verdict = buildVerdict(report, 'failed');
    return report;
  }
  if (firstClass.kind !== 'ok') {
    // 非致命但首次就失败（网络/限频/解析错误）→ 按退避重试一次，仍失败则终止
    log(`  首次请求未成功（${firstClass.cn}），按退避等待后重试一次…`);
    await sleep(Math.min(firstClass.retryMs ?? currentCooldownMs(), 300_000));
    const retryStrategy = await requestDayRaw(cfg, opts.date, opts.full);
    markAttempt(opts.date, retryStrategy.classification?.retryMs);
    cachePut(retryStrategy);
    const retry = retryStrategy;
    logRecord(retry, '  (重试)');
    report.connectivity = recordToSummary(retry);
    if ((retry.classification ?? {}).kind !== 'ok') {
      report.exitReason = `FAILED:${retry.classification?.code}`;
      report.fieldShape.lightSample = snippet(retry.rawText);
      log(`\n✗ 仍无法成功读取（${retry.classification?.cn}）。请先看网络/限频，再重跑探针。`);
      report.finishedAt = nowStamp();
      report.verdict = buildVerdict(report, 'failed');
      return report;
    }
    Object.assign(first, retry);
  }

  log(`  ✓ 连通性通过：HTTP ${first.httpStatus}、读取成功、trains=${first.trains.length}`);
  // 这里只记录外壳结构；true/false 的字段对比统一放到阶段 5，用"有数据"的样本日来做
  report.fieldShape.envelopeKeys = Object.keys(first.json ?? {}).sort();
  const resNode = first.json?.res;
  report.fieldShape.resKeys = resNode && typeof resNode === 'object' ? Object.keys(resNode).sort() : [];
  report.fieldShape.trainKeys = collectTopKeys(first.trains);
  if (first.trains.length > 0) {
    const sample = shapeOfTrains(first.trains);
    if (scanMode === 'light') report.fieldShape.lightPaths = sample;
    else report.fieldShape.fullPaths = sample;
  }

  /* ---------- 阶段 2：Q3-1 同日连续第二次请求（预期触发 too frequent） ---------- */
  if (opts.rateTest) {
    log('\n【阶段 2 / 5】Q3 限频行为 A：同一天立刻再请求一次（预期返回 too frequent，不等冷却）');
    const second = await requestDayRaw(cfg, opts.date, opts.full);
    markAttempt(opts.date, second.classification?.retryMs);
    logRecord(second);
    report.ratelimit.sameDaySecondCall = recordToSummary(second);
    if (second.classification?.code === 'TOO_FREQUENT') {
      report.ratelimit.observedTooFrequentRaw = snippet(second.rawText);
      report.ratelimit.retryExtractSource = second.classification.retrySource || '';
      log(`  ✓ 已复现限频；重试等待判定依据：${second.classification.retrySource}`);
    } else {
      log(`  ! 第二次同日请求未触发 too frequent（${second.classification?.cn}）。`);
      log('    说明服务端对该账号/该日期的限制可能比文档描述更宽松，或计费口径不同——如实记录，不要臆断。');
    }
  } else {
    log('\n【阶段 2 / 5】Q3 限频行为 A：已通过 --no-rate-test 跳过');
  }

  /* ---------- 阶段 3：Q3-2 跨日期是否互不阻塞 ---------- */
  log('\n【阶段 3 / 5】Q3 限频行为 B：连续请求两个不同日期，验证不同日期是否互不阻塞');
  const crossDates = [shiftDays(opts.date, -1), shiftDays(opts.date, -2)];
  for (const d of crossDates) {
    const { record: rec, reused } = await obtain(d, scanMode);
    const kind = rec.classification?.kind;
    if (reused) log(`  ${d}：复用已有数据，未重复请求`);
    else logRecord(rec);
    report.ratelimit.crossDay.push(recordToSummary(rec));
    if (kind !== 'ok') {
      // 不同日期也被拒 → 高度怀疑存在全局 QPS/并发限制（架构 Q23）
      report.ratelimit.crossDayBlocked = true;
      log(`  ⚠ 不同日期同样被拒：${rec.classification?.cn}`);
      log('    → 这提示可能存在"全局限频"而不只是"按日期限频"。首次同步务必保持串行（并发 1）。');
    }
    if (opts.delayMs > 0 && !reused) await sleep(opts.delayMs);
  }
  report.ratelimit.note = opts.rateTest
    ? `本次 --delay-ms=${opts.delayMs}ms；若想做最严格的跨日测试，可用 --delay-ms 0 重跑。`
    : '未做同日限频实验（--no-rate-test）。';

  /* ---------- 阶段 4：Q4 动作名覆盖扫描 + 关键字段填充率统计 ---------- */
  /** @type {Map<string, {count: number, days: Set<string>}>} */
  const nameStat = new Map();
  /** @type {Set<string>} */
  const containerPaths = new Set(report.fieldShape.movementContainerPaths);
  /** @type {object} */
  const fillStats = newFillStats();
  /** 字段对比的样本日：必须是"有训练且含动作"的那天，否则对比两边都是空集，结论会完全反过来 */
  let sampleDay = { datestr: '', trains: 0, movements: 0, sets: 0 };

  const window = opts.days > 0 ? buildDateWindow(opts.date, opts.days) : [];
  if (window.length === 0) {
    log('\n【阶段 4 / 5】Q4 覆盖扫描与填充率：--days=0，跳过');
  } else {
    log(`\n【阶段 4 / 5】Q4 覆盖扫描与填充率：串行拉取 ${window.length} 天（${window[window.length - 1]} ~ ${window[0]}），逐日间隔 ${opts.delayMs}ms`);
    if (opts.days > 7) log('  ⚠ 天数较多，总耗时 ≈ 天数 ×（请求耗时 + 偶发冷却），请耐心等待');
  }

  for (const datestr of window) {
    // allowCrossMode=true：同一天已有另一种模式的数据时直接复用，不再触发新一轮冷却
    const { record, reused } = await obtain(datestr, scanMode, { maxRetry: 1, allowCrossMode: true });
    const ok = (record.classification ?? {}).kind === 'ok';
    if (ok) {
      const stat = accumulateDay(datestr, record.trains, nameStat, containerPaths);
      accumulateFill(fillStats, record.trains, record.resTruncated);
      const sets = countSets(record.trains);
      report.coverage.perDay.push({ datestr, ...stat, sets, source: reused ? `reuse-${record.mode}` : record.mode, ok: true });
      log(`  ${datestr}：${reused ? '复用已有数据 ' : ''}trains=${stat.trains} movements=${stat.movements} sets=${sets}`);
      // 选"组数最多"的那天做字段对比样本：样本越丰富，字段并集越完整
      if (stat.trains > 0 && stat.movements > 0 && sets > sampleDay.sets) {
        sampleDay = { datestr, trains: stat.trains, movements: stat.movements, sets };
      }
      if (opts.dumpRaw) report.rawDumps.push(dumpRaw(datestr, record.json, opts));
    } else {
      report.coverage.perDay.push({ datestr, trains: 0, movements: 0, sets: 0, source: record.classification?.code ?? '?', ok: false });
      log(`  ${datestr}：失败 ${record.classification?.code} ${record.classification?.cn}`);
    }
    report.coverage.daysRequested.push(datestr);
    if (opts.delayMs > 0 && !reused) await sleep(opts.delayMs);
  }
  report.fill = fillStats;

  /* ---------- 阶段 5：Q2 字段结构对比（用上一步挑出的"有数据"样本日） ---------- */
  if (!opts.full) {
    report.fieldShape.comparisonNote = '本次以 --no-full 运行，未做 include_full_data=true / false 的字段对比。';
    log('\n【阶段 5 / 5】Q2 字段结构：已通过 --no-full 跳过对比');
  } else if (!sampleDay.datestr) {
    // 关键：宁可不给结论，也不能给出"无差异"这种与事实相反的结论
    report.fieldShape.comparisonNote =
      `本次未能完成字段对比：窗口（${opts.days} 天，${opts.date} 及之前）内没有任何「含训练且含动作」的日期，样本为空。` +
      '这不代表两种模式没有差异，请用 --days 扩大窗口或把 --date 指定到一个有训练的日子后重跑。';
    log('\n【阶段 5 / 5】Q2 字段结构：✗ 未能完成对比');
    log(`  ${report.fieldShape.comparisonNote}`);
  } else {
    log(`\n【阶段 5 / 5】Q2 字段结构：用样本日 ${sampleDay.datestr}（trains=${sampleDay.trains} movements=${sampleDay.movements} sets=${sampleDay.sets}）对比两种模式`);
    report.fieldShape.sampleDate = sampleDay.datestr;
    report.fieldShape.sampleReason = `窗口内训练内容最丰富的一天（${sampleDay.trains} 条训练 / ${sampleDay.movements} 个动作 / ${sampleDay.sets} 个组）`;

    // full 数据已在阶段 4 拿到（缓存命中），这里补一次轻量模式；allowCrossMode=false 防止拿 full 冒充 light
    const { record: lightRec, reused: lightReused } = await obtain(sampleDay.datestr, 'light', { allowCrossMode: false, maxRetry: 1 });
    const fullRec = cacheFind(sampleDay.datestr, 'full', false) ?? null;
    if (lightReused) log('  轻量模式：复用已有数据');
    else logRecord(lightRec, '  轻量模式：');

    if ((lightRec.classification ?? {}).kind !== 'ok') {
      report.fieldShape.comparisonNote = `样本日 ${sampleDay.datestr} 的轻量模式读取失败（${lightRec.classification?.cn}），无法完成对比。`;
      log(`  ✗ ${report.fieldShape.comparisonNote}`);
    } else if (!fullRec) {
      report.fieldShape.comparisonNote = `样本日 ${sampleDay.datestr} 缺少 include_full_data=true 的数据，无法完成对比。`;
      log(`  ✗ ${report.fieldShape.comparisonNote}`);
    } else {
      report.fieldShape.lightPaths = shapeOfTrains(lightRec.trains);
      report.fieldShape.fullPaths = shapeOfTrains(fullRec.trains);
      report.fieldShape.criticalLight = checkCriticalFields(report.fieldShape.lightPaths);
      report.fieldShape.criticalFull = checkCriticalFields(report.fieldShape.fullPaths);
      const lightSet = new Set(report.fieldShape.lightPaths);
      const fullSet = new Set(report.fieldShape.fullPaths);
      report.fieldShape.onlyFull = [...fullSet].filter((p) => !lightSet.has(p)).sort();
      report.fieldShape.onlyLight = [...lightSet].filter((p) => !fullSet.has(p)).sort();
      report.fieldShape.lightSample = snippet(safeJson(lightRec.trains[0] ?? null, MAX_SNIPPET_CHARS));
      report.fieldShape.fullTrainsSample = snippet(safeJson(fullRec.trains[0] ?? null, MAX_SNIPPET_CHARS));
      const containers = new Set(report.fieldShape.movementContainerPaths);
      extractContainerPaths(fullRec.trains, containers);
      report.fieldShape.movementContainerPaths = [...containers];
      log(`  ✓ 对比完成：轻量 ${report.fieldShape.lightPaths.length} 条路径 / 完整 ${report.fieldShape.fullPaths.length} 条路径`);
      log(`    full 模式独有 ${report.fieldShape.onlyFull.length} 条：${report.fieldShape.onlyFull.join(', ') || '（无）'}`);
    }
  }

  report.fieldShape.movementContainerPaths = [...containerPaths];
  report.coverage.daysScanned = report.coverage.perDay.length;
  report.coverage.daysWithTrains = report.coverage.perDay.filter((d) => d.ok && d.trains > 0).length;
  report.coverage.daysFailed = report.coverage.perDay.filter((d) => !d.ok).length;
  report.coverage.trainsCount = report.coverage.perDay.reduce((sum, d) => sum + (d.ok ? d.trains : 0), 0);
  report.coverage.movementsCount = report.coverage.perDay.reduce((sum, d) => sum + (d.ok ? d.movements : 0), 0);
  report.coverage.names = [...nameStat.entries()]
    .map(([name, stat]) => ({ name, count: stat.count, days: [...stat.days].sort() }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hans-CN'));

  log(`\n✓ 探针完成：${report.coverage.daysScanned} 天 / ${report.coverage.trainsCount} 条训练 / ${report.coverage.movementsCount} 个动作条目 / 去重动作名 ${report.coverage.names.length} 个`);

  report.exitReason = 'OK';
  report.finishedAt = nowStamp();
  report.verdict = buildVerdict(report, 'ok');
  return report;
}

/**
 * 把请求记录压成报告里用的摘要（不含原始大对象）。
 * @param {object} record
 * @returns {object}
 */
function recordToSummary(record) {
  const c = record.classification ?? {};
  return {
    datestr: record.datestr,
    mode: record.mode,
    httpStatus: record.httpStatus,
    elapsedMs: record.elapsedMs,
    encoding: record.encoding,
    compressedBytes: record.compressedBytes,
    decodedBytes: record.decodedBytes,
    trains: record.trains.length,
    code: c.code ?? '?',
    kind: c.kind ?? '?',
    cn: c.cn ?? '',
    advice: c.advice ?? '',
    messages: (c.messages ?? []).slice(0, 5),
    retryMs: c.retryMs ?? null,
    retrySource: c.retrySource ?? '',
    networkError: record.networkError,
    parseError: record.parseError,
  };
}

/**
 * 汇总一条训练里的动作容器路径。
 * @param {any[]} trains
 * @param {Set<string>} sink
 */
function extractContainerPaths(trains, sink) {
  for (const train of trains) {
    const { container, how } = extractMovements(train);
    if (container) sink.add(`${container} —— ${how}`);
  }
}

/**
 * 收集 trains 数组里出现过的一级字段 key（并集）。
 * @param {any[]} trains
 * @returns {string[]}
 */
function collectTopKeys(trains) {
  const keys = new Set();
  for (const t of trains) {
    if (t && typeof t === 'object' && !Array.isArray(t)) {
      for (const k of Object.keys(t)) keys.add(k);
    }
  }
  return [...keys].sort();
}

/**
 * 统计一批训练里的总组数（含超级组子项所在的父组，按父组计数一次）。
 * @param {any[]} trains
 * @returns {number}
 */
function countSets(trains) {
  let total = 0;
  for (const train of trains) {
    const { items } = extractMovements(train);
    for (const mv of items) {
      if (Array.isArray(mv?.sets)) total += mv.sets.length;
    }
  }
  return total;
}

/**
 * JSON 安全序列化（截断 + 脱敏）。
 * @param {unknown} value
 * @param {number} maxChars
 * @returns {string}
 */
function safeJson(value, maxChars = MAX_SNIPPET_CHARS) {
  if (value === null || value === undefined) return '(无数据)';
  try {
    const text = JSON.stringify(value, null, 2);
    return snippet(text, maxChars);
  } catch (e) {
    return `(序列化失败：${e.message})`;
  }
}

/**
 * 文本截断（保留可读的前半部分）。
 * @param {string} text
 * @param {number} maxChars
 * @returns {string}
 */
function snippet(text, maxChars = 1_200) {
  const s = String(text ?? '');
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}\n…（已截断，原长 ${s.length} 字符）`;
}

/**
 * 落盘原始 JSON（可选，--dump-raw）。
 * @param {string} datestr
 * @param {unknown} json
 * @param {object} opts
 * @returns {string} 写入的路径
 */
function dumpRaw(datestr, json, opts) {
  const dir = path.resolve(process.cwd(), DEFAULT_RAW_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${datestr}.json`);
  fs.writeFileSync(file, safe(JSON.stringify(json, null, 2)), 'utf8');
  return file;
}

/* ============================================================================
 * 10. 报告渲染
 * ==========================================================================*/

/**
 * Markdown 表格：注意转义单元格里的竖线，避免破坏表格结构。
 * @param {string[]} headers
 * @param {string[][]} rows
 * @returns {string}
 */
function mdTable(headers, rows) {
  const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
  const head = `| ${headers.map(esc).join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.length ? rows.map((r) => `| ${r.map(esc).join(' | ')} |`).join('\n') : `| ${headers.map(() => '（无）').join(' | ')} |`;
  return [head, sep, body].join('\n');
}

/**
 * @param {string} title
 * @param {string} content
 * @returns {string}
 */
function mdCode(content, title = '') {
  const body = String(content ?? '').trim();
  if (!body) return '（无）';
  return `${title ? `**${title}**\n\n` : ''}\`\`\`json\n${body}\n\`\`\``;
}

/**
 * 生成结论速览。
 * @param {object} report
 * @param {'ok'|'failed'} state
 * @returns {Array<[string, string, string]>}
 */
function buildVerdict(report, state) {
  const rows = [];
  if (state === 'failed') {
    const c = report.connectivity ?? {};
    rows.push(['Q1 连通性与权限', `失败：${c.cn ?? '未知'}`, c.code === 'VIP_REQUIRED' ? '需用户处理' : '需用户处理']);
    rows.push(['Q2 字段结构', '未采集（连通性未通过，后续阶段未执行）', '待补']);
    rows.push(['Q3 限频行为', '未采集（连通性未通过）', '待补']);
    rows.push(['Q4 动作名覆盖', '未采集（连通性未通过）', '待补']);
    return rows;
  }
  const fsRows = report.fieldShape;
  rows.push(['Q1 连通性与权限', `通过：Key 有效且账号有权限（HTTP ${report.connectivity?.httpStatus}）`, '已确认']);
  const fill = report.fill;
  rows.push([
    '★ 关键字段填充率',
    fill
      ? `${fill.levels.set} 个组 / ${fill.levels.movement} 个动作 / ${fill.levels.train} 条训练；RPE 填充 ${fillRate(fill, 'sets[].rpe 主观强度')}`
      : '未采集',
    '已确认',
  ]);
  rows.push([
    'Q2 字段结构',
    fsRows.comparisonNote
      ? `未得出结论：${fsRows.comparisonNote}`
      : `样本日 ${fsRows.sampleDate || '-'}：轻量 ${fsRows.lightPaths.length} 条 / 完整 ${fsRows.fullPaths.length} 条；full 独有 ${fsRows.onlyFull.length} 条`,
    fsRows.comparisonNote ? '未确认' : '已确认',
  ]);
  const rl = report.ratelimit;
  const same = rl.sameDaySecondCall;
  rows.push([
    'Q3 限频行为',
    same
      ? `同日二次请求返回 ${same.code}；跨日期 ${rl.crossDayBlocked ? '疑似也被限（注意全局限制）' : '互不阻塞'}`
      : '未做同日实验（--no-rate-test）',
    '已确认',
  ]);
  rows.push([
    'Q4 动作名覆盖',
    `${report.coverage.daysScanned} 天 / ${report.coverage.trainsCount} 条训练 / 去重动作名 ${report.coverage.names.length} 个`,
    report.coverage.names.length > 0 ? '已确认' : '无数据（可能这些天没有训练）',
  ]);
  return rows;
}

/**
 * 取某个统计字段的填充率文本（找不到/未返回时给出明确说明，不写 0% 误导人）。
 * @param {object} stats
 * @param {string} label
 * @returns {string}
 */
function fillRate(stats, label) {
  const f = stats?.fields?.find((x) => x.label === label);
  if (!f) return 'n/a';
  const total = stats.levels[f.level] ?? 0;
  if (f.seen === 0) return '字段未返回';
  return total ? `${Math.round((f.filled / total) * 100)}%` : 'n/a';
}

/**
 * 取某个统计字段的填充率数值（0~1）；字段未返回时返回 null。
 * @param {object} stats
 * @param {string} label
 * @returns {number|null}
 */
function fillRatio(stats, label) {
  const f = stats?.fields?.find((x) => x.label === label);
  if (!f || f.seen === 0) return null;
  const total = stats.levels[f.level] ?? 0;
  return total ? f.filled / total : 0;
}

/**
 * 渲染「关键字段填充率」章节。这一节比字段清单更重要：
 * 字段存在 ≠ 字段有值，填充率才决定哪些分析能落地。
 *
 * @param {object} report
 * @returns {string}
 */
function renderFillSection(report) {
  const fill = report.fill;
  const lines = [];
  lines.push('## 1. 关键字段填充率（决定哪些分析能落地）');
  lines.push('');
  if (!fill || fill.levels.train === 0) {
    lines.push('未采集到任何训练数据（扫描窗口内没有训练，或 --days=0）。填充率无从统计，需换窗口重跑。');
    lines.push('');
    return lines.join('\n');
  }

  const denom = { train: fill.levels.train, movement: fill.levels.movement, set: fill.levels.set };
  lines.push(
    mdTable(
      ['指标', '值'],
      [
        ['统计样本', `${fill.levels.train} 条训练 / ${fill.levels.movement} 个动作 / ${fill.levels.set} 个组`],
        ['统计口径', `非空占比（分母 = 该层级样本总数；"字段出现"数 < 样本数说明该字段只在部分对象里返回）`],
      ],
    ),
  );
  lines.push('');
  lines.push(
    mdTable(
      ['字段', '层级样本', '字段出现', '非空/命中', '填充率', '备注'],
      fill.fields.map((f) => {
        const total = denom[f.level] ?? 0;
        if (f.seen === 0) {
          return [f.label, String(total), '0', '-', '**字段未返回**', '该模式下服务端没有下发此字段（典型：轻量模式下的 rpe / note / comment）'];
        }
        const rate = total ? `${Math.round((f.filled / total) * 100)}%` : 'n/a';
        return [f.label, String(total), String(f.seen), String(f.filled), rate, f.hit ? `命中即"${f.hit}"` : ''];
      }),
    ),
  );
  lines.push('');

  /* 由填充率推导出的架构结论 */
  const bullets = [];
  const rpe = fillRatio(fill, 'sets[].rpe 主观强度');
  if (rpe === null) bullets.push('RPE：本次模式下服务端未返回该字段，无法统计。若要评估 RPE 可得性，请用完整模式（默认）重跑。');
  else if (rpe < 0.1) bullets.push(`**RPE 填充率仅 ${Math.round(rpe * 100)}%** —— 依赖 RPE 的疲劳/强度判定必须降级为 \`insufficient_data\`（架构 §9.5 已列此风险），UI 需提示用户训练后补打 RPE。`);
  else if (rpe < 0.5) bullets.push(`RPE 填充率 ${Math.round(rpe * 100)}%（偏低）—— 依赖 RPE 的判定只能作为辅助信号，不能单独下结论。`);
  else bullets.push(`RPE 填充率 ${Math.round(rpe * 100)}%，可以作为强度/疲劳判定的输入。`);

  const undone = fillRatio(fill, 'sets[].done === false 未打勾组');
  if (undone === null) bullets.push('未打勾组：本次模式下服务端未返回 done 字段，无法统计。');
  else if (undone > 0) bullets.push(`未打勾组（done=false）占比 ${Math.round(undone * 100)}% —— 有效组口径必须排除这些组（架构 §6.2.4 已定死：done=false 落库但不计入有效组）。`);
  else bullets.push('未打勾组：0%，所有组都是已完成状态。');

  const titleRate = fillRatio(fill, 'train.title 训练标题');
  if (titleRate !== null && titleRate < 1) {
    bullets.push(`训练标题有 ${Math.round((1 - titleRate) * 100)}% 为空 —— 列表/计划页不能只靠标题展示，需用日期 + 首个动作名兜底。`);
  }

  const timeRate = fillRatio(fill, 'sets[].time > 0 实练秒数');
  if (timeRate !== null) {
    bullets.push(`组级实练秒数（time>0）只有 ${Math.round(timeRate * 100)}% 的组有值 —— 训练时长应以 train.start/end 为准，不要用组级 time 求和。`);
  }

  const leftRate = fillRatio(fill, 'sets[].leftWeight 左侧重量');
  if (leftRate !== null) {
    bullets.push(`左侧重量字段填充 ${Math.round(leftRate * 100)}%，其中左右不等重的组 ${fill.leftAsym} 个 —— 左右侧训练量折算口径需要用户确认（架构 Q5）。`);
  }

  const metricsRate = fillRatio(fill, 'sets[].metrics 有氧指标对象');
  if (metricsRate !== null && metricsRate > 0) {
    bullets.push(`有氧指标（metrics）在 ${Math.round(metricsRate * 100)}% 的组里出现 —— 解析器必须处理有氧分支（distance/kcal/心率）。`);
  }

  if (fill.durationsMin.length) {
    const sorted = fill.durationsMin.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    bullets.push(`训练时长（由 start/end 推算）：中位数 ${median.toFixed(0)} 分钟，区间 ${sorted[0].toFixed(0)} ~ ${sorted[sorted.length - 1].toFixed(0)} 分钟（样本 ${sorted.length} 条）。`);
  }
  if (fill.truncatedDays || fill.truncatedTrains || fill.truncatedMovements) {
    bullets.push(`⚠ 存在截断标记：${fill.truncatedDays} 天 / ${fill.truncatedTrains} 条训练 / ${fill.truncatedMovements} 个动作被服务端截断（truncated=true），同步时需要识别并提示用户数据不完整。`);
  }

  lines.push('### 1.1 由填充率推导的结论');
  lines.push('');
  lines.push(bullets.map((b) => `- ${b}`).join('\n'));
  lines.push('');

  lines.push('### 1.2 分类字段分布');
  lines.push('');
  const distText = (m) => (m.size ? [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  ') : '（无数据）');
  lines.push(mdTable(['字段', '取值分布'], [
    ['movements[].type', distText(fill.movementTypeDist)],
    ['movements[].exetype', distText(fill.exetypeDist)],
    ['sets[].setType', distText(fill.setTypeDist)],
  ]));
  lines.push('');
  lines.push('> 分布里若大量是"（空）"，说明这些分类字段不可依赖，动作分类必须靠标准动作名表 + 关键词规则（T2 的活）。');
  lines.push('');
  return lines.join('\n');
}

/**
 * 渲染整份 Markdown 报告。
 * @param {object} report
 * @returns {string}
 */
function renderReport(report) {
  const opts = report.options;
  const cmd = [
    'node scripts/probe_xunji.mjs',
    `--date ${opts.date}`,
    `--days ${opts.days}`,
    opts.full ? '--full' : '--no-full',
    `--delay-ms ${opts.delayMs}`,
    opts.rateTest ? '' : '--no-rate-test',
    opts.dumpRaw ? '--dump-raw' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const lines = [];
  lines.push('# 训记 Open API 探针报告');
  lines.push('');
  lines.push('> 本报告由 `scripts/probe_xunji.mjs` 自动生成，是「能不能拿到训练数据」这件事的一手证据。');
  lines.push('> 所有输出均经过脱敏处理，**不会出现 API Key 明文**。');
  lines.push('');
  lines.push(`| 项 | 值 |`);
  lines.push(`| --- | --- |`);
  lines.push(`| 开始时间 | ${report.startedAt} |`);
  lines.push(`| 结束时间 | ${report.finishedAt} |`);
  lines.push(`| 运行环境 | Node ${report.nodeVersion} / ${report.platform} |`);
  lines.push(`| 执行命令 | \`${cmd}\` |`);
  lines.push(`| API 基址 | \`${report.baseUrl}${READ_PATH}\` |`);
  lines.push(`| Key | ${report.keyMasked} |`);
  lines.push(`| 拉取窗口 | ${opts.days > 0 ? `${report.coverage.daysRequested[report.coverage.daysRequested.length - 1] ?? opts.date} ~ ${opts.date}（${opts.days} 天）` : '未扫描'} |`);
  lines.push(`| 实际请求次数 | ${report.requestCount ?? '-'} 次（同一日期+模式的结果会被跨阶段复用，避免重复触发冷却） |`);
  lines.push(`| 探针结果 | ${report.exitReason === 'OK' ? '全部阶段通过' : `中断：${report.exitReason}`} |`);
  lines.push('');

  /* ---- 0. 结论速览 ---- */
  lines.push('## 0. 结论速览');
  lines.push('');
  lines.push(mdTable(['问题', '结论', '状态'], report.verdict.map((r) => [r[0], r[1], r[2]])));
  lines.push('');
  lines.push('> §1 填充率决定哪些分析能落地；§3 的字段清单是后续建表与写解析器的一手依据；§5 的动作名清单是肌群映射冷启动的输入。');
  lines.push('');

  /* ---- 新增：服务端自报的限频与容量约束 ---- */
  if (report.serverLimits) {
    lines.push('### 服务端自报的约束（`res.limits`，架构文档里没有的新事实）');
    lines.push('');
    lines.push(mdCode(JSON.stringify(report.serverLimits, null, 2)));
    lines.push('');
    lines.push(`> 探针已按服务端自报值取最严者执行冷却（${report.serverLimitsNote}）。`);
    lines.push('> 注：架构 §6.2.2 / §12.1 目前写的是"同一训练日 90 秒"，与服务端自报值不一致，需架构师确认后修订。');
    lines.push('');
  }

  /* ---- 1. 关键字段填充率（最重要，放最前） ---- */
  lines.push(renderFillSection(report).trimEnd());
  lines.push('');

  /* ---- 2. Q1 ---- */
  lines.push('## 2. Q1 连通性与权限');
  lines.push('');
  const conn = report.connectivity;
  if (!conn) {
    lines.push('未执行（探针在更早的阶段终止）。');
  } else {
    lines.push(
      mdTable(
        ['项', '值'],
        [
          ['请求日期', conn.datestr],
          ['请求模式', `include_full_data=${conn.mode === 'full' ? 'true' : 'false'}`],
          ['HTTP 状态', String(conn.httpStatus)],
          ['耗时', `${conn.elapsedMs} ms`],
          ['响应编码', conn.encoding || '-'],
          ['包体大小', `${conn.compressedBytes} B（压缩）→ ${conn.decodedBytes} B（解压后）`],
          ['返回训练条数', String(conn.trains)],
          ['判定码', conn.code],
          ['判定', conn.cn],
        ],
      ),
    );
    lines.push('');
    if (conn.networkError) {
      lines.push(`**网络错误**：${conn.networkError}`);
      lines.push('');
      lines.push('排查建议：①确认能访问 `https://trains.xunjiapp.cn`；②检查是否走了代理；③适当调大 `--timeout-ms`。');
      lines.push('');
    }
    if (conn.parseError) {
      lines.push(`**解析错误**：${conn.parseError}`);
      lines.push('');
      lines.push('排查建议：这通常是压缩没解压干净导致的。检查上方"响应编码"列，并把原始响应用 `--dump-raw` 留证。');
      lines.push('');
    }
    if (conn.code !== 'OK') {
      lines.push(`**处理建议**：${conn.advice}`);
      lines.push('');
      lines.push(mdCode(report.fieldShape.lightSample, '原始响应片段（已截断/脱敏）'));
      lines.push('');
      lines.push('按架构 §6.4：`apikey missing` / `apikey invalid` / `仅 VIP 可用` 属于致命错误，不重试、立即终止整轮。');
      lines.push('');
    } else {
      lines.push('✅ Key 有效且账号有权限，读取链路打通。这是 MVP T1 最大的不确定性，现已消除。');
      lines.push('');
    }
  }

  /* ---- 3. Q2 ---- */
  lines.push('## 3. Q2 真实字段结构');
  lines.push('');
  if (report.fieldShape.comparisonNote) {
    // 宁可不给结论，也不能给出"无差异"这种与事实相反的结论
    lines.push(`> ⚠ **${report.fieldShape.comparisonNote}**`);
    lines.push('');
  } else if (report.fieldShape.sampleDate) {
    lines.push(`> 对比样本日：**${report.fieldShape.sampleDate}**（${report.fieldShape.sampleReason}）。`);
    lines.push('> 样本日必须是"有训练且含动作"的那天，否则两种模式的字段并集都是空集，会得出"没有差异"的错误结论。');
    lines.push('');
  }
  if (!report.fieldShape.lightPaths.length && !report.fieldShape.fullPaths.length) {
    lines.push('未采集到字段（连通性未通过、跳过了拉取，或样本为空）。');
    lines.push('');
  } else {
    lines.push('### 3.1 响应外壳与容器');
    lines.push('');
    lines.push(mdTable(
      ['层级', '字段清单'],
      [
        ['响应外壳（顶层）', report.fieldShape.envelopeKeys.join(', ') || '（无）'],
        ['`res` 对象', report.fieldShape.resKeys.join(', ') || '（无）'],
        ['`res.trains[]` 单条训练的一级字段', report.fieldShape.trainKeys.join(', ') || '（无）'],
        ['动作容器路径', report.fieldShape.movementContainerPaths.join('<br>') || '（未识别到）'],
      ],
    ));
    lines.push('');

    lines.push('### 3.2 `include_full_data: false`（轻量）字段清单');
    lines.push('');
    lines.push(`共 ${report.fieldShape.lightPaths.length} 条路径（样本日 ${report.fieldShape.sampleDate || '-'}）。写法说明：\`res.trains[]\` 表示数组元素，\`…[]\` 表示数组。类型取自 ` + '`typeof`' + ` 与 JSON 实际值。`);
    lines.push('');
    lines.push(pathListToCode(report.fieldShape.lightPaths));
    lines.push('');

    if (opts.full) {
      lines.push('### 3.3 `include_full_data: true`（完整）字段清单');
      lines.push('');
      lines.push(`共 ${report.fieldShape.fullPaths.length} 条路径（样本日 ${report.fieldShape.sampleDate || '-'}）。`);
      lines.push('');
      lines.push(pathListToCode(report.fieldShape.fullPaths));
      lines.push('');

      lines.push('### 3.4 差异对比');
      lines.push('');
      lines.push(`**仅在 full 模式出现的字段（共 ${report.fieldShape.onlyFull.length} 条）** —— 这些就是"必须 include_full_data:true 才有"的部分：`);
      lines.push('');
      lines.push(pathListToCode(report.fieldShape.onlyFull));
      lines.push('');
      lines.push(`**仅在轻量模式出现的字段（共 ${report.fieldShape.onlyLight.length} 条）** —— 正常情况下应为空，非空说明两种模式结构本身就有差异：`);
      lines.push('');
      lines.push(pathListToCode(report.fieldShape.onlyLight));
      lines.push('');

      lines.push('### 3.5 关键字段存在性检查（只看"字段在不在"，填充率见 §1）');
      lines.push('');
      lines.push(mdTable(
        ['字段类别', '轻量模式', '完整模式', '示例路径'],
        report.fieldShape.criticalLight.map((lightRow, i) => {
          const fullRow = report.fieldShape.criticalFull[i] ?? { exists: false, samples: [] };
          return [
            lightRow.label,
            lightRow.exists ? '有' : '无',
            fullRow.exists ? '有' : '无',
            (fullRow.samples.length ? fullRow.samples : lightRow.samples).join('<br>') || '-',
          ];
        }),
      ));
      lines.push('');
      lines.push('> 关注点：RPE、备注、完成感受、未打勾组、左右侧重量、实练秒数这几类（架构 §6.2 已核实需 full 模式才有）。');
      lines.push('> 若某类在 full 模式仍为"无"，则该类数据确实不存在，依赖它的分析判定要按降级处理。');
      lines.push('');
    } else {
      lines.push('### 3.3 ~ 3.5 full 模式对比');
      lines.push('');
      lines.push('本次以 `--no-full` 运行，未做 full 模式对比。建议至少跑一次完整模式后再定表结构。');
      lines.push('');
    }
    lines.push('### 3.6 样本片段');
    lines.push('');
    lines.push(mdCode(report.fieldShape.lightSample, '轻量模式：第一条训练（已截断/脱敏）'));
    lines.push('');
    if (opts.full) {
      lines.push(mdCode(report.fieldShape.fullTrainsSample, '完整模式：第一条训练（已截断/脱敏）'));
      lines.push('');
    }
  }

  /* ---- 4. Q3 ---- */
  lines.push('## 4. Q3 限频行为');
  lines.push('');
  const rl = report.ratelimit;
  if (!rl.enabled) {
    lines.push('本次以 `--no-rate-test` 运行，未做同日限频实验。跨日期请求结果见下。');
    lines.push('');
  }
  lines.push('### 4.1 同一天连续两次请求');
  lines.push('');
  if (!rl.sameDaySecondCall) {
    lines.push('未执行（已跳过或探针提前终止）。');
  } else {
    const s = rl.sameDaySecondCall;
    lines.push(mdTable(
      ['项', '值'],
      [
        ['请求间隔', '立即（不等待冷却）'],
        ['HTTP 状态', String(s.httpStatus)],
        ['判定码', s.code],
        ['判定', s.cn],
        ['服务端消息', (s.messages || []).join(' / ') || '-'],
        ['建议等待（已解析）', s.retryMs != null ? `${s.retryMs} ms（依据：${s.retrySource || '-'}）` : '-'],
      ],
    ));
    lines.push('');
    lines.push(mdCode(rl.observedTooFrequentRaw, '`too frequent` 原始响应片段（已截断/脱敏）'));
    lines.push('');
    lines.push('> 这一条同时回答了架构 Q24（retry 时间的字段名是什么）。若上方"依据"显示"未找到明确提示"，');
    lines.push('> 说明需要按固定 90 秒兜底，无法用服务端给出的精确值。');
  }
  lines.push('');
  lines.push('### 4.2 跨日期是否互不阻塞');
  lines.push('');
  if (!rl.crossDay.length) {
    lines.push('未执行。');
  } else {
    lines.push(mdTable(
      ['日期', 'HTTP', '判定码', '判定', '训练条数', '耗时'],
      rl.crossDay.map((r) => [r.datestr, String(r.httpStatus), r.code, r.cn, String(r.trains), `${r.elapsedMs} ms`]),
    ));
    lines.push('');
    lines.push(rl.crossDayBlocked
      ? '> ⚠ **结论：不同日期也被拒**，说明可能不只是"按日期限频"，还存在全局层面的限制（架构 Q23）。首次同步必须串行，且不建议调高 `sync.concurrency`。'
      : '> ✅ **结论：不同日期互不阻塞**，符合"限频按 datestr 维度"的事实。首次 84 天同步理论上可并发，但架构给的默认值仍是串行（并发 1），配置项 `sync.concurrency` 已预留。');
    lines.push('');
    lines.push(`> 备注：${rl.note}`);
  }
  lines.push('');
  lines.push('### 4.3 对首次同步策略的影响');
  lines.push('');
  const cdSeconds = report.serverLimits?.readRateLimitSeconds ??
    report.serverLimits?.readRateLimitSecondsFull ?? null;
  lines.push(`- 12 周 ≈ 84 个日期。若跨日期互不阻塞，瓶颈只在"同一天的重复读取"，而正常同步每个日期只拉一次 → 不构成限制。`);
  lines.push(`- 失败重试时必须注意：重试同一天要重新进入限频窗口${cdSeconds ? `（服务端自报 ${cdSeconds} 秒）` : ''}，所以失败日期应单独入队、不与主流程争抢同一日期。`);
  lines.push(`- 写入后回读校验同样受此限制（架构 §6.3.5 写的是"≥90 秒"，实际应以服务端自报的 ${cdSeconds ?? 90} 秒为准）。`);
  if (cdSeconds && cdSeconds !== 90) {
    lines.push(`- ⚠ **架构 §6.2.2 / §12.1 的 \`READ_COOL_DOWN_MS = 90_000\` 与服务端自报的 ${cdSeconds} 秒不一致**，建议架构师以实测值修订。`);
  }
  lines.push('');

  /* ---- 5. Q4 ---- */
  lines.push('## 5. Q4 动作名覆盖');
  lines.push('');
  const cov = report.coverage;
  lines.push(mdTable(
    ['指标', '值'],
    [
      ['扫描天数', String(cov.daysScanned)],
      ['其中有训练的天数', String(cov.daysWithTrains)],
      ['失败天数', String(cov.daysFailed)],
      ['训练总条数', String(cov.trainsCount)],
      ['动作条目总数（含重复）', String(cov.movementsCount)],
      ['去重动作名数量', String(cov.names.length)],
    ],
  ));
  lines.push('');
  if (cov.perDay.length) {
    lines.push(mdTable(
      ['日期', '训练条数', '动作条目数', '组数', '数据来源', '状态'],
      cov.perDay.map((d) => [d.datestr, String(d.trains), String(d.movements), String(d.sets ?? 0), d.source, d.ok ? '成功' : '失败']),
    ));
    lines.push('');
  }
  if (!cov.names.length) {
    lines.push('未统计到动作名。可能原因：①这几天本来就没有训练；②锚点日期选在了没有训练的日子。');
    lines.push('');
    lines.push('处理建议：换一个有训练的日期做锚点（`--date YYYY-MM-DD`），或扩大窗口（`--days 30`）。');
    lines.push('');
  } else {
    lines.push(`### 5.1 去重动作中文名清单（共 ${cov.names.length} 个，按出现次数降序）`);
    lines.push('');
    lines.push('> 这份清单是后续肌群映射冷启动的输入：先和标准动作名表 https://github.com/Foveluy/Xunji-movements 比对，');
    lines.push('> 命中不了的即为"自定义动作/别名"，需要走人工确认流程（架构 §6.2 / T2）。');
    lines.push('');
    lines.push(mdTable(
      ['#', '动作名', '出现次数', '出现天数'],
      cov.names.map((n, i) => [String(i + 1), n.name, String(n.count), String(n.days.length)]),
    ));
    lines.push('');
    lines.push('### 5.2 纯文本清单（可直接复制去做比对）');
    lines.push('');
    lines.push('```text');
    lines.push(cov.names.map((n) => n.name).join('\n'));
    lines.push('```');
    lines.push('');
    lines.push('> 架构预计用户实际用过的动作在 30~150 个之间。若实测数量明显偏离，说明要么窗口太短，要么动作命名习惯不同，值得回头看一眼。');
    lines.push('');
  }

  /* ---- 6. 后续影响 ---- */
  lines.push('## 6. 后续影响与建议');
  lines.push('');
  lines.push('- **建表依据**：以本报告 §3.3 的完整模式字段清单为准，`raw_json` 字段兜底保存未知字段（架构 §6.2.4）。');
  lines.push('- **解析器写法**：超级组/递减组取 `sets[].items[]` 子项；有氧类取 `sets[].metrics` 的距离/热量/心率；具体路径以实测清单为准。');
  lines.push('- **分析可行性**：先看 §1 填充率。RPE 这类"字段存在但没人填"的数据，不能作为判定的唯一依据。');
  lines.push('- **同步策略**：默认串行、并发 1；若 §4.2 确认跨日期互不阻塞且实测稳定，再考虑把 `sync.concurrency` 调到 2~3。');
  lines.push('- **冷启动顺序**：先把 §5.1 的清单与 1187 个标准名比对 → 生成预测映射 → 用户确认 → 再算趋势与结论。');
  lines.push('');

  /* ---- 7. 附录 ---- */
  lines.push('## 7. 附录');
  lines.push('');
  lines.push('### 7.1 本次请求参数');
  lines.push('');
  lines.push('```json');
  lines.push(
    JSON.stringify(
      {
        method: 'POST',
        url: `${report.baseUrl}${READ_PATH}`,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ***REDACTED***', 'Accept-Encoding': 'gzip' },
        body: { schema_version: SCHEMA_VERSION, datestr: opts.date, include_full_data: opts.full },
      },
      null,
      2,
    ),
  );
  lines.push('```');
  lines.push('');
  if (report.rawDumps.length) {
    lines.push('### 7.2 原始响应落盘位置');
    lines.push('');
    lines.push(report.rawDumps.map((f) => `- \`${f}\``).join('\n'));
    lines.push('');
  }
  lines.push('### 7.3 运行提示');
  lines.push('');
  lines.push('```bash');
  lines.push('# 复制环境变量模板并填入 Key');
  lines.push('cp .env.example .env');
  lines.push('');
  lines.push('# 默认：最近 7 天 + 字段对比 + 限频实验');
  lines.push('node scripts/probe_xunji.mjs');
  lines.push('');
  lines.push('# 只要字段结构，跳过耗时约 3 分钟的限频实验');
  lines.push('node scripts/probe_xunji.mjs --no-rate-test --days 1');
  lines.push('');
  lines.push('# 扩大动作名覆盖采样');
  lines.push('node scripts/probe_xunji.mjs --days 30 --dump-raw');
  lines.push('```');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(`*报告生成时间：${report.finishedAt}。生成器：scripts/probe_xunji.mjs（由本脚本生成）。*`);
  lines.push('');
  return lines.join('\n');
}

/**
 * 字段路径清单渲染为代码块。
 * @param {string[]} paths
 * @returns {string}
 */
function pathListToCode(paths) {
  if (!paths.length) return '```text\n（无）\n```';
  return ['```text', ...paths, '```'].join('\n');
}

/* ============================================================================
 * 11. main
 * ==========================================================================*/

/**
 * 入口。
 * @param {string[]} argv
 * @returns {Promise<number>} 出口码
 */
export async function main(argv) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    log(`参数错误：${parsed.error}`);
    log('用 --help 查看用法。');
    return EXIT_UNEXPECTED;
  }
  const opts = parsed.opts;
  if (opts.help) {
    log(HELP_TEXT.trim());
    return EXIT_OK;
  }

  const cwd = process.cwd();
  const envLoaded = loadDotEnv(cwd);

  const key = (process.env.XUNJI_API_KEY || '').trim();
  const baseUrl = (process.env.XUNJI_BASE_URL || XUNJI_BASE_URL).replace(/\/+$/, '');

  log('════════ 训记 Open API 连通性探针 ════════');
  log(`工作目录：${cwd}`);
  log(`Node：${process.version} | ${process.platform}/${process.arch}`);
  log(`API：${baseUrl}${READ_PATH}`);
  log(`锚点日期：${opts.date} | 窗口天数：${opts.days} | full 对比：${opts.full ? '开' : '关'} | 限频实验：${opts.rateTest ? '开' : '关'}`);
  log(`环境变量文件：${envLoaded.length ? envLoaded.join(', ') : '(未找到 .env，将只依赖系统环境变量)'}`);

  if (!key || key.startsWith('你的') || key.includes('在这里') || key === 'changeme') {
    // 没有 Key 时给清晰指引，绝不崩溃、也绝不猜测能不能连
    log('');
    log('✗ 未检测到可用的 XUNJI_API_KEY。探针需要真实的 Key 才能回答四个问题，不能靠猜。');
    log('');
    log('请按以下步骤操作：');
    log('  1) 复制环境变量模板：cp .env.example .env      （Windows PowerShell: Copy-Item .env.example .env）');
    log('  2) 打开 .env，把占位符替换成你在训记 App 里拿到的 API Key');
    log('  3) 重新运行：node scripts/probe_xunji.mjs');
    log('');
    log('也可以临时注入而不写文件：');
    log("  bash:        XUNJI_API_KEY='你的Key' node scripts/probe_xunji.mjs");
    log("  PowerShell:  $env:XUNJI_API_KEY='你的Key'; node scripts/probe_xunji.mjs");
    log('');
    log('提示：本脚本不会修改 docs/probe-report.md，报告仍保留占位版本。');
    return EXIT_NO_KEY;
  }

  registerSecret(key);
  log(`已读取 Key：${maskKey(key)}（日志与报告中一律掩码展示）`);

  /** @type {{baseUrl: string, key: string, timeoutMs: number}} */
  const cfg = { baseUrl, key, timeoutMs: opts.timeoutMs };

  let report;
  try {
    report = await runProbe(cfg, opts);
  } catch (e) {
    log('');
    log(`探针运行异常终止：${e?.stack || e?.message || String(e)}`);
    return EXIT_UNEXPECTED;
  }

  // 写出报告（无论成功失败都写：失败本身也是结论）
  const outPath = path.resolve(cwd, opts.out);
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, renderReport(report), 'utf8');
    log(`\n📄 报告已写入：${outPath}`);
  } catch (e) {
    log(`\n✗ 报告写入失败：${e.message}`);
    return EXIT_UNEXPECTED;
  }

  if (report.exitReason === 'OK') return EXIT_OK;
  if (report.exitReason.startsWith('FATAL')) return EXIT_FATAL_API;
  return EXIT_UNEXPECTED;
}

// 直接运行时才执行 main；被 import 时保持无副作用（便于单测纯函数）
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(safe(`未捕获异常：${e?.stack || e?.message || String(e)}`));
      process.exit(EXIT_UNEXPECTED);
    });
}

export {
  classifyResponse,
  collectShape,
  decodeBody,
  extractMovementNamesProbe,
  extractMovements,
  findErrorMessages,
  extractRetryMs,
  parseArgs,
  renderReport,
  shiftDays,
  buildDateWindow,
  isValidDateStr,
  newFillStats,
  accumulateFill,
  countSets,
  adoptServerLimits,
};

/**
 * 便于测试的聚合入口：从一个 res 对象统计动作名。
 * @param {unknown} resNode
 * @returns {string[]}
 */
function extractMovementNamesProbe(resNode) {
  const trains = Array.isArray(resNode?.trains) ? resNode.trains : [];
  const nameStat = new Map();
  const containers = new Set();
  accumulateDay('1970-01-01', trains, nameStat, containers);
  return [...nameStat.keys()].sort();
}
