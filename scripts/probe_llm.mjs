#!/usr/bin/env node
/**
 * scripts/probe_llm.mjs — LLM（DeepSeek / 任意 OpenAI 兼容端点）连通性探针
 *
 * ============================ 这个脚本要解决什么 ============================
 * 填完 .env 里的 LLM_API_KEY 之后，**不用启动整个服务**就能确认三件事：
 *
 *   Q1 配置读取 —— .env 里的 LLM_* 有没有被正确读到（输出只打印掩码）
 *   Q2 Key 有效性 —— 端点认不认这个 Key（401/402 会立刻暴露，不用等排计划失败）
 *   Q3 JSON 模式 —— 结构化输出能否正常返回
 *                   （DeepSeek JSON 模式**官方声明有概率返回空 content**，
 *                    探针会明确指出这属于「偶发可重试」，不是配置错误）
 *
 * ============================ 用法 ============================
 *   1) 确认 .env 里有 LLM_API_KEY=sk-...
 *   2) node scripts/probe_llm.mjs
 *      node scripts/probe_llm.mjs --model deepseek-v4-pro   # 临时换模型试（不改 .env）
 *      node scripts/probe_llm.mjs --base-url https://api.deepseek.com/v1
 *      node scripts/probe_llm.mjs --models                  # 列出端点支持的模型名
 *      node scripts/probe_llm.mjs --raw                     # 打印响应体结构（诊断空 content 时用）
 *      node scripts/probe_llm.mjs --dry                     # 只看配置，不发请求
 *
 * 依赖：Node 22+（原生 fetch + process.loadEnvFile），零第三方依赖。
 *
 * ============================ 安全红线 ============================
 * - 只读 .env，**绝不打印 Key 明文**（一律 ****后四位）；
 * - 不访问训记、不写任何文件、不改任何配置。
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
function optValue(name) {
  const withEq = args.find((a) => a.startsWith(`${name}=`));
  if (withEq) return withEq.slice(name.length + 1);
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  return null;
}

const CWD = process.cwd();
const ENV_PATH = path.join(CWD, '.env');

if (!existsSync(ENV_PATH)) {
  console.error(`✗ 找不到 ${ENV_PATH}`);
  console.error('  先复制模板：cp .env.example .env   然后填入 LLM_API_KEY');
  process.exit(1);
}

// 以 .env 为准加载（注意：与 server/config/env.ts 的「不覆盖已存在变量」不同，
// 探针刻意让 .env 优先，避免 shell 里残留的旧值把结论带偏）
process.loadEnvFile(ENV_PATH);

function mask(key) {
  if (!key) return '(未配置)';
  return key.length <= 4 ? '****' : `****${key.slice(-4)}`;
}

const mode = (process.env.LLM_MODE ?? 'http').trim().toLowerCase();
const baseUrl = (optValue('--base-url') ?? process.env.LLM_BASE_URL ?? 'https://api.deepseek.com')
  .trim()
  .replace(/\/+$/, '');
const model = (optValue('--model') ?? process.env.LLM_MODEL ?? 'deepseek-flash').trim();
const apiKey = (process.env.LLM_API_KEY ?? '').trim();
const maxTokens = Number(process.env.LLM_MAX_TOKENS ?? 8192);
const temperature = Number(process.env.LLM_TEMPERATURE ?? 0.3);
const timeoutMs = Number(process.env.ATP_AI_TIMEOUT_MS ?? 120000);

const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(baseUrl);

console.log('[probe] 配置（来源 .env）');
console.log(`  LLM_MODE       ${mode}`);
console.log(`  LLM_BASE_URL   ${baseUrl}`);
console.log(`  LLM_MODEL      ${model}`);
console.log(`  LLM_API_KEY    ${mask(apiKey)}${apiKey ? '' : isLocal ? '（本地端点可不需要）' : '  ← 需要填这个'}`);
console.log(`  max_tokens     ${maxTokens}    temperature ${temperature}    超时 ${timeoutMs}ms`);
console.log('');

if (mode === 'off') {
  console.error('✗ LLM_MODE=off：AI 被显式关闭，排计划会直接走规则模板。');
  console.error('  要启用：把 .env 里的 LLM_MODE 改成 http（或删掉这一行，默认就是 http）');
  process.exit(1);
}
if (!apiKey && !isLocal) {
  console.error('✗ 缺少 LLM_API_KEY（非本地端点必须配置）。');
  console.error(`  打开 ${ENV_PATH}，把这行填成：LLM_API_KEY=sk-你的key`);
  console.error('  （也可以在「设置 → AI 排计划」里填，保存时会自动写回 .env）');
  process.exit(1);
}
if (hasFlag('--dry')) {
  console.log('[probe] --dry：仅检查配置，未发起请求。PASS');
  process.exit(0);
}

// --models：列出端点支持的模型名。模型名写错时最有用的一个命令。
if (hasFlag('--models')) {
  console.log(`[probe] GET ${baseUrl}/models`);
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    const text = await res.text();
    console.log(`  HTTP ${res.status}`);
    if (res.status === 200) {
      const parsed = JSON.parse(text);
      const ids = (parsed?.data ?? []).map((m) => m?.id).filter(Boolean);
      if (ids.length > 0) {
        console.log(`  可用模型：${ids.join(' / ')}`);
        console.log(`  当前 .env 里写的是：${model}${ids.includes(model) ? ' ✅ 在列表里' : ' ⚠️ 不在列表里！'}`);
      } else {
        console.log(`  响应结构：${text.slice(0, 300)}`);
      }
    } else {
      console.error(`  原始响应：${text.slice(0, 300)}`);
    }
  } catch (e) {
    console.error(`✗ 请求失败：${e.message}`);
  }
  process.exit(0);
}

const endpoint = `${baseUrl}/chat/completions`;
const body = {
  model,
  messages: [
    { role: 'system', content: '你是配置自检助手，只输出 JSON。' },
    { role: 'user', content: '输出这个 JSON：{"ok":true}' },
  ],
  response_format: { type: 'json_object' },
  // 探针刻意给足余量：有些模型（尤其带推理的）会先把 token 花在 reasoning_content 上，
  // 给 32 就会被吃光、content 返回空 —— 那看起来像「端点坏了」，其实只是预算不够。
  max_tokens: Math.min(maxTokens, 512),
  temperature: 0,
};

async function once(attempt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 60_000));
  const t0 = Date.now();
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const ms = Date.now() - t0;
    const text = await res.text();
    return { status: res.status, ms, text };
  } finally {
    clearTimeout(timer);
  }
}

console.log(`[probe] POST ${endpoint}  (model=${model})`);
let result;
try {
  result = await once(1);
} catch (e) {
  const aborted = e instanceof Error && e.name === 'AbortError';
  console.error(`✗ 请求失败：${aborted ? `超时（>${Math.min(timeoutMs, 60_000)}ms）` : e.message}`);
  if (!isLocal) console.error('  检查网络 / 代理；若在公司网络下，可能需要放行 api.deepseek.com');
  process.exit(1);
}

const { status, ms, text } = result;
console.log(`  HTTP ${status}   ${ms}ms`);

function parseContent(raw) {
  try {
    const j = JSON.parse(raw);
    const choice = j?.choices?.[0];
    const rc = choice?.message?.reasoning_content;
    return {
      content: choice?.message?.content ?? null,
      finishReason: choice?.finish_reason ?? null,
      hasReasoning: typeof rc === 'string' && rc.length > 0,
      usage: j?.usage ?? null,
      err: null,
    };
  } catch {
    return { content: null, finishReason: null, hasReasoning: false, usage: null, err: raw.slice(0, 200) };
  }
}

/** 空 content 的三种成因差别很大，分开说清楚，别让人只看到一句「偶发」。 */
function explainEmpty(d) {
  if (d.finishReason === 'length') {
    console.log('     → finish_reason=length：token 预算被用光了。');
    if (d.hasReasoning) console.log('       而且响应里带了 reasoning_content —— 这个模型会先花 token 思考，' + '把 max_tokens 调大（.env 的 LLM_MAX_TOKENS）即可。');
    else console.log('       把 .env 的 LLM_MAX_TOKENS 调大（当前服务默认 8192）。');
    return;
  }
  if (d.hasReasoning) {
    console.log('     → 响应里有 reasoning_content 但 content 为空：模型把预算全用在思考上了，调大 max_tokens。');
    return;
  }
  console.log('     → 响应结构正常但 content 为空，属于 DeepSeek JSON 模式的已知偶发，重试即可。');
}

