/**
 * T2 映射层测试：ruleEngine（纯函数）+ catalogService（导入/回填集成）。
 *
 * 数据策略：
 *   - 规则/肌群字典直接读真实 seeds/（它们是代码的静态部分）；
 *   - 目录用内联 mini fixture（不依赖 data/probe，符合测试自包含纪律）；
 *   - 真实 48 动作覆盖率验证：目录种子 seeds/catalog_seed.json 随仓库内置；仍需本机 data/app.db
 *     与 data/probe/ 日数据（个人训练数据，不入库）才执行，故该 describe 依然只在开发机运行。
 * 红线：零网络；DB 用临时文件。
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { rmSync } from 'node:fs';
import { makeTempDb } from './fixtures.js';
import {
  matchRules, normName, resolveName, loadRulesFromDb, type KeywordRule,
} from '../server/catalog/ruleEngine.js';
import {
  importAll, importMuscleGroups, importServerTypeMap, importCatalog,
  applyManualMap, applyAliasSeed, storeKeywordRules, backfillSessionMovements, loadSeeds,
} from '../server/catalog/catalogService.js';
import { prepare } from '../server/db/index.js';

/** 测试收尾：先关 DB（Windows 下不关会 EBUSY），再删临时目录（同 T1 约定）。 */
function makeCleanup(db: ReturnType<typeof makeTempDb>['db'], dir: string): () => void {
  return () => {
    try { db.close(); } catch { /* 已关闭 */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  };
}

const RULES = JSON.parse(fs.readFileSync('seeds/keyword_rules.json', 'utf8')) as KeywordRule[];

// ---------- 纯函数：matchRules ----------

describe('matchRules：exclude 机制（N1 实测回归）', () => {
  test('哈克机早安 命中 KR-002（hinge 后链），不被 KR-005（squat）吞掉', () => {
    const r = matchRules('哈克机早安', RULES);
    assert.ok(r.matchedRules.includes('KR-002'));
    assert.ok(!r.matchedRules.includes('KR-005'), 'exclude [早安] 应拦截 KR-005');
    assert.equal(r.pattern, 'hinge');
    const codes = r.muscles.map((m) => m.code);
    assert.ok(codes.includes('hamstrings') && codes.includes('glutes'));
    assert.ok(!codes.includes('quads'), '早安不该有股四头');
  });

  test('器械胸部推举 命中 KR-001（含新词胸部推举），不被 KR-007（推举）误判为肩主导', () => {
    const r = matchRules('器械胸部推举', RULES);
    assert.ok(r.matchedRules.includes('KR-001'));
    assert.ok(!r.matchedRules.includes('KR-007'), 'exclude [胸] 应拦截 KR-007');
    assert.ok(r.muscles.some((m) => m.code === 'chest' && m.role === 'primary'), '胸应为 primary');
    assert.ok(
      !r.muscles.some((m) => m.code === 'shoulder_front' && m.role === 'primary'),
      '肩前束不得作为 primary（KR-001 的 secondary 肩前束属正常辅助刺激）',
    );
  });

  test('器械推胸（版本2） 命中 KR-001（全角括号归一化不影响）', () => {
    const r = matchRules('器械推胸（版本2）', RULES);
    assert.ok(r.matchedRules.includes('KR-001'));
    assert.ok(!r.matchedRules.includes('KR-007'));
  });

  test('绳索交叉后束飞鸟 命中 KR-009（后束），exclude 拦截 KR-001（胸）', () => {
    const r = matchRules('绳索交叉后束飞鸟', RULES);
    assert.ok(r.matchedRules.includes('KR-009'));
    assert.ok(!r.matchedRules.includes('KR-001'), 'exclude [后束/反向] 应拦截 KR-001');
    const codes = r.muscles.map((m) => m.code);
    assert.ok(codes.includes('shoulder_rear'));
    assert.ok(!codes.includes('chest'));
  });

  test('28 变体全部可由规则或别名语义命中（关键词层全量回归）', () => {
    const variants = [
      '站姿旋转划船', '暂停卧推', '哈克机反向深蹲', '弹力带辅助引体向上',
      '把手式蝴蝶机飞鸟', '对握高位下拉', '哑铃保加利亚蹲', '抬腿杠铃卧推',
      '哑铃农夫行走', '有氧训练', '宽距高位下拉', '站姿驴踢',
      '器械后蹬', '俯卧哑铃划船（锤式）', '杠铃罗马尼亚硬拉', '绳索侧踢',
      '站姿绳索高位下拉', '悍马机深蹲', '绳索交叉后束飞鸟', '哈克机早安',
      '绳索十字夹胸', '器械胸部推举', '器械推胸（版本2）', '颈后下拉',
      '悬挂抬腿', '器械坐姿反向飞鸟', '悬垂拉伸', '箱式深蹲',
    ];
    for (const v of variants) {
      const r = matchRules(v, RULES);
      assert.ok(r.matchedRules.length > 0, `${v} 应至少命中一条规则`);
      assert.ok(r.muscles.length > 0, `${v} 应产出肌群结论`);
    }
  });

  test('归一化：normName 处理空白与全角括号', () => {
    assert.equal(normName('器械推胸 （版本2）'), normName('器械推胸（版本2）'));
    assert.equal(normName('V-Bar 绳索下压'), 'v-bar绳索下压');
  });
});

// ---------- 集成：mini fixture 导入 + resolveName 四路径 ----------

const MINI_CATALOG = {
  empty: {
    body: {
      res: {
        schema: 'movement_catalog_v1',
        version: 1,
        movements: [
          { name: '杠铃卧推', type: '胸', exetype: '', aliases: [] },
          { name: '深蹲', type: '腿', exetype: '', aliases: [] },
          { name: '蝴蝶机反向飞鸟', type: '肩', exetype: '', aliases: [] },
          { name: '早安', type: '臀部', exetype: '', aliases: [] },
          { name: '跑步', type: '有氧', exetype: 'cardio', aliases: [] },
          { name: '自重深蹲', type: '自重', exetype: '', aliases: [] },
        ],
      },
    },
  },
};

function setupMiniDb(): { db: ReturnType<typeof makeTempDb>['db']; cleanup: () => void } {
  const { db, dir } = makeTempDb();
  importMuscleGroups(db, JSON.parse(fs.readFileSync('seeds/muscle_groups.json', 'utf8')));
  importServerTypeMap(db, JSON.parse(fs.readFileSync('seeds/server_type_map.json', 'utf8')));
  importCatalog(db, MINI_CATALOG);
  applyManualMap(db, JSON.parse(fs.readFileSync('seeds/manual_map_seed.json', 'utf8')).items);
  applyAliasSeed(db, JSON.parse(fs.readFileSync('seeds/alias_seed.json', 'utf8')).items);
  storeKeywordRules(db, RULES);
  return { db, cleanup: makeCleanup(db, dir) };
}

describe('resolveName：四路径', () => {
  const { db, cleanup } = setupMiniDb();

  test('路径1 精确目录名 → manual 覆盖生效（蝴蝶机反向飞鸟 = 后束，非 server 的前/中拆分）', () => {
    const r = resolveName(db, '蝴蝶机反向飞鸟', RULES);
    assert.equal(r.source, 'catalog');
    assert.equal(r.detailSource, 'manual');
    assert.equal(r.via, 'exact');
    const primary = r.muscles.filter((m) => m.role === 'primary');
    assert.deepEqual(primary.map((m) => m.code), ['shoulder_rear']);
    assert.ok(!r.muscles.some((m) => m.code === 'shoulder_front'), 'manual 覆盖后不应残留 server 的前束行');
  });

  test('路径2 别名 → catalog 结论（暂停卧推 → 杠铃卧推）', () => {
    const r = resolveName(db, '暂停卧推', RULES);
    assert.equal(r.source, 'catalog');
    assert.equal(r.via, 'alias');
    assert.equal(r.catalogName, '杠铃卧推');
    assert.ok(r.muscles.some((m) => m.code === 'chest' && m.role === 'primary'));
  });

  test('路径3 关键词规则（哑铃农夫行走：无标准名，规则给肌群）', () => {
    const r = resolveName(db, '哑铃农夫行走', RULES);
    assert.equal(r.source, 'rule');
    assert.equal(r.catalogId, null);
    assert.ok(r.muscles.some((m) => m.code === 'forearm'));
    assert.equal(r.pattern, 'carry');
  });

  test('路径4 未识别 → none', () => {
    const r = resolveName(db, '完全不存在的动作xyz', RULES);
    assert.equal(r.source, 'none');
    assert.equal(r.muscles.length, 0);
  });

  test('有氧目录动作 is_cardio=true（跑步）', () => {
    const r = resolveName(db, '跑步', RULES);
    assert.equal(r.isCardio, true);
    assert.equal(r.muscles[0]?.code, 'cardio');
  });

  test('自重类目录动作不给肌群结论（留给规则层），精确命中但 muscles 可能走不到 server 行', () => {
    const r = resolveName(db, '自重深蹲', RULES);
    assert.equal(r.source, 'catalog');
    assert.equal(r.via, 'exact');
    // UNMAPPED_TYPES 跳过：muscle_map 无行 → muscles 为空；is_cardio=false
    assert.equal(r.muscles.length, 0);
    assert.equal(r.isCardio, false);
  });

  after(cleanup);
});

// ---------- backfill 集成 ----------

describe('backfillSessionMovements', () => {
  test('回填 catalog_id / resolve_status / unresolved 记录', () => {
    const { db, cleanup } = setupMiniDb();
    // 插入 session 数据
    prepare(db, `
      INSERT INTO train_session (id, datestr, localid, title, is_rest, content_hash, synced_at)
      VALUES (1, '2026-09-01', '9001', '', 0, 'hash-test', '2026-09-01T00:00:00Z')
    `).run();
    const ins = prepare(db, `
      INSERT INTO session_movement (id, session_id, ord, name_raw, name_norm, created_at)
      VALUES (?, 1, ?, ?, ?, '2026-09-01T00:00:00Z')
    `);
    ins.run(1, 1, '杠铃卧推', '杠铃卧推');
    ins.run(2, 2, '暂停卧推', '暂停卧推');       // 别名
    ins.run(3, 3, '哑铃农夫行走', '哑铃农夫行走'); // 规则
    ins.run(4, 4, '神秘动作abc', '神秘动作abc');   // 未识别

    const stats = backfillSessionMovements(db);
    assert.equal(stats.total, 4);
    assert.equal(stats.resolved, 3);
    assert.equal(stats.byRule, 1);
    assert.equal(stats.unresolved, 1);

    const st = (id: number) =>
      (prepare(db, 'SELECT catalog_id, resolve_status, is_cardio FROM session_movement WHERE id = ?').get(id) as {
        catalog_id: number | null; resolve_status: string; is_cardio: number;
      });
    assert.ok(st(1).catalog_id !== null && st(1).resolve_status === 'exact');
    assert.ok(st(2).catalog_id !== null && st(2).resolve_status === 'alias');
    assert.equal(st(3).catalog_id, null);
    assert.equal(st(3).resolve_status, 'rule');

    const unres = prepare(db, "SELECT name_raw, status FROM movement_unresolved WHERE name_raw = '神秘动作abc'").get() as { name_raw: string; status: string };
    assert.equal(unres.status, 'open');

    // 幂等：重跑不重复计数（hit_count 不翻倍）
    const stats2 = backfillSessionMovements(db);
    assert.equal(stats2.unresolved, 1);
    const hit = (prepare(db, 'SELECT hit_count FROM movement_unresolved WHERE name_raw = ?').get('神秘动作abc') as { hit_count: number });
    assert.equal(Number(hit.hit_count), 1, '同批重跑不累计 hit_count');

    cleanup();
  });
});

// ---------- 回归护栏：catalog 种子随仓库内置，只吃 seeds/，不依赖本机 data/ ----------

/**
 * 回归护栏（只吃 seeds/catalog_seed.json，绝不读 data/、不联网、不依赖本机 data/app.db）。
 *
 * 背景：修复前 loadSeeds() 默认读 data/probe/catalog_probe.json（被 .gitignore 忽略），
 * 新 clone 上必然 ENOENT；而下方「真实 48 动作」describe 的守卫需要本机 data/app.db +
 * data/probe/ 日数据，在别人的 clone 上会整段静默跳过 → 该缺陷长期无护栏。
 *
 * 本用例在【空库 + 仓库内种子】下验证导入全程可用；它不依赖 data/，因此在任何 clone 上
 * 都会真正执行（不是 testif 守卫后的 skip）。
 *
 * 注：目录 259 个条目中有 5 组重名（正手杠铃弯举/平板支撑/跑步/游泳/动感单车），
 * movement_catalog.name 上有唯一约束（importCatalog 的 ON CONFLICT(name)），
 * 故落库行数为去重后的 254，而非 259。
 */
test('catalog 种子内置回归：仅 seeds/catalog_seed.json 即可完成导入（不依赖本机 data/）', () => {
  const input = loadSeeds(); // 默认参数：seeds/ + seeds/catalog_seed.json
  const names = input.catalogFile.empty.body.res.movements.map((m) => m.name);
  assert.equal(names.length, 259, '目录条目数应为 259');
  const distinct = new Set(names).size;
  assert.equal(distinct, 254, '目录去重后应为 254 个不同动作名');

  const { db, dir } = makeTempDb();
  try {
    const before = (prepare(db, 'SELECT COUNT(*) AS c FROM movement_catalog').get() as { c: number }).c;
    assert.equal(Number(before), 0, '空库起点应为 0 行');

    const res = importCatalog(db, input.catalogFile); // 不抛异常
    const after = (prepare(db, 'SELECT COUNT(*) AS c FROM movement_catalog').get() as { c: number }).c;
    assert.equal(Number(after), distinct, 'movement_catalog 行数 = 去重后动作名数');
    assert.equal(res.catalogCount, 259, 'catalogCount 应为处理条目数 259');
  } finally {
    makeCleanup(db, dir)();
  }
});

// ---------- 真实数据全量验证（本机有 data/probe 时执行） ----------

describe('真实 48 动作全覆盖（目录种子 seeds/catalog_seed.json + 本机 data/probe 日数据）', () => {
  const hasReal = fs.existsSync('seeds/catalog_seed.json') && fs.existsSync('data/app.db');
  testif(hasReal)('90 天真实数据覆盖率 100%（20 精确 + 24 别名 + 4 规则）', () => {
    const seeds = loadSeeds();
    assert.ok(seeds.catalogFile.empty.body.res.movements.length === 259);
    const { db, dir } = makeTempDb();
    try {
      const result = importAll(db, seeds);
      assert.equal(result.backfill.unresolved, 0);
      assert.equal(result.manualMissing.length, 0);
      assert.equal(result.aliasMissing.length, 0);
      // 48 去重名全部可解析
      const rules = loadRulesFromDb(db);
      for (const n of realNames()) {
        const r = resolveName(db, n, rules);
        assert.notEqual(r.source, 'none', `${n} 不应未识别`);
      }
    } finally {
      makeCleanup(db, dir)();
    }
  });
});

/** 从真实 probe 数据提取 48 个动作名（存在才调用）。 */
function realNames(): string[] {
  const path = 'data/probe';
  const set = new Set<string>();
  for (const f of fs.readdirSync(path)) {
    if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) continue;
    const j = JSON.parse(fs.readFileSync(`${path}/${f}`, 'utf8'));
    for (const t of j?.res?.trains ?? []) for (const mv of t.movements ?? []) set.add(mv.name);
  }
  return [...set];
}

function testif(cond: boolean): (name: string, fn: () => void) => void {
  return cond ? (name, fn) => test(name, fn) : (name) => test.skip(name, () => {});
}
