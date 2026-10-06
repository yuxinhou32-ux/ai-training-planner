/**
 * 身体信息 + 用户画像测试（PRD-v2 §10.3 V9）。
 *
 * 验收标准（§10.1）：「**体重与旧伤进入 AI 输入；画像不平铺**」。
 * 前一半在这里被拆成两条：
 *  ① `digest.profile.body` 确实带上了体重与旧伤（进了 AI 输入）；
 *  ② 🔴 **它只改这一个字段** —— 旧伤/体重不得改变硬约束、候选池、本周切片的任何一个字节。
 *     这条是本文件最重要的用例：PRD-v2 §5 白纸黑字「旧伤：只作参考，不自动禁用相关动作」，
 *     而「AI 看到『腰突』就悄悄把硬拉滤掉」正是最容易在实现里复发的那种走样。
 *
 * 后一半（画像不平铺）是纯前端行为，靠 `useProfile(enabled)` 的延迟加载保证，不在这里测。
 *
 * 零真实网络：只调本地服务与摘要层。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, test } from 'node:test';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  BodyServiceError,
  CONDITIONS_MAX_CHARS,
  getBodyInfo,
  listWeights,
  loadBodyForDigest,
  saveBodyInfo,
} from '../server/body/bodyService.js';
import { buildProfileView } from '../server/profile/profileService.js';
import { handleBodyRoutes } from '../server/api/routes/body.js';
import { HttpError } from '../server/api/errors.js';
import { buildPlanDigest, PLAN_INPUT_SCHEMA_VERSION } from '../server/ai/digest.js';
import type { AnalysisReport, GoalConstraints } from '../server/analysis/reportSchema.js';
import { makeTempDb } from './fixtures.js';
import { ANALYSIS_WINDOW_PRESET, ANALYSIS_WINDOW_WEEKS } from '../server/analysis/window.js';
import type { Db } from '../server/db/index.js';
import { shiftDays } from '../server/util/dates.js';
import { prepare } from '../server/db/index.js';

// 「现在」固定 = 2026-10-01 本地 10:00（与其它测试同一锚点纪律：不许靠跑测试那天恰好是几号）
const NOW_MS = new Date('2026-10-01T10:00:00').getTime();
const TODAY = '2026-10-01';
const NOW_ISO = new Date(NOW_MS).toISOString();
const WEEK_START = '2026-10-05'; // 周一

function freshDb(): Db {
  return makeTempDb().db;
}

/** 真实库里的 22 条肌群（画像的 `profile.muscles` 要有东西可列）。 */
function seedMuscleGroups(db: Db): void {
  const rows = JSON.parse(
    readFileSync(path.join(process.cwd(), 'seeds', 'muscle_groups.json'), 'utf8'),
  ) as Array<{
    code: string;
    name_zh: string;
    parent_code: string | null;
    region: string;
    size: string;
    sort_no: number;
  }>;
  const ins = prepare(
    db,
    'INSERT INTO muscle_group (code, name_zh, parent_code, region, size, sort_no) VALUES (?, ?, NULL, ?, ?, ?)',
  );
  for (const r of rows) ins.run(r.code, r.name_zh, r.region, r.size, r.sort_no);
  const upd = prepare(db, 'UPDATE muscle_group SET parent_code = ? WHERE code = ?');
  for (const r of rows) if (r.parent_code !== null) upd.run(r.parent_code, r.code);
}

/**
 * 插一份报告快照（画像的全部数字都从它来）。
 * 🔴 必须是 `kind='snapshot'`：画像页只认冻结的画像版本，adhoc 过程产物会被排除。
 */
function seedReport(db: Db, report: AnalysisReport): number {
  const r = db
    .prepare(
      `INSERT INTO analysis_report (window_start, window_end, window_preset, params_json, payload_json, payload_hash, generated_at, kind, version_no)
       VALUES (?, ?, '${ANALYSIS_WINDOW_PRESET}', '{}', ?, 'hash-body-test', ?, 'snapshot', 0)`,
    )
    .run(report.window.trend_start, report.window.trend_end, JSON.stringify(report), NOW_ISO);
  return Number(r.lastInsertRowid);
}

