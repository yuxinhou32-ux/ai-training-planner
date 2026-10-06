/**
 * 计划重置（`resetService`）测试 —— 2026-10-05 用户定案。
 *
 * 用户原话：「我觉得可以添加一个清空功能……就是清空这个项目里的所有关于本次生成的计划的内容——
 * 周期我没改的话可以不用清空，但如果我选择解锁清空需要保证真的清空，**不要出现两条周期目标在后台**」。
 *
 * 本文件守两条线：
 *   ① **删干净**：plan 及级联（day/exercise/edit_log/写回链路）+ weekly_review 一行不留；
 *   ② **不越界**：训练数据、长期目标、用户自己写的备注（daily_note / week_note / weight_log）
 *      一个字节都不能动 —— 删错这些是不可逆的数据损失。
 *
 * 另外专门盯住用户的踩坑点：清周期时旧 `training_cycle` 必须**整行删掉**（不是 close），
 * 否则 `UNIQUE(first_week_start)` 会让下一次开周期撞约束 —— 就是「两条周期目标在后台」。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { previewReset, resetPlans } from '../server/plan/resetService.js';
import { openCycle } from '../server/cycle/cycleService.js';
import { makeTempDb } from './fixtures.js';
import type { Db } from '../server/db/index.js';

/** 一个有「计划 + 周期 + 训练数据 + 用户自写内容」的库。 */
function seededDb(): Db {
  const { db } = makeTempDb();

  db.prepare(
    `INSERT INTO user_goal (goal_type, sessions_per_week, min_duration_min, max_duration_min, week_start_dow, preferred_dows, is_active, effective_from, created_at)
     VALUES ('减脂保肌', 2, 60, 90, 1, '[1,3]', 1, '2026-01-01', '2026-01-01T00:00:00Z')`,
  ).run();

  // ---- 训练数据（必须活着）----
  db.prepare(
    `INSERT INTO train_session (datestr, localid, session_type, is_cardio, is_rest, content_hash, synced_at)
     VALUES ('2026-01-05', 'L1', 'strength', 0, 0, 'h1', 'now')`,
  ).run();
  const sid = Number((db.prepare(`SELECT last_insert_rowid() AS id`).get() as unknown as { id: number }).id);

  // ---- 用户自写内容（必须活着）----
  db.prepare(`INSERT INTO daily_note (datestr, text, created_at, updated_at) VALUES ('2026-01-05', '今天有点累', 'now', 'now')`).run();
  db.prepare(`INSERT INTO week_note (week_start, text, created_at, updated_at) VALUES ('2026-01-05', '在经期，减量', 'now', 'now')`).run();
  db.prepare(`INSERT INTO weight_log (datestr, weight_kg, created_at, updated_at) VALUES ('2026-01-05', 58.4, 'now', 'now')`).run();

  // ---- 计划（必须被删）----
  db.prepare(
    `INSERT INTO plan (week_start, week_end, version_no, status, source, ai_model_tag, summary_json, warnings_json, ai_attempts, created_at, updated_at)
     VALUES ('2026-01-05', '2026-01-11', 1, 'draft', 'rule_fallback', 'rule_fallback', '{}', '[]', 0, 'now', 'now')`,
  ).run();
  const planId = Number((db.prepare(`SELECT last_insert_rowid() AS id`).get() as unknown as { id: number }).id);
  db.prepare(
    `INSERT INTO plan_day (plan_id, datestr, dow, ord, title, lock_state) VALUES (?, '2026-01-05', 1, 1, '推日', 'planned')`,
  ).run(planId);
  const dayId = Number((db.prepare(`SELECT last_insert_rowid() AS id`).get() as unknown as { id: number }).id);
  db.prepare(
    `INSERT INTO plan_exercise (plan_day_id, ord, name, sets, reps, is_cardio, source) VALUES (?, 1, '杠铃卧推', 4, 8, 0, 'ai')`,
  ).run(dayId);
  db.prepare(
    `INSERT INTO plan_edit_log (plan_id, actor, action, target_type, created_at) VALUES (?, 'system', 'create', 'plan', 'now')`,
  ).run(planId);

  // ---- 写回链路（必须被删）----
  db.prepare(
    `INSERT INTO sync_write_job (plan_id, status, total_batches, finished_batches, created_at) VALUES (?, 'pending', 1, 0, 'now')`,
  ).run(planId);
  const jobId = Number((db.prepare(`SELECT last_insert_rowid() AS id`).get() as unknown as { id: number }).id);
  db.prepare(
    `INSERT INTO write_batch (job_id, batch_no, datestr, client_request_id, status, train_count, request_json, created_at)
     VALUES (?, 1, '2026-01-05', 'REQ-1', 'pending', 1, '{}', 'now')`,
  ).run(jobId);
  const batchId = Number((db.prepare(`SELECT last_insert_rowid() AS id`).get() as unknown as { id: number }).id);
  db.prepare(
    `INSERT INTO write_item (batch_id, plan_day_id, ord, action, created_at) VALUES (?, ?, 1, 'create', 'now')`,
  ).run(batchId, dayId);

  // ---- 周复盘（必须被删）----
  db.prepare(
    `INSERT INTO weekly_review (week_start, week_end, data_summary_json, status, generated_at)
     VALUES ('2026-01-05', '2026-01-11', '{}', 'done', 'now')`,
  ).run();

  // ---- 周期（可选删除）----
  openCycle(db, { goal_text: '着重练胸', first_week_start: '2026-01-05' });

  return db;
}

