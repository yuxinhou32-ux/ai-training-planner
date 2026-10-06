/**
 * 报告清理（2026-10 用户定案的保留策略）。
 *
 * | 类型       | 含义                         | 保留策略        |
 * |-----------|------------------------------|----------------|
 * | snapshot  | 周期末产出，用户可见            | 保留 3 年       |
 * | adhoc     | 同步/手动刷新产生的过程产物，无人看 | 只留最近 3 份    |
 *
 * ⚠️ 删报告的连带效应（可接受，故不做额外处理）：
 *  - `analysis_finding.report_id` 是 `ON DELETE CASCADE` → findings 随报告自动删除，无需手动清；
 *  - `plan.report_id` 是 `ON DELETE SET NULL` → 被删报告若被某份计划引用，该计划的
 *    `report_id` 会被置空（计划本身照常可用，只失去「基于哪份画像排的」这条溯源）。
 *    这正是取舍：adhoc 过程产物无人看、snapshot 超 3 年也不再作为依据。
 */
import type { Db } from '../db/index.js';
import { prepare } from '../db/index.js';

/** adhoc 保留份数（最近的这几份）。 */
const ADHOC_KEEP = 3;
/** snapshot 保留年限。 */
const SNAPSHOT_KEEP_YEARS = 3;

export function pruneReports(
  db: Db,
  opts: { nowMs?: number } = {},
): { adhocDeleted: number; snapshotDeleted: number } {
  // adhoc：不在「最近 N 条」里就删。取序与列表口径一致（generated_at DESC, id DESC）——
  // id 兜底保证同一毫秒内生成的多份也有确定的顺序。
  const adhoc = prepare(
    db,
    `DELETE FROM analysis_report
     WHERE kind = 'adhoc'
       AND id NOT IN (
         SELECT id FROM analysis_report WHERE kind = 'adhoc'
         ORDER BY generated_at DESC, id DESC LIMIT ?
       )`,
  ).run(ADHOC_KEEP);

  // snapshot：早于「三年零点」即删。生成的 ISO 串与 generated_at 同格式（UTC、毫秒），
  // 字典序 = 时间序，故可直接比较。
  const now = new Date(opts.nowMs ?? Date.now());
  const cutoff = new Date(
    Date.UTC(now.getUTCFullYear() - SNAPSHOT_KEEP_YEARS, now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  ).toISOString();
  const snapshot = prepare(
    db,
    `DELETE FROM analysis_report WHERE kind = 'snapshot' AND generated_at < ?`,
  ).run(cutoff);

  return { adhocDeleted: Number(adhoc.changes), snapshotDeleted: Number(snapshot.changes) };
}