function expect400(fn: () => unknown, keyword: string): void {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof BodyServiceError, `应抛 BodyServiceError，实际 ${String(e)}`);
    assert.equal((e as BodyServiceError).status, 400);
    assert.ok(
      (e as Error).message.includes(keyword),
      `错误信息应包含「${keyword}」，实际「${(e as Error).message}」`,
    );
    return;
  }
  assert.fail('应当抛错但没有');
}

// ---------------------------------------------------------------------------
// 1. 读取：空库
// ---------------------------------------------------------------------------

describe('身体信息：读取', () => {
  it('空库 → 什么都没填，且不会造出 0 体重', () => {
    const info = getBodyInfo(freshDb(), NOW_MS);
    assert.equal(info.conditions, '');
    assert.equal(info.weight_kg, null);
    assert.equal(info.weight_date, null);
    // 只有一条记录时「变化」应为 null 而不是 0 —— 给 0 会让 AI 以为「最近很平稳」
    assert.equal(info.delta_30d_kg, null);
    assert.equal(info.updated_at, null);
  });

  it('app_config 里的旧伤文本被手工改坏 → 当成没填，不炸页面', () => {
    const db = freshDb();
    prepare(db, 'INSERT INTO app_config (key, value_json, updated_at) VALUES (?, ?, ?)').run(
      'body_info',
      'not-json{',
      NOW_ISO,
    );
    assert.equal(getBodyInfo(db, NOW_MS).conditions, '');
  });

  it('摘要层入口把空串统一成 null（对 AI 的信号是「没有这回事」）', () => {
    const db = freshDb();
    assert.deepEqual(loadBodyForDigest(db, NOW_MS), {
      weight_kg: null,
      weight_date: null,
      delta_30d_kg: null,
      conditions: null,
      gender: null,
      age: null,
      height_cm: null,
      training_years: null,
    });
    saveBodyInfo(db, { conditions: '   ' }, NOW_MS);
    assert.equal(loadBodyForDigest(db, NOW_MS).conditions, null, '只写了空白 → 等同没填');
  });
});

// ---------------------------------------------------------------------------
// 2. 校验
// ---------------------------------------------------------------------------

describe('身体信息：校验', () => {
  it('旧伤文本超长 / 非字符串 → 400', () => {
    const db = freshDb();
    expect400(() => saveBodyInfo(db, { conditions: 'x'.repeat(CONDITIONS_MAX_CHARS + 1) }, NOW_MS), '最多');
    expect400(() => saveBodyInfo(db, { conditions: 123 }, NOW_MS), '必须是字符串');
  });

  it('体重超出 20~400 kg 或不是数字 → 400（边界值放行）', () => {
    const db = freshDb();
    expect400(() => saveBodyInfo(db, { weight_kg: 19.9 }, NOW_MS), '20~400');
    expect400(() => saveBodyInfo(db, { weight_kg: 400.1 }, NOW_MS), '20~400');
    expect400(() => saveBodyInfo(db, { weight_kg: '58.5' }, NOW_MS), '必须是数字');
    expect400(() => saveBodyInfo(db, { weight_kg: Number.NaN }, NOW_MS), '必须是数字');
    // 边界值应当放行
    assert.equal(saveBodyInfo(db, { weight_kg: 20, datestr: '2026-09-01' }, NOW_MS).weight_kg, 20);
    assert.equal(saveBodyInfo(db, { weight_kg: 400, datestr: '2026-09-02' }, NOW_MS).weight_kg, 400);
  });

  it('体重保留一位小数（77.44 → 77.4）', () => {
    const db = freshDb();
    assert.equal(saveBodyInfo(db, { weight_kg: 77.44 }, NOW_MS).weight_kg, 77.4);
  });

  it('日期非法 / 未来 → 400；请求体不是对象 / 没有可改字段 → 400', () => {
    const db = freshDb();
    expect400(() => saveBodyInfo(db, { weight_kg: 58, datestr: '2026-02-30' }, NOW_MS), 'datestr');
    expect400(() => saveBodyInfo(db, { weight_kg: 58, datestr: '2026-13-01' }, NOW_MS), 'datestr');
    // 体重是一个「测量结果」，不能记在明天
    expect400(() => saveBodyInfo(db, { weight_kg: 58, datestr: shiftDays(TODAY, 1) }, NOW_MS), '今天或更早');
    expect400(() => saveBodyInfo(db, null, NOW_MS), '必须是对象');
    expect400(() => saveBodyInfo(db, [], NOW_MS), '必须是对象');
    expect400(() => saveBodyInfo(db, {}, NOW_MS), '至少要给一个');
  });

  it('校验失败时库不变（校验都在事务之前）', () => {
    const db = freshDb();
    saveBodyInfo(db, { conditions: '腰突', weight_kg: 58 }, NOW_MS);
    expect400(() => saveBodyInfo(db, { conditions: 'x'.repeat(999) }, NOW_MS), '最多');
    const info = getBodyInfo(db, NOW_MS);
    assert.equal(info.conditions, '腰突');
    assert.equal(info.weight_kg, 58);
  });
});

