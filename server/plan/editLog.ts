/**
 * 计划修改历史（M23，plan_edit_log）。
 * actor：user=手动编辑 | ai=对话式调整 | system=生成/降级/熔断审计。
 */
import { prepare, type Db } from '../db/index.js';

export interface EditLogEntry {
  plan_id: number;
  actor: 'user' | 'ai' | 'system';
  action: 'create' | 'update' | 'delete' | 'reorder' | 'adjust' | 'regenerate';
  target_type: 'plan' | 'day' | 'exercise';
  target_id?: number | null;
  field?: string | null;
  before?: unknown;
  after?: unknown;
  instruction?: string | null;
}

export function logEdit(db: Db, e: EditLogEntry): void {
  prepare(
    db,
    `INSERT INTO plan_edit_log (plan_id, actor, action, target_type, target_id, field, before_json, after_json, instruction, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    e.plan_id,
    e.actor,
    e.action,
    e.target_type,
    e.target_id ?? null,
    e.field ?? null,
    e.before === undefined ? null : JSON.stringify(e.before),
    e.after === undefined ? null : JSON.stringify(e.after),
    e.instruction ?? null,
    new Date().toISOString(),
  );
}