function n(db: Db, sql: string): number {
  return Number((db.prepare(sql).get() as unknown as { n: number }).n);
}

const PLAN_TABLES = {
  plan: `SELECT COUNT(*) AS n FROM plan`,
  plan_day: `SELECT COUNT(*) AS n FROM plan_day`,
  plan_exercise: `SELECT COUNT(*) AS n FROM plan_exercise`,
  plan_edit_log: `SELECT COUNT(*) AS n FROM plan_edit_log`,
  sync_write_job: `SELECT COUNT(*) AS n FROM sync_write_job`,
  write_batch: `SELECT COUNT(*) AS n FROM write_batch`,
  write_item: `SELECT COUNT(*) AS n FROM write_item`,
  weekly_review: `SELECT COUNT(*) AS n FROM weekly_review`,
};

const PROTECTED_TABLES = {
  train_session: `SELECT COUNT(*) AS n FROM train_session`,
  user_goal: `SELECT COUNT(*) AS n FROM user_goal`,
  daily_note: `SELECT COUNT(*) AS n FROM daily_note`,
  week_note: `SELECT COUNT(*) AS n FROM week_note`,
  weight_log: `SELECT COUNT(*) AS n FROM weight_log`,
};

describe('plan/resetService：清空本次生成的计划', () => {
  it('默认（不清周期）：计划链路 + 周复盘全清空，周期与训练数据原样保留', () => {
    const db = seededDb();
    const before = Object.fromEntries(Object.entries(PROTECTED_TABLES).map(([k, sql]) => [k, n(db, sql)]));
    assert.ok(Object.values(before).every((v) => v > 0), '前置：受保护的表都该有数据');

    const r = resetPlans(db, { clearCycle: false });

    // ① 删干净
    for (const [name, sql] of Object.entries(PLAN_TABLES)) {
      assert.equal(n(db, sql), 0, `${name} 应被清空`);
    }
    assert.equal(r.plans, 1);
    assert.equal(r.plan_days, 1);
    assert.equal(r.plan_exercises, 1);
    assert.equal(r.write_jobs, 1);
    assert.equal(r.weekly_reviews, 1);
    assert.equal(r.cleared_cycle, false);

    // ② 不越界（逐个表核对行数，不是只看「>0」）
    for (const [name, sql] of Object.entries(PROTECTED_TABLES)) {
      assert.equal(n(db, sql), before[name], `${name} 不该被动到`);
    }
    // ③ 周期也留着
    assert.equal(n(db, `SELECT COUNT(*) AS n FROM training_cycle`), 1, '没勾选就不该清周期');
  });

  it('勾选清周期：training_cycle 整表删掉（不是 close），之后能重新开周期', () => {
    const db = seededDb();
    const r = resetPlans(db, { clearCycle: true });
    assert.equal(r.cleared_cycle, true);
    assert.equal(r.cycles, 1);
    assert.equal(n(db, `SELECT COUNT(*) AS n FROM training_cycle`), 0);

    // 🔴 用户的踩坑点：旧周期没删干净会让下一次开周期撞 UNIQUE(first_week_start)
    //    或者让 getActiveCycle 拿到旧那条 —— 表现就是「两条周期目标在后台」。
    //    同一个 first_week_start 能重新开出来，就证明真的删干净了。
    assert.doesNotThrow(() => {
      openCycle(db, { goal_text: '新目标', first_week_start: '2026-01-05' });
    }, '清周期后必须能用同一个起点重新开周期（否则就是留了残行）');
    assert.equal(n(db, `SELECT COUNT(*) AS n FROM training_cycle`), 1);
  });

  it('没有计划时重置是幂等的（不报错、行数为 0）', () => {
    const db = seededDb();
    resetPlans(db, { clearCycle: false });
    const again = resetPlans(db, { clearCycle: false });
    assert.equal(again.plans, 0);
    assert.equal(again.plan_days, 0);
    assert.equal(again.weekly_reviews, 0);
    assert.equal(n(db, `SELECT COUNT(*) AS n FROM user_goal`), 1, '重复清空也不该动受保护的表');
  });

  it('previewReset：同时报「会删什么」与「不会删什么」', () => {
    const db = seededDb();
    const p = previewReset(db);
    assert.equal(p.plans, 1);
    assert.equal(p.weekly_reviews, 1);
    assert.equal(p.cycles, 1);
    assert.equal(p.protected.training_sessions, 1);
    assert.equal(p.protected.active_goals, 1);
    assert.equal(p.protected.daily_notes, 1);
    assert.equal(p.protected.week_notes, 1);
    assert.equal(p.protected.weight_logs, 1);
  });

  it('清空后 preview 归零，但受保护计数不变', () => {
    const db = seededDb();
    resetPlans(db, { clearCycle: true });
    const after = previewReset(db);
    assert.equal(after.plans, 0);
    assert.equal(after.weekly_reviews, 0);
    assert.equal(after.cycles, 0);
    assert.equal(after.protected.training_sessions, 1);
    assert.equal(after.protected.active_goals, 1);
  });
});