// ---------------------------------------------------------------------------
// 3. 写入语义
// ---------------------------------------------------------------------------

describe('身体信息：写入', () => {
  it('同一天再保存 = 覆盖（只一行，不新增）', () => {
    const db = freshDb();
    saveBodyInfo(db, { weight_kg: 58.4 }, NOW_MS);
    saveBodyInfo(db, { weight_kg: 58.1 }, NOW_MS);
    const rows = listWeights(db, { nowMs: NOW_MS });
    assert.equal(rows.length, 1, '一天只允许一行');
    assert.deepEqual(rows[0], { datestr: TODAY, weight_kg: 58.1 });
  });

  it('可以补记过去的日期；weight_kg: null 删除那一条，再删一次幂等', () => {
    const db = freshDb();
    saveBodyInfo(db, { weight_kg: 59, datestr: shiftDays(TODAY, -3) }, NOW_MS);
    saveBodyInfo(db, { weight_kg: 58.5 }, NOW_MS);
    assert.deepEqual(
      listWeights(db, { nowMs: NOW_MS }).map((w) => w.datestr),
      [shiftDays(TODAY, -3), TODAY],
      '升序',
    );

    saveBodyInfo(db, { weight_kg: null, datestr: shiftDays(TODAY, -3) }, NOW_MS);
    assert.equal(listWeights(db, { nowMs: NOW_MS }).length, 1);
    // 连点两次删除不该报错
    saveBodyInfo(db, { weight_kg: null, datestr: shiftDays(TODAY, -3) }, NOW_MS);
    assert.equal(listWeights(db, { nowMs: NOW_MS }).length, 1);
  });

  it('旧伤文本可以清空（空串），但不会把 key 删掉', () => {
    const db = freshDb();
    saveBodyInfo(db, { conditions: '腰突' }, NOW_MS);
    assert.equal(getBodyInfo(db, NOW_MS).conditions, '腰突');
    assert.equal(saveBodyInfo(db, { conditions: '' }, NOW_MS).conditions, '');
  });

  it('只给体重时不动旧伤，只给旧伤时不动体重（部分更新）', () => {
    const db = freshDb();
    saveBodyInfo(db, { conditions: '腰突', weight_kg: 58 }, NOW_MS);
    const afterWeight = saveBodyInfo(db, { weight_kg: 57.5 }, NOW_MS);
    assert.equal(afterWeight.conditions, '腰突');
    const afterCond = saveBodyInfo(db, { conditions: '腰突 + 右肩' }, NOW_MS);
    assert.equal(afterCond.weight_kg, 57.5);
  });

  it('listWeights 的窗口是「今天 − N 天」，不是「最后一条 − N 天」', () => {
    const db = freshDb();
    // 半年前量过一次，之后再没量过：默认 180 天窗口应当看不见它
    saveBodyInfo(db, { weight_kg: 60, datestr: '2026-01-01' }, NOW_MS);
    saveBodyInfo(db, { weight_kg: 58, datestr: shiftDays(TODAY, -2) }, NOW_MS);
    assert.deepEqual(
      listWeights(db, { nowMs: NOW_MS }).map((w) => w.datestr),
      [shiftDays(TODAY, -2)],
      '老记录不该混进「最近」',
    );
    assert.equal(listWeights(db, { days: 0, nowMs: NOW_MS }).length, 2, 'days=0 = 全量');
  });
});