if (status === 200) {
  if (hasFlag('--raw')) {
    console.log(`  响应体（截断 600）：${text.slice(0, 600)}`);
  }
  const d1 = parseContent(text);
  const { content, err } = d1;
  if (err !== null) {
    console.error(`✗ 响应不是 JSON：${err}`);
    process.exit(1);
  }
  if (typeof content !== 'string' || content.trim() === '') {
    console.log('  ⚠ 返回了空 content');
    if (d1.finishReason !== null || d1.usage !== null) {
      console.log(`     finish_reason=${d1.finishReason} · reasoning_content=${d1.hasReasoning ? '有' : '无'} · usage=${JSON.stringify(d1.usage)}`);
    }
    explainEmpty(d1);
    console.log('[probe] 重试一次……');
    const r2 = await once(2);
    const d2 = parseContent(r2.text);
    const c2 = d2.content;
    if (r2.status === 200 && typeof c2 === 'string' && c2.trim() !== '') {
      console.log(`  ✓ 第二次成功：${c2.trim().slice(0, 60)}`);
      console.log('\n[probe] PASS —— Key 有效、JSON 模式工作正常（偶发空 content 已被系统重试机制覆盖）。');
      process.exit(0);
    }
    console.error('✗ 连续两次空 content。Key 本身可用，但端点当前不稳定，稍后再试。');
    process.exit(1);
  }
  console.log(`  content: ${content.trim().slice(0, 60)}`);
  console.log('\n[probe] PASS —— Key 有效、端点和模型名正确、JSON 模式工作正常。');
  console.log(`       服务里排计划会用 llmApiKey=${mask(apiKey)} / model=${model}。`);
  process.exit(0);
}

if (status === 401) {
  console.error('✗ 401 未授权：Key 无效、拼错了，或已被撤销。');
  console.error(`  当前读到的是 ${mask(apiKey)}（长度 ${apiKey.length}）。到 DeepSeek 控制台重新生成一个。`);
} else if (status === 402) {
  console.error('✗ 402 余额不足：Key 是对的，但账户没额度了。去控制台充值。');
} else if (status === 404) {
  console.error('✗ 404 路径不对：base_url 应该是 https://api.deepseek.com（或 .../v1），');
  console.error('  不要再往后加路径 —— 系统会自己拼 /chat/completions。');
} else if (status === 429) {
  console.error('✗ 429 限频：稍等一会儿再跑。');
} else if (status >= 500) {
  console.error(`✗ ${status} 服务端错误：DeepSeek 侧的问题，稍后再试。`);
} else if (status === 400) {
  console.error('✗ 400 请求被拒：多半是模型名不对。');
  console.error(`  当前 model=${model}；DeepSeek 可选 deepseek-flash / deepseek-v4-pro。`);
}
console.error(`  原始响应（截断）：${text.slice(0, 300)}`);
process.exit(1);
