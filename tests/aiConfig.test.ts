/**
 * AI 配置读写测试（V4）。
 *
 * 这个文件保护的是**安全红线**，不是功能好不好用：
 *  1. 🔴 Key 只落 `.env`，且**永不回传**（响应体里连子串都不许出现）；
 *  2. `.env` 里别人的键（训记 Key）与注释必须原样保留 —— 写坏一次就丢用户的真实 Key；
 *  3. 前端不回传明文 → 服务端不能因为「没收到 key」就把已存的 Key 清掉。
 *
 * 全程零真实网络、零真实 .env（一律写进临时目录）。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { AI_MAX_TOKENS_DEFAULT, loadConfig } from '../server/config/index.js';
import {
  AiConfigError,
  applyAiConfig,
  createAiRuntime,
  isLocalEndpoint,
  maskKey,
  parseEnvText,
  updateEnvFile,
  validateAiConfigPatch,
} from '../server/ai/aiConfig.js';

const FAKE_KEY = 'sk-SECRET-DO-NOT-LEAK-1234abcd';

const tmpDirs: string[] = [];
function tmpEnv(initial: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'atp-aicfg-'));
  tmpDirs.push(dir);
  const p = path.join(dir, '.env');
  writeFileSync(p, initial, 'utf8');
  return p;
}
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const cfgWith = (env: Record<string, string | undefined>) => loadConfig(env, process.cwd());

describe('V4：Key 掩码与端点判定', () => {
  it('掩码只留后四位；无 Key → null', () => {
    assert.equal(maskKey(FAKE_KEY), '****abcd');
    assert.equal(maskKey('abc'), '****');
    assert.equal(maskKey(null), null);
    assert.equal(maskKey(''), null);
  });

  it('本地端点免鉴权（ollama / 本机 mock），远端端点不免', () => {
    assert.equal(isLocalEndpoint('http://127.0.0.1:11434/v1'), true);
    assert.equal(isLocalEndpoint('http://localhost:1234'), true);
    assert.equal(isLocalEndpoint('http://[::1]:8080/v1'), true);
    assert.equal(isLocalEndpoint('https://api.deepseek.com'), false);
    assert.equal(isLocalEndpoint('https://127.0.0.1.evil.com'), false, '域名里含 127.0.0.1 不算本地');
  });
});

describe('V4：loadConfig 的 AI 默认值', () => {
  it('什么都不配 → http 模式 + DeepSeek 默认端点/模型，但未就绪（缺 Key）', () => {
    const rt = createAiRuntime(cfgWith({}));
    const v = rt.view();
    assert.equal(v.mode, 'http');
    assert.equal(v.base_url, 'https://api.deepseek.com');
    assert.equal(v.model, 'deepseek-flash');
    // 引用常量而不是字面量：这个值踩过坑（推理模型会把 token 花在 reasoning 上，
    // 8192 不够写完整份周计划 JSON），以后再调时断言要跟着走。
    assert.equal(v.max_tokens, AI_MAX_TOKENS_DEFAULT);
    assert.ok(AI_MAX_TOKENS_DEFAULT >= 16384, '必须给推理内容留出足够预算');
    assert.equal(v.temperature, 0.3);
    assert.equal(v.has_key, false);
    assert.equal(v.ready, false);
    assert.ok(v.blocked_reason?.includes('LLM_API_KEY'));
    assert.equal(rt.tag(), 'unconfigured');
  });

  it('LLM_MODE=off 时即使有 Key 也不可用（明确关闭）', () => {
    const rt = createAiRuntime(cfgWith({ LLM_MODE: 'off', LLM_API_KEY: FAKE_KEY }));
    assert.equal(rt.view().ready, false);
    assert.ok(rt.view().blocked_reason?.includes('关闭'));
    assert.equal(rt.tag(), 'unconfigured');
  });

  it('配齐后 tag 是 http:<model>（进 plan.ai_model_tag 审计字段）', () => {
    const rt = createAiRuntime(cfgWith({ LLM_API_KEY: FAKE_KEY, LLM_MODEL: 'deepseek-v4-pro' }));
    assert.equal(rt.view().ready, true);
    assert.equal(rt.tag(), 'http:deepseek-v4-pro');
  });

  it('temperature=0 是合法值（不能被 falsy 判断吃掉）', () => {
    const rt = createAiRuntime(cfgWith({ LLM_API_KEY: FAKE_KEY, LLM_TEMPERATURE: '0' }));
    assert.equal(rt.view().temperature, 0);
  });

  it('本地端点无 Key 也算可用（本机 mock / ollama）', () => {
    const rt = createAiRuntime(cfgWith({ LLM_BASE_URL: 'http://127.0.0.1:1234/v1' }));
    assert.equal(rt.view().ready, true);
    assert.equal(rt.view().local_endpoint, true);
  });
});

describe('V4：.env 读写', () => {
  it('只改 LLM_* 行，别人的 Key 与注释原样保留', () => {
    const envPath = tmpEnv(
      ['# 我的训练记录 Key', 'XUNJI_API_KEY=my-xunji-key', '', '# AI', 'LLM_MODEL=old-model', ''].join('\n'),
    );
    updateEnvFile(envPath, { LLM_MODEL: 'deepseek-flash', LLM_BASE_URL: 'https://api.deepseek.com' });
    const text = readFileSync(envPath, 'utf8');
    assert.ok(text.includes('XUNJI_API_KEY=my-xunji-key'), '训记 Key 必须原样保留');
    assert.ok(text.includes('# 我的训练记录 Key'), '注释必须保留');
    assert.ok(text.includes('LLM_MODEL=deepseek-flash'));
    assert.ok(text.includes('LLM_BASE_URL=https://api.deepseek.com'));
    assert.ok(!text.includes('old-model'));
    assert.ok(!existsSync(`${envPath}.tmp`), '不得留下临时文件');
  });

  it('键不存在时追加；值为 null 时删除该行（清除 Key）', () => {
    const envPath = tmpEnv('XUNJI_API_KEY=k\nLLM_API_KEY=to-be-removed\n');
    updateEnvFile(envPath, { LLM_API_KEY: null, LLM_MODEL: 'deepseek-flash' });
    const text = readFileSync(envPath, 'utf8');
    assert.ok(!text.includes('to-be-removed'));
    assert.ok(!text.includes('LLM_API_KEY'), '清除 Key 应当真的把行删掉');
    assert.ok(text.includes('LLM_MODEL=deepseek-flash'));
    assert.ok(text.includes('XUNJI_API_KEY=k'));
  });

  it('重复保存不累积空行、不产生重复键', () => {
    const envPath = tmpEnv('XUNJI_API_KEY=k\n');
    for (let i = 0; i < 3; i++) updateEnvFile(envPath, { LLM_MODEL: 'm1' });
    const text = readFileSync(envPath, 'utf8');
    assert.equal(text.split('\n').filter((l) => l.startsWith('LLM_MODEL=')).length, 1);
    assert.ok(!/\n{3,}/.test(text), `不该出现连续空行：${JSON.stringify(text)}`);
  });

  it('解析：支持引号、export 前缀、注释与空行', () => {
    const { values } = parseEnvText('# c\nA=1\nexport B="x y"\nC=\'z\'\n\nD=\n');
    assert.equal(values.get('A'), '1');
    assert.equal(values.get('B'), 'x y');
    assert.equal(values.get('C'), 'z');
    assert.equal(values.get('D'), '');
    assert.equal(values.has('#'), false);
  });
});

describe('V4：入参校验', () => {
  it('base_url 必须是 http(s)；空串回落到 DeepSeek 默认', () => {
    assert.throws(() => validateAiConfigPatch({ base_url: 'api.deepseek.com' }), /http/);
    assert.throws(() => validateAiConfigPatch({ base_url: 'ftp://x' }), /http/);
    assert.equal(validateAiConfigPatch({ base_url: '' }).baseUrl, 'https://api.deepseek.com');
  });

  it('model 不能为空 / 含空格；max_tokens 与 temperature 有范围', () => {
    assert.throws(() => validateAiConfigPatch({ model: '  ' }), /不能为空/);
    assert.throws(() => validateAiConfigPatch({ model: 'a b' }), /空格/);
    assert.throws(() => validateAiConfigPatch({ max_tokens: 10 }), /max_tokens/);
    assert.throws(() => validateAiConfigPatch({ max_tokens: 999999 }), /max_tokens/);
    assert.throws(() => validateAiConfigPatch({ temperature: 5 }), /temperature/);
    assert.equal(validateAiConfigPatch({ temperature: 0 }).temperature, 0);
  });

  it('mode 只接受 http / off', () => {
    assert.equal(validateAiConfigPatch({ mode: 'OFF' }).mode, 'off');
    assert.throws(() => validateAiConfigPatch({ mode: 'workbuddy' }), /http 或 off/);
  });

  it('Key 里的空格/换行被拒绝（粘贴常见错误）', () => {
    assert.throws(() => validateAiConfigPatch({ api_key: 'sk-abc def' }), /空格/);
  });

  it('不传 api_key → 不产生任何 Key 变更意图（不会误清空）', () => {
    const patch = validateAiConfigPatch({ mode: 'http', model: 'deepseek-flash' });
    assert.equal(patch.apiKey, undefined);
    assert.equal(patch.clearKey, undefined);
  });

  it('校验失败抛 AiConfigError(400)', () => {
    try {
      validateAiConfigPatch({ model: '' });
      assert.fail('应当抛错');
    } catch (e) {
      assert.ok(e instanceof AiConfigError);
      assert.equal((e as AiConfigError).status, 400);
    }
  });
});

describe('V4：落盘 + 热更新', () => {
  it('保存 → 写 .env + 内存立即生效；🔴 响应里不含 Key 明文', () => {
    const envPath = tmpEnv('XUNJI_API_KEY=k\n');
    const rt = createAiRuntime(cfgWith({}));
    const patch = validateAiConfigPatch({
      mode: 'http',
      base_url: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      api_key: FAKE_KEY,
    });
    const view = applyAiConfig(rt, { envPath, patch });

    assert.equal(view.has_key, true);
    assert.equal(view.key_hint, '****abcd');
    assert.equal(view.ready, true);
    assert.equal(rt.tag(), 'http:deepseek-flash');
    // 🔴 安全断言：掩码视图整体序列化后不得出现 Key 明文
    assert.ok(!JSON.stringify(view).includes(FAKE_KEY), 'API 响应不得包含 Key 明文');
    assert.ok(!JSON.stringify(view).includes('SECRET'), 'API 响应不得包含 Key 片段');
    // 但 .env 里必须有（唯一落盘位置）
    assert.ok(readFileSync(envPath, 'utf8').includes(FAKE_KEY));
    // 热更新：gateway 读的就是这个对象
    assert.equal(rt.http.apiKey, FAKE_KEY);
    assert.equal(rt.http.model, 'deepseek-flash');
  });

  it('不带 Key 的保存只改别的字段，已存 Key 原样留在 .env', () => {
    const envPath = tmpEnv(`XUNJI_API_KEY=k\nLLM_API_KEY=${FAKE_KEY}\n`);
    const rt = createAiRuntime(cfgWith({ LLM_API_KEY: FAKE_KEY }));
    applyAiConfig(rt, { envPath, patch: validateAiConfigPatch({ model: 'deepseek-v4-pro' }) });
    assert.equal(rt.http.apiKey, FAKE_KEY, '未提交 Key 时内存里也不该被清掉');
    const text = readFileSync(envPath, 'utf8');
    assert.ok(text.includes(`LLM_API_KEY=${FAKE_KEY}`), '.env 里的 Key 不该被清掉');
    assert.ok(text.includes('LLM_MODEL=deepseek-v4-pro'));
    assert.ok(text.includes('XUNJI_API_KEY=k'));
  });

  it('clear_key → 内存与 .env 同时清空', () => {
    const envPath = tmpEnv(`LLM_API_KEY=${FAKE_KEY}\n`);
    const rt = createAiRuntime(cfgWith({ LLM_API_KEY: FAKE_KEY }));
    const view = applyAiConfig(rt, { envPath, patch: validateAiConfigPatch({ clear_key: true }) });
    assert.equal(view.has_key, false);
    assert.equal(view.key_hint, null);
    assert.equal(rt.http.apiKey, null);
    assert.ok(!readFileSync(envPath, 'utf8').includes('LLM_API_KEY'));
  });

  it('mode=off 热更新后不可用；再切回 http 立刻恢复', () => {
    const envPath = tmpEnv('XUNJI_API_KEY=k\n');
    const rt = createAiRuntime(cfgWith({ LLM_API_KEY: FAKE_KEY }));
    applyAiConfig(rt, { envPath, patch: validateAiConfigPatch({ mode: 'off' }) });
    assert.equal(rt.view().ready, false);
    assert.equal(rt.tag(), 'unconfigured');
    applyAiConfig(rt, { envPath, patch: validateAiConfigPatch({ mode: 'http' }) });
    assert.equal(rt.view().ready, true);
  });

  it('写盘后进程环境变量同步（重启读 .env 与运行中一致）', () => {
    const envPath = tmpEnv('');
    const rt = createAiRuntime(cfgWith({}));
    applyAiConfig(rt, { envPath, patch: validateAiConfigPatch({ model: 'deepseek-v4-pro', max_tokens: 4096 }) });
    assert.equal(process.env.LLM_MODEL, 'deepseek-v4-pro');
    assert.equal(process.env.LLM_MAX_TOKENS, '4096');
    // 还原，避免影响其它用例
    delete process.env.LLM_MODEL;
    delete process.env.LLM_MAX_TOKENS;
  });
});