// ---------------------------------------------------------------------------
// 3.5 个人基础信息的新增字段（性别 / 年龄 / 身高 / 训练年限）—— 2026-09-30
//
// 全部可空、非必填（用户定案「他填了就保存，不填就默认为空」）。
// 本组最重要的用例是「只改一个字段不会抹掉同一份 JSON 里的其它字段」：
// `app_config['body_info']` 是**一份 JSON 整体覆写**，写成 `{ age }` 就会丢数据，
// 而且界面上看起来只是改了年龄，不会有人立刻发现旧伤没了。
// ---------------------------------------------------------------------------

describe('个人基础信息：新增字段', () => {
  it('全部可空：新库里四个字段都是 null（不填是 null，不是 0 也不是空串）', () => {
    const info = getBodyInfo(freshDb(), NOW_MS);
    assert.equal(info.gender, null);
    assert.equal(info.age, null);
    assert.equal(info.height_cm, null);
    assert.equal(info.training_years, null);
  });

  it('🔴 只改一个字段不会抹掉同一份 JSON 里的其它字段（读-改-写）', () => {
    const db = freshDb();
    saveBodyInfo(db, { conditions: '腰突' }, NOW_MS);
    saveBodyInfo(db, { gender: '女' }, NOW_MS);
    saveBodyInfo(db, { age: 31 }, NOW_MS);
    const info = getBodyInfo(db, NOW_MS);
    assert.equal(info.gender, '女');
    assert.equal(info.age, 31);
    assert.equal(
      info.conditions,
      '腰突',
      'body_info 是一份 JSON 整体覆写 —— 写成 JSON.stringify({ age }) 会在这里挂掉',
    );
  });

  it('写基础信息不会动体重，写体重不会动基础信息', () => {
    const db = freshDb();
    saveBodyInfo(db, { gender: '女' }, NOW_MS);
    assert.equal(saveBodyInfo(db, { weight_kg: 58.4 }, NOW_MS).gender, '女');
    assert.equal(saveBodyInfo(db, { age: 31 }, NOW_MS).weight_kg, 58.4);
  });

  it('null / 空串 = 清空那一项，且不牵连同一份 JSON 的其它键', () => {
    const db = freshDb();
    saveBodyInfo(
      db,
      { gender: '男', age: 30, height_cm: 170, training_years: '1~3 年', conditions: '腰突' },
      NOW_MS,
    );
    assert.equal(saveBodyInfo(db, { gender: null }, NOW_MS).gender, null);
    const after = getBodyInfo(db, NOW_MS);
    assert.equal(after.age, 30, '清 gender 不该动 age');
    assert.equal(after.conditions, '腰突');
    // 文本类字段允许用空串表达清空（前端把输入框清空就是发空串）
    assert.equal(saveBodyInfo(db, { training_years: '' }, NOW_MS).training_years, null);
  });

  it('枚举白名单：名单外的值一律 400（这些值会原样进 AI 的 prompt）', () => {
    const db = freshDb();
    expect400(() => saveBodyInfo(db, { gender: '女 ' }, NOW_MS), 'gender');
    expect400(() => saveBodyInfo(db, { gender: 'female' }, NOW_MS), 'gender');
    expect400(() => saveBodyInfo(db, { training_years: '5 年' }, NOW_MS), 'training_years');
  });

  it('年龄 / 身高：只收区间内的整数（小数、超范围 → 400；边界放行）', () => {
    const db = freshDb();
    expect400(() => saveBodyInfo(db, { age: 9 }, NOW_MS), '年龄');
    expect400(() => saveBodyInfo(db, { age: 101 }, NOW_MS), '年龄');
    expect400(() => saveBodyInfo(db, { age: 30.5 }, NOW_MS), '整数');
    expect400(() => saveBodyInfo(db, { height_cm: 99 }, NOW_MS), '身高');
    expect400(() => saveBodyInfo(db, { height_cm: 251 }, NOW_MS), '身高');
    assert.equal(saveBodyInfo(db, { age: 10 }, NOW_MS).age, 10);
    assert.equal(saveBodyInfo(db, { height_cm: 250 }, NOW_MS).height_cm, 250);
  });

  it('JSON 被手工改坏 / 某一项类型不对 → 那一项当没填，其余照常读出来', () => {
    const db = freshDb();
    prepare(db, 'INSERT INTO app_config (key, value_json, updated_at) VALUES (?, ?, ?)').run(
      'body_info',
      '{"conditions":"腰突","gender":123,"age":"x","height_cm":null}',
      NOW_ISO,
    );
    const info = getBodyInfo(db, NOW_MS);
    assert.equal(info.conditions, '腰突', '类型对的键照常读出来');
    assert.equal(info.gender, null, '类型不对的当没填');
    assert.equal(info.age, null);

    prepare(db, 'UPDATE app_config SET value_json = ? WHERE key = ?').run('not-json{', 'body_info');
    const broken = getBodyInfo(db, NOW_MS);
    assert.equal(broken.gender, null);
    assert.equal(broken.conditions, '');
  });

  it('校验失败时库不变（校验都在事务之前）', () => {
    const db = freshDb();
    saveBodyInfo(db, { gender: '女' }, NOW_MS);
    expect400(() => saveBodyInfo(db, { gender: '女', age: 999 }, NOW_MS), '年龄');
    assert.equal(getBodyInfo(db, NOW_MS).gender, '女');
  });
});

