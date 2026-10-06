/**
 * 训记接入配置测试（2026-10-01：Key 从「只能改 .env」搬到网页上）。
 *
 * 这个文件保护的和 aiConfig.test.ts 是同一件事 —— **安全红线**，不是功能好不好用：
 *  1. 🔴 Key 只落 `.env`，且**永不回传**（掩码视图整体序列化后连子串都不许出现）；
 *  2. `.env` 里别人的键（AI 的 LLM_*）与注释必须原样保留 —— 写坏一次就丢用户的真实配置；
 *  3. 前端不回传明文 → 服务端不能因为「没收到 api_key」就把已存的 Key 清掉。
 *
 * 全程零真实网络、零真实 .env（一律写进临时目录）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  XUNJI_KEY_ENV,
  XunjiConfigError,
  applyXunjiKey,
  envPathOf,
  maskKey,
  validateXunjiKeyPatch,
  xunjiKeyView,
} from '../server/xunji/xunjiConfig.js';

const FAKE_KEY = 'xj-SECRET-DO-NOT-LEAK-5678wxyz';

const tmpDirs: string[] = [];
function tmpEnv(initial: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'atp-xjcfg-'));
  tmpDirs.push(dir);
  const p = path.join(dir, '.env');
  writeFileSync(p, initial, 'utf8');
  return p;
}
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  delete process.env[XUNJI_KEY_ENV];
});

/** 记录 onApplied 收到的值，模拟 index.ts 那边的热更新回调。 */
function spy(): { calls: Array<string | null>; onApplied: (k: string | null) => void } {
  const calls: Array<string | null> = [];
  return { calls, onApplied: (k) => calls.push(k) };
}

describe('训记接入：Key 掩码', () => {
  it('只留后四位；无 Key → null；过短则整体打码', () => {
    assert.equal(maskKey(FAKE_KEY), '****wxyz');
    assert.equal(maskKey('abc'), '****');
    assert.equal(maskKey('abcd'), '****', '刚好 4 位也不该回显（全等于原文）');
    assert.equal(maskKey(null), null);
    assert.equal(maskKey(''), null);
  });

  it('xunjiKeyView：只有 has_key 与掩码，永远不含明文', () => {
    const v = xunjiKeyView(FAKE_KEY);
    assert.deepEqual(v, { has_key: true, key_hint: '****wxyz' });
    assert.ok(!JSON.stringify(v).includes(FAKE_KEY));
    assert.ok(!JSON.stringify(v).includes('SECRET'));
    assert.deepEqual(xunjiKeyView(null), { has_key: false, key_hint: null });
    assert.deepEqual(xunjiKeyView(''), { has_key: false, key_hint: null });
  });
});

describe('训记接入：入参校验', () => {
  it('不传 api_key / clear_key → 不产生任何变更意图（不会误清空）', () => {
    const patch = validateXunjiKeyPatch({});
    assert.equal(patch.apiKey, undefined);
    assert.equal(patch.clearKey, undefined);
  });

  it('空白 api_key 视为「没填」，不产生变更意图', () => {
    assert.equal(validateXunjiKeyPatch({ api_key: '   ' }).apiKey, undefined);
    assert.equal(validateXunjiKeyPatch({ api_key: '' }).apiKey, undefined);
    assert.equal(validateXunjiKeyPatch({ api_key: 123 as unknown as string }).apiKey, undefined);
  });

  it('Key 里的空格/换行被拒绝（粘贴常见错误）；两端空白会被裁掉', () => {
    assert.throws(() => validateXunjiKeyPatch({ api_key: 'xj-abc def' }), /空格/);
    assert.throws(() => validateXunjiKeyPatch({ api_key: 'xj-a\nb' }), /空格/);
    assert.equal(validateXunjiKeyPatch({ api_key: '  xj-abc  ' }).apiKey, 'xj-abc');
  });

  it('超长 Key（>512）被拒绝', () => {
    assert.throws(() => validateXunjiKeyPatch({ api_key: 'x'.repeat(513) }), /过长/);
  });

  it('clear_key=true 优先于 api_key（显式清空不会被并发字段干扰）', () => {
    const patch = validateXunjiKeyPatch({ clear_key: true, api_key: FAKE_KEY });
    assert.equal(patch.clearKey, true);
    assert.equal(patch.apiKey, undefined);
  });

  it('非对象请求体 → XunjiConfigError(400)', () => {
    for (const bad of [null, 'x', 42, [1, 2]]) {
      try {
        validateXunjiKeyPatch(bad);
        assert.fail(`应当抛错：${JSON.stringify(bad)}`);
      } catch (e) {
        assert.ok(e instanceof XunjiConfigError);
        assert.equal((e as XunjiConfigError).status, 400);
      }
    }
  });
});

