/**
 * 训练基础（user_goal）测试 —— PRD-v2 V1。
 *
 * 覆盖三件事：
 *  1. 入参校验：一周几练由训练日**推导**，不接受外部传入；训练日按周起点排序；
 *  2. 写入语义：改设置 = 新增一行 + 旧行 is_active=0（历史 plan.goal_id 指向不变）；
 *  3. 读回：GET 拿到的就是当前生效行。
 *
 * 计划侧「读实时值而非报告快照」的验收在 tests/plan.test.ts（那里有报告与候选池夹具）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GoalServiceError, getGoalSettings, saveGoalSettings, validateGoalInput } from '../server/goal/goalService.js';
import { makeTempDb } from './fixtures.js';
import type { Db } from '../server/db/index.js';

function emptyDb(): Db {
  return makeTempDb().db;
}

const BASE = {
  goal_type: '减脂保肌',
  min_duration_min: 60,
  max_duration_min: 90,
  week_start_dow: 1,
  preferred_dows: [1, 3, 5, 0],
};

function expect400(fn: () => unknown, keyword: string): void {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof GoalServiceError, `应抛 GoalServiceError，实际 ${String(e)}`);
    assert.equal((e as GoalServiceError).status, 400);
    assert.ok((e as Error).message.includes(keyword), `错误信息应包含「${keyword}」，实际「${(e as Error).message}」`);
    return;
  }
  assert.fail('应当抛错但没有');
}

describe('validateGoalInput', () => {
  it('sessions_per_week 由训练日数量推导，去重后不重复计数', () => {
    const v = validateGoalInput({ ...BASE, preferred_dows: [1, 3, 3, 5, 0] });
    assert.equal(v.sessionsPerWeek, 4);
    assert.deepEqual(v.preferredDows, [1, 3, 5, 0]);
  });

  it('训练日按「周起点」的时间顺序排列（不是简单 0~6 升序）', () => {
    // 周一起点：周日排在最后
    assert.deepEqual(validateGoalInput({ ...BASE, preferred_dows: [0, 5, 1, 3] }).preferredDows, [1, 3, 5, 0]);
    // 周日起点：周日排在最前
    assert.deepEqual(
      validateGoalInput({ ...BASE, week_start_dow: 0, preferred_dows: [1, 3, 5, 0] }).preferredDows,
      [0, 1, 3, 5],
    );
  });

  it('一周 7 天全选合法（schema CHECK 上限是 7）', () => {
    const v = validateGoalInput({ ...BASE, preferred_dows: [0, 1, 2, 3, 4, 5, 6] });
    assert.equal(v.sessionsPerWeek, 7);
  });

  it('长期目标不能为空 / 超长', () => {
    expect400(() => validateGoalInput({ ...BASE, goal_type: '   ' }), '不能为空');
    expect400(() => validateGoalInput({ ...BASE, goal_type: 'x'.repeat(41) }), '最多 40');
  });

  it('训练日：空数组 / 越界 / 非整数一律 400', () => {
    expect400(() => validateGoalInput({ ...BASE, preferred_dows: [] }), '至少要选一个训练日');
    expect400(() => validateGoalInput({ ...BASE, preferred_dows: [7] }), '0~6');
    expect400(() => validateGoalInput({ ...BASE, preferred_dows: [1.5] }), '0~6');
    expect400(() => validateGoalInput({ ...BASE, preferred_dows: '周一' }), '数组');
  });

  it('时长区间与一周起始日校验', () => {
    expect400(() => validateGoalInput({ ...BASE, min_duration_min: 5 }), '10~300');
    expect400(() => validateGoalInput({ ...BASE, max_duration_min: 700 }), '10~600');
    expect400(() => validateGoalInput({ ...BASE, min_duration_min: 90, max_duration_min: 60 }), '不能小于');
    expect400(() => validateGoalInput({ ...BASE, week_start_dow: 2 }), '0~1');
  });

  it('入参里带 sessions_per_week 也不会被采信（防「4 次 vs 3 天」矛盾复现）', () => {
    const v = validateGoalInput({ ...BASE, preferred_dows: [1, 3, 5], sessions_per_week: 4 });
    assert.equal(v.sessionsPerWeek, 3);
  });
});

describe('saveGoalSettings / getGoalSettings', () => {
  it('无激活行时 GET 返回 null', () => {
    assert.equal(getGoalSettings(emptyDb()), null);
  });

  it('首次保存插入一行并成为激活行', () => {
    const db = emptyDb();
    const saved = saveGoalSettings(db, { ...BASE, goal_type: '增肌' }, new Date('2026-01-05T02:00:00Z'));
    assert.equal(saved.goalType, '增肌');
    assert.equal(saved.sessionsPerWeek, 4);
    assert.equal(saved.effectiveFrom, '2026-01-05');
    assert.deepEqual(saved.preferredDows, [1, 3, 5, 0]);
    assert.equal(getGoalSettings(db)?.id, saved.id);
  });

  it('再次保存 = 新增一行 + 旧行 is_active=0；历史计划的 goal_id 不受影响', () => {
    const db = emptyDb();
    const first = saveGoalSettings(db, BASE, new Date('2026-01-05T02:00:00Z'));

    // 模拟一条已生成的历史计划指向旧目标行
    db.prepare(
      `INSERT INTO plan (week_start, week_end, version_no, status, source, goal_id, created_at, updated_at)
       VALUES ('2026-01-05', '2026-01-11', 1, 'draft', 'rule_fallback', ?, '2026-01-05T02:00:00Z', '2026-01-05T02:00:00Z')`,
    ).run(first.id);

    const second = saveGoalSettings(db, { ...BASE, goal_type: '力量提升', preferred_dows: [2, 4, 6] }, new Date('2026-02-02T02:00:00Z'));

    assert.notEqual(second.id, first.id, '改设置必须新增行（user_goal 是带 effective_from 的历史表）');
    assert.equal(second.sessionsPerWeek, 3, '一周几练随训练日数量变化');

    const rows = db.prepare(`SELECT id, is_active, goal_type FROM user_goal ORDER BY id`).all() as unknown as Array<{
      id: number;
      is_active: number;
      goal_type: string;
    }>;
    assert.equal(rows.length, 2);
    assert.equal(rows.filter((r) => Number(r.is_active) === 1).length, 1, '任何时刻只能有一行激活');
    assert.equal(getGoalSettings(db)?.goalType, '力量提升');

    // 旧行仍在、计划外键仍指向它 —— 历史语义不被改写
    const planGoal = db.prepare(`SELECT goal_id FROM plan WHERE week_start = '2026-01-05'`).get() as unknown as {
      goal_id: number;
    };
    assert.equal(Number(planGoal.goal_id), first.id);
  });

  it('saveGoalSettings 复用 validateGoalInput 的校验（非法入参不落库）', () => {
    const db = emptyDb();
    expect400(() => saveGoalSettings(db, { ...BASE, preferred_dows: [] }), '至少要选一个训练日');
    const n = db.prepare(`SELECT COUNT(*) AS n FROM user_goal`).get() as unknown as { n: number };
    assert.equal(Number(n.n), 0, '校验失败不得留下半行数据');
  });

  it('历史行的「一周几练」与训练日不符时，读取按训练日归一（CLI 种子曾写入 4 练 + 只选一/三/五）', () => {
    const db = emptyDb();
    db.exec(
      `INSERT INTO user_goal (goal_type, sessions_per_week, min_duration_min, max_duration_min, week_start_dow,
                              preferred_dows, notes, is_active, effective_from, created_at)
       VALUES ('减脂保肌', 4, 45, 90, 1, '[1,3,5]', 'CLI 种子默认目标（可在 UI 修改）', 1, '2026-09-29', '2026-09-29T00:00:00.000Z')`,
    );
    const g = getGoalSettings(db);
    assert.equal(g?.preferredDows.length, 3);
    assert.equal(g?.sessionsPerWeek, 3, '一周几练以选中的训练日为准，否则第 4 天会被排到没选的星期');
    // 只归一到读取结果，不改写库里那一行
    const raw = db.prepare(`SELECT sessions_per_week FROM user_goal WHERE is_active = 1`).get() as unknown as {
      sessions_per_week: number;
    };
    assert.equal(Number(raw.sessions_per_week), 4, '读时归一不得回写用户数据');
  });

  it('训练日为空的老数据仍按存储值返回（不因归一变成 0 练）', () => {
    const db = emptyDb();
    db.exec(
      `INSERT INTO user_goal (goal_type, sessions_per_week, min_duration_min, max_duration_min, week_start_dow,
                              preferred_dows, is_active, effective_from, created_at)
       VALUES ('减脂保肌', 3, 45, 90, 1, NULL, 1, '2026-09-29', '2026-09-29T00:00:00.000Z')`,
    );
    assert.equal(getGoalSettings(db)?.sessionsPerWeek, 3);
  });
});