// ---------------------------------------------------------------------------
// 4. 30 天变化
// ---------------------------------------------------------------------------

describe('身体信息：近 30 天变化', () => {
  it('两条记录都在窗口内 → 最新 − 最早', () => {
    const db = freshDb();
    saveBodyInfo(db, { weight_kg: 60, datestr: shiftDays(TODAY, -25) }, NOW_MS);
    saveBodyInfo(db, { weight_kg: 58.5 }, NOW_MS);
    assert.equal(getBodyInfo(db, NOW_MS).delta_30d_kg, -1.5);
  });

  it('窗口外的老记录不作基准 → null（不是拿三个月前比）', () => {
    const db = freshDb();
    saveBodyInfo(db, { weight_kg: 65, datestr: shiftDays(TODAY, -100) }, NOW_MS);
    saveBodyInfo(db, { weight_kg: 58.5 }, NOW_MS);
    assert.equal(getBodyInfo(db, NOW_MS).delta_30d_kg, null);
  });

  it('窗口内有三条 → 基准取窗口内最早那条，不是上一条', () => {
    const db = freshDb();
    saveBodyInfo(db, { weight_kg: 60, datestr: shiftDays(TODAY, -20) }, NOW_MS);
    saveBodyInfo(db, { weight_kg: 62, datestr: shiftDays(TODAY, -10) }, NOW_MS);
    saveBodyInfo(db, { weight_kg: 58, datestr: shiftDays(TODAY, -1) }, NOW_MS);
    assert.equal(getBodyInfo(db, NOW_MS).delta_30d_kg, -2);
  });
});

// ---------------------------------------------------------------------------
// 5. 🔴 摘要层：进了 AI 输入，且只改这一个字段
// ---------------------------------------------------------------------------

const GOAL: GoalConstraints = {
  goal_type: '减脂保肌',
  sessions_per_week: 3,
  min_duration_min: 60,
  max_duration_min: 90,
  week_start_dow: 1,
  preferred_dows: [1, 3, 5],
};

/** 最小报告：候选池为空即可 —— 本组用例关心的是「旧伤有没有动到别的字段」。 */
function miniReport(): AnalysisReport {
  return {
    schema_version: '1.0',
    generated_at: NOW_ISO,
    window: {
      trend_start: shiftDays(WEEK_START, -84),
      trend_end: shiftDays(WEEK_START, -1),
      recent_start: shiftDays(WEEK_START, -28),
      recent_end: shiftDays(WEEK_START, -1),
      weeks: ANALYSIS_WINDOW_WEEKS,
      last_session: null,
    },
    data_quality: {
      duration_coverage: 1,
      unmapped_set_ratio: 0,
      total_sessions: 0,
      synced_days: 0,
      warmup_source: 'server_set_type',
      warnings: [],
    },
    subjective_state: [],
    basic_stats: {
      total_sessions: 0,
      sessions_per_week: 0,
      avg_duration_min: null,
      duration_median_min: null,
      strength_sessions: 0,
      cardio_sessions: 0,
      total_effective_sets: 0,
      preferred_dows: [],
    },
    muscle_volume: {},
    movement_trends: [],
    muscle_trends: [],
    structure: { push_sets: 0, pull_sets: 0, push_pull_ratio: null, upper_lower_ratio: null, large_muscle_freq: {}, top_repeated_movements: [] },
    findings: [],
    constraints: { goal: null, hard_rules: [], soft_rules: [] },
    candidate_pool: [],
    writing_rules: {
      max_trains_per_batch: 4,
      max_movements_per_train: 15,
      max_sets_per_movement: 20,
      same_day_per_batch: true,
      movement_name_must_come_from: 'candidate_pool',
      name_language: 'zh-CN 标准名',
    },
  } as unknown as AnalysisReport;
}

