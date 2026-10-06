/**
 * 计划周特殊情况（`week_note`）—— 排计划时**优先级最高**的输入。
 *
 * 🔴 与 `daily_note`（日感受）的分工，2026-09-30 用户口述定案：
 *   - **`week_note`（本模块）= 排计划用**。「这周来经期，给我减量」这类**事前**信息。
 *     它是摘要层的 `week.special_note`，优先级 **高于周期目标**
 *     （用户原话：「我这周来了经期，所以你要先考虑我在经期内，然后再考虑我这周练胸」）。
 *   - **`daily_note` = 复盘用**。「今天练完肩有点紧、卧推没做满」这类**事后**感受，
 *     只喂周复盘 AI（`weeklyReview.ts`），**不直接进排计划输入**。
 *     它的东西经复盘建议（`week.last_review`）绕一圈才回到排计划 —— 用户的要求：
 *     「它就是用来复盘的，只关乎下一周的计划，跟这一周的计划没关系」。
 *
 * 按 `week_start` 存（不是按日期）：一条记录 = 一个计划周的一句话，
 * 新的一周就是新的一条，旧的不删（回看/复现历史生成时还用得上）。
 *
 * 空文本 = 删行：与 `daily_note` 同一约定 —— 「空字符串」与「没写过」在展示上必须完全一样，
 * 否则前端要区分两种空态。
 */
import type { Db } from '../db/index.js';
import { prepare } from '../db/index.js';
import { isoSeconds } from '../util/clock.js';

export class WeekNoteError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** 上限 500 字：摘要层有硬预算（payload ≤ 15 KB），不能因为用户写得多就把 payload 撑爆。 */
export const WEEK_NOTE_MAX_CHARS = 500;

/** 某个计划周的特殊情况；没写过 → null。 */
export function loadWeekNote(db: Db, weekStart: string): string | null {
  const r = prepare(db, `SELECT text FROM week_note WHERE week_start = ?`).get(weekStart) as unknown as
    | { text: string }
    | undefined;
  return r ? r.text : null;
}

/** 写/改/清空某个计划周的特殊情况。去空白后为空 → 删行。 */
export function saveWeekNote(
  db: Db,
  weekStart: string,
  text: string,
  nowMs: number,
): { week_start: string; text: string | null } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) throw new WeekNoteError(400, 'week_start 需为 YYYY-MM-DD');
  const trimmed = text.trim();
  if (trimmed === '') {
    prepare(db, `DELETE FROM week_note WHERE week_start = ?`).run(weekStart);
    return { week_start: weekStart, text: null };
  }
  if (trimmed.length > WEEK_NOTE_MAX_CHARS) {
    throw new WeekNoteError(400, `特殊情况太长了（上限 ${WEEK_NOTE_MAX_CHARS} 字）`);
  }
  const now = isoSeconds(nowMs);
  prepare(
    db,
    `INSERT INTO week_note (week_start, text, created_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(week_start) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`,
  ).run(weekStart, trimmed, now, now);
  return { week_start: weekStart, text: trimmed };
}

/**
 * 摘要层用：把一段用户原话压成一行（换行折成空格），并做长度兜底。
 * DB 层已限制 500 字，这里是防旧数据/直接改库的二次保险。
 */
export function weekNoteForDigest(raw: string | null, maxChars = WEEK_NOTE_MAX_CHARS): string | null {
  if (raw === null) return null;
  const flat = raw.replace(/\s+/g, ' ').trim();
  if (flat === '') return null;
  return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat;
}