describe('训记接入：落盘 + 热更新', () => {
  it('保存 → 写 .env + 回调拿到新 Key；🔴 返回值不含明文', () => {
    const envPath = tmpEnv('XUNJI_API_KEY=old\nLLM_API_KEY=llm-keep-me\n');
    const { calls, onApplied } = spy();
    const view = applyXunjiKey({
      envPath,
      patch: validateXunjiKeyPatch({ api_key: FAKE_KEY }),
      current: 'old',
      onApplied,
    });

    assert.equal(view.has_key, true);
    assert.equal(view.key_hint, '****wxyz');
    assert.ok(!JSON.stringify(view).includes(FAKE_KEY), '返回值不得包含 Key 明文');
    assert.ok(!JSON.stringify(view).includes('SECRET'));
    // 唯一落盘位置在 .env
    const text = readFileSync(envPath, 'utf8');
    assert.ok(text.includes(`XUNJI_API_KEY=${FAKE_KEY}`));
    assert.ok(!text.includes('XUNJI_API_KEY=old'));
    assert.ok(text.includes('LLM_API_KEY=llm-keep-me'), 'AI 的 Key 必须原样保留');
    // 进程环境变量同步（重启前后一致）
    assert.equal(process.env[XUNJI_KEY_ENV], FAKE_KEY);
    // 热更新回调收到新 Key（index.ts 用它重建同步引擎与写回客户端）
    assert.deepEqual(calls, [FAKE_KEY]);
  });

  it('不传 api_key 的保存 → 已存 Key 原样留在 .env，不被清掉，且**不惊动热更新回调**', () => {
    const envPath = tmpEnv(`XUNJI_API_KEY=${FAKE_KEY}\n`);
    process.env[XUNJI_KEY_ENV] = FAKE_KEY;
    const { calls, onApplied } = spy();
    const view = applyXunjiKey({ envPath, patch: validateXunjiKeyPatch({}), current: FAKE_KEY, onApplied });

    assert.equal(view.has_key, true);
    assert.equal(view.key_hint, '****wxyz');
    assert.ok(readFileSync(envPath, 'utf8').includes(FAKE_KEY), '.env 里的 Key 不该被清掉');
    // 🔴 回调一旦被调用，index.ts 会重建引擎并可能触发「首次全量」——
    //    空保存（PUT {}）绝不能引起这种副作用。
    assert.deepEqual(calls, [], '无变更时不该调用 onApplied');
  });

  it('追加此前不存在的键 → 不留额外空行（外观瑕疵，2026-10-01 验证发现）', () => {
    const envPath = tmpEnv('# 注释\nLLM_API_KEY=keep\n');
    applyXunjiKey({
      envPath,
      patch: validateXunjiKeyPatch({ api_key: FAKE_KEY }),
      current: null,
      onApplied: () => {},
    });
    const text = readFileSync(envPath, 'utf8');
    assert.equal(
      text,
      `# 注释\nLLM_API_KEY=keep\nXUNJI_API_KEY=${FAKE_KEY}\n`,
      `新键应紧接最后一行，不该被空行隔开：${JSON.stringify(text)}`,
    );
  });

  it('clear_key → .env 行被删掉、进程变量删除、回调收到 null', () => {
    const envPath = tmpEnv(`XUNJI_API_KEY=${FAKE_KEY}\nLLM_API_KEY=keep\n`);
    process.env[XUNJI_KEY_ENV] = FAKE_KEY;
    const { calls, onApplied } = spy();
    const view = applyXunjiKey({
      envPath,
      patch: validateXunjiKeyPatch({ clear_key: true }),
      current: FAKE_KEY,
      onApplied,
    });

    assert.equal(view.has_key, false);
    assert.equal(view.key_hint, null);
    assert.ok(!readFileSync(envPath, 'utf8').includes('XUNJI_API_KEY'));
    assert.equal(process.env[XUNJI_KEY_ENV], undefined);
    assert.ok(readFileSync(envPath, 'utf8').includes('LLM_API_KEY=keep'));
    assert.deepEqual(calls, [null]);
  });

  it('重复保存不累积空行、不产生重复键，且注释保留', () => {
    const envPath = tmpEnv('# 我的训记 Key\nXUNJI_API_KEY=old\n\n# AI\nLLM_MODEL=m\n');
    for (let i = 0; i < 3; i++) {
      applyXunjiKey({
        envPath,
        patch: validateXunjiKeyPatch({ api_key: FAKE_KEY }),
        current: FAKE_KEY,
        onApplied: () => {},
      });
    }
    const text = readFileSync(envPath, 'utf8');
    assert.equal(text.split('\n').filter((l) => l.startsWith('XUNJI_API_KEY=')).length, 1);
    assert.ok(!/\n{3,}/.test(text), `不该出现连续空行：${JSON.stringify(text)}`);
    assert.ok(text.includes('# 我的训记 Key'));
    assert.ok(text.includes('# AI'));
    assert.ok(text.includes('LLM_MODEL=m'));
  });

  it('envPathOf 指向工作目录下的 .env', () => {
    // 只断言「拼在传入目录下、文件名叫 .env」—— 具体的绝对路径形态依平台而异
    // （Windows 上 `/tmp/x` 会被 resolve 成 `C:\tmp\x`，写死路径的断言会假失败）。
    assert.equal(envPathOf(process.cwd()), path.join(process.cwd(), '.env'));
    assert.equal(path.basename(envPathOf('/tmp/somewhere')), '.env');
  });
});