function digestOf(db: Db) {
  return buildPlanDigest(db, {
    report: miniReport(),
    constraints: { goal: GOAL, hard_rules: [] },
    weekStart: WEEK_START,
    nowMs: NOW_MS,
  });
}

describe('摘要层：体重与旧伤进入 AI 输入（V9 验收）', () => {
  it('digest.profile.body 反映库里填的值；schema 版本升到 3.4', () => {
    const db = freshDb();
    saveBodyInfo(db, { weight_kg: 60, datestr: shiftDays(TODAY, -20) }, NOW_MS);
    saveBodyInfo(db, { weight_kg: 58.4 }, NOW_MS);
    saveBodyInfo(db, { conditions: '腰突（2020 年，已痊愈）' }, NOW_MS);
    saveBodyInfo(db, { gender: '女', age: 31, height_cm: 163, training_years: '1~3 年' }, NOW_MS);

    const d = digestOf(db);
    assert.equal(d.schema_version, '3.4');
    assert.equal(PLAN_INPUT_SCHEMA_VERSION, '3.4');
    assert.deepEqual(d.profile.body, {
      weight_kg: 58.4,
      weight_date: TODAY,
      delta_30d_kg: -1.6,
      conditions: '腰突（2020 年，已痊愈）',
      gender: '女',
      age: 31,
      height_cm: 163,
      training_years: '1~3 年',
    });
  });

  it('没填 → body 全为 null（不是空对象、不是 0）', () => {
    const d = digestOf(freshDb());
    assert.deepEqual(d.profile.body, {
      weight_kg: null,
      weight_date: null,
      delta_30d_kg: null,
      conditions: null,
      gender: null,
      age: null,
      height_cm: null,
      training_years: null,
    });
  });

  it('🔴 个人基础信息**只改** profile.body —— 硬约束 / 候选池 / 本周切片一个字节都不动', () => {
    const db = freshDb();
    const before = digestOf(db);

    saveBodyInfo(
      db,
      {
        weight_kg: 58.4,
        conditions: '腰突（2020 年，已痊愈），右肩习惯性脱位',
        gender: '女',
        age: 31,
        height_cm: 163,
        training_years: '1~3 年',
      },
      NOW_MS,
    );
    const after = digestOf(db);

    assert.notDeepEqual(after.profile.body, before.profile.body, '先确认它确实生效了，否则下面的断言没有意义');
    assert.equal(after.profile.body.conditions, '腰突（2020 年，已痊愈），右肩习惯性脱位');
    assert.equal(after.profile.body.training_years, '1~3 年');

    // 「旧伤只作参考，不自动禁用相关动作」（PRD-v2 §5）——
    // 下面每一条都是「不得因为旧伤而改变」：
    assert.deepEqual(after.constraints, before.constraints, '旧伤绝不能改动硬约束');
    assert.deepEqual(after.candidate_pool, before.candidate_pool, '旧伤绝不能过滤候选池');
    assert.deepEqual(after.week, before.week, '旧伤不能影响本周切片');
    assert.deepEqual(after.findings, before.findings, '旧伤不能凭空造出结论');
    assert.deepEqual(after.profile.muscles, before.profile.muscles);
    assert.deepEqual(after.profile.habit, before.profile.habit);
    assert.deepEqual(after.profile.structure, before.profile.structure);
  });
});

// ---------------------------------------------------------------------------
// 6. 画像视图
// ---------------------------------------------------------------------------

describe('用户画像视图', () => {
  it('没有分析报告 → null（画像的全部数字都来自报告）', () => {
    assert.equal(buildProfileView(freshDb(), NOW_MS), null);
  });

  it('有报告 → 画像带出窗口 / 习惯 / 肌群 / 结构 / 身体信息 / 动作趋势', () => {
    const db = freshDb();
    seedMuscleGroups(db);
    seedReport(db, {
      ...miniReport(),
      movement_trends: [
        {
          catalog_id: 1,
          name: '杠铃卧推',
          verdict: 'progress',
          weeks_with_data: 8,
          first_weight: 40,
          last_weight: 45,
          delta_weight_pct: 12.5,
          slope_weight_per_week: 0.6,
          avg_sets_per_week: 6,
          last_performed: shiftDays(TODAY, -2),
          volume_load_last: 1000,
        },
        {
          catalog_id: 2,
          name: '罗马尼亚硬拉',
          verdict: 'plateau',
          weeks_with_data: 10,
          first_weight: 70,
          last_weight: 70,
          delta_weight_pct: 0.2,
          slope_weight_per_week: 0,
          avg_sets_per_week: 5,
          last_performed: shiftDays(TODAY, -9),
          volume_load_last: 900,
        },
      ] as AnalysisReport['movement_trends'],
    } as AnalysisReport);
    saveBodyInfo(db, { weight_kg: 58.4, conditions: '腰突', gender: '女', age: 31 }, NOW_MS);

    const p = buildProfileView(db, NOW_MS);
    assert.ok(p, '有报告就必须有画像');
    assert.equal(p.window.weeks, ANALYSIS_WINDOW_WEEKS);
    assert.equal(p.report_id, 1);
    assert.equal(p.body.weight_kg, 58.4);
    assert.equal(p.body.conditions, '腰突', '画像页要拿到可编辑的原话（空串而不是 null）');
    assert.equal(p.body.gender, '女');
    assert.equal(p.body.age, 31);
    assert.equal(p.body.height_cm, null, '没填的照原样给 null');
    assert.deepEqual(
      p.movements.map((m) => m.name),
      ['杠铃卧推', '罗马尼亚硬拉'],
      '动作趋势按最近训练日期倒序',
    );
    assert.equal(p.movements[0]?.verdict, 'progress');
    assert.ok(p.muscles.length > 0, '肌群基线来自 muscle_group 表');
  });
});

// ---------------------------------------------------------------------------
// 7. 路由层
// ---------------------------------------------------------------------------

/** 最小 req：readBody 只用 data/end/error 三个事件。 */
function fakeReq(method: string, body?: unknown): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
  const stream = Readable.from(chunks) as unknown as IncomingMessage;
  stream.method = method;
  return stream;
}

interface Captured {
  status: number | null;
  body: unknown;
}

/** 最小 res：sendJson 只用 writeHead / end。 */
function fakeRes(): { res: ServerResponse; out: Captured } {
  const out: Captured = { status: null, body: null };
  const res = {
    writeHead(status: number) {
      out.status = status;
      return res;
    },
    end(buf?: Buffer | string) {
      out.body = buf === undefined ? null : JSON.parse(buf.toString('utf8'));
      return res;
    },
  } as unknown as ServerResponse;
  return { res, out };
}

/** 直接打路由器；期望它处理了这个路径（返回 true）。 */
async function call(
  db: Db,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<Captured> {
  const handler = handleBodyRoutes(db);
  const { res, out } = fakeRes();
  const handled = await handler(fakeReq(method, body), res, pathname);
  assert.equal(handled, true, `路由应当接住 ${method} ${pathname}`);
  return out;
}

/** 期望抛 HttpError。 */
async function callFail(db: Db, method: string, pathname: string, body?: unknown): Promise<HttpError> {
  const handler = handleBodyRoutes(db);
  const { res } = fakeRes();
  try {
    await handler(fakeReq(method, body), res, pathname);
  } catch (e) {
    assert.ok(e instanceof HttpError, `应抛 HttpError，实际 ${String(e)}`);
    return e as HttpError;
  }
  assert.fail(`${method} ${pathname} 应当抛错`);
}

describe('身体信息路由', () => {
  it('GET /api/body → 空状态', async () => {
    const out = await call(freshDb(), 'GET', '/api/body');
    assert.equal(out.status, 200);
    assert.deepEqual(out.body, {
      info: {
        conditions: '',
        gender: null,
        age: null,
        height_cm: null,
        training_years: null,
        weight_kg: null,
        weight_date: null,
        delta_30d_kg: null,
        updated_at: null,
      },
      weights: [],
    });
  });

  it('PUT /api/body → 基础信息走同一条部分更新（给哪个改哪个）', async () => {
    const db = freshDb();
    const a = await call(db, 'PUT', '/api/body', { gender: '女', age: 31 });
    const ai = (a.body as { info: { gender: string; age: number; conditions: string } }).info;
    assert.equal(ai.gender, '女');
    assert.equal(ai.age, 31);

    const b = await call(db, 'PUT', '/api/body', { training_years: '1~3 年' });
    const bi = (b.body as { info: { gender: string; age: number; training_years: string } }).info;
    assert.equal(bi.training_years, '1~3 年');
    assert.equal(bi.gender, '女', '只给训练年限不该动性别');
    assert.equal(bi.age, 31);

    // 清空一项
    const c = await call(db, 'PUT', '/api/body', { age: null });
    assert.equal((c.body as { info: { age: number | null } }).info.age, null);
  });

  it('PUT /api/body → 改完立刻回传完整状态（前端不用再问一次）', async () => {
    const db = freshDb();
    const a = await call(db, 'PUT', '/api/body', { conditions: '腰突' });
    assert.equal(a.status, 200);
    assert.equal((a.body as { info: { conditions: string } }).info.conditions, '腰突');

    const b = await call(db, 'PUT', '/api/body', { weight_kg: 58.4 });
    const bb = b.body as { info: { conditions: string; weight_kg: number }; weights: unknown[] };
    assert.equal(bb.info.conditions, '腰突', '只改体重不该动旧伤');
    assert.equal(bb.info.weight_kg, 58.4);
    assert.equal(bb.weights.length, 1);

    const c = await call(db, 'GET', '/api/body');
    assert.deepEqual(c.body, b.body, 'GET 读回来的就是 PUT 回传的那一份');
  });

  it('PUT /api/body 非法输入 → 400；非 JSON → 400；方法不对 → 405', async () => {
    const db = freshDb();
    assert.equal((await callFail(db, 'PUT', '/api/body', { weight_kg: 999 })).status, 400);
    assert.equal((await callFail(db, 'PUT', '/api/body', {})).status, 400);
    assert.equal((await callFail(db, 'PUT', '/api/body', [])).status, 400);
    assert.equal((await callFail(db, 'DELETE', '/api/body')).status, 405);
  });

  it('GET /api/profile → 无报告时 profile 为 null（不是 404）', async () => {
    const out = await call(freshDb(), 'GET', '/api/profile');
    assert.equal(out.status, 200);
    assert.deepEqual(out.body, { profile: null });
    // 「报告还没生成」是正常状态，不是路由不存在
    const handler = handleBodyRoutes(freshDb());
    const { res } = fakeRes();
    assert.equal(await handler(fakeReq('GET'), res, '/api/nope'), false, '不相关的路径必须放手给下一个路由');
  });

  it('POST /api/profile → 405', async () => {
    assert.equal((await callFail(freshDb(), 'POST', '/api/profile')).status, 405);
  });
});

// ---------------------------------------------------------------------------
// 8. schema
// ---------------------------------------------------------------------------

test('迁移 v6：weight_log 建表 + 幂等', () => {
  const { db } = makeTempDb();
  const cols = db.prepare(`SELECT name FROM pragma_table_info('weight_log')`).all() as unknown as Array<{ name: string }>;
  assert.deepEqual(
    cols.map((c) => c.name).sort(),
    ['created_at', 'datestr', 'updated_at', 'weight_kg'],
  );
  const v = db.prepare('SELECT MAX(version) AS v FROM schema_migration').get() as unknown as { v: number };
  assert.ok(Number(v.v) >= 6, `当前 schema 至少到 v6，实际 v${v.v}`);
});
