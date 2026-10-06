/**
 * 日感受（`daily_note`，PRD-v2 §10.3 V8）。
 *
 * 用户自己写的主观感受，只存在本地库，**不同步回训记**（§6 决策 1）。
 *
 * ⚠️ 与 `train_session.note` 是两回事：后者实测 91% 有值，但内容是 `calorie:284`
 * 这类**训记自动写入的卡路里**，不是人的感受。旧版把它当主观信号喂 AI，属数据误用
 * （PRD-v2 砍除清单 C11）。
 *
 * 🔴 2026-09-30 用户定案的分工 —— 这里是**复盘**用的，**不**进排计划输入：
 *   用户原话「它就是用来复盘的，它只关乎下一周的计划，跟这一周的计划是没有关系的」，
 *   例子是「练完之后感觉怎么样、下周可不可以加量、哪个动作没做到位」。
 *   - 去向：`weeklyReview.ts` → 周复盘 AI → 复盘建议（`week.last_review`）
 *     → **绕一圈**才回到下周计划。
 *   - **排计划**要的「计划周特殊情况」（经期 → 减量）是另一张表 `week_note`
 *     （`server/week/weekNoteService.ts`，用户事前在首页填，优先级最高）。
 *   —— 所以这里**没有**「压成一行喂摘要层」的函数了：曾经有过
 *   （`recentNotes` / `notesToSpecialNote` 冒充 `week.special_note`），是错误的用法，已删。
 */
import type { Db } from '../db/index.js';
import { prepare } from '../db/index.js';
import { isoSeconds } from '../util/clock.js';

export class DailyNoteError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const MAX_CHARS = 1000;

export function loadDailyNotes(db: Db, from: string, to: string): Map<string, string> {
  const rows = prepare(db, `SELECT datestr, text FROM daily_note WHERE datestr BETWEEN ? AND ?`).all(from, to) as unknown as Array<{
    datestr: string;
    text: string;
  }>;
  return new Map(rows.map((r) => [r.datestr, r.text]));
}

/**
 * 写/改/清空某天的感受。
 * **text 去空白后为空 → 删行**：留着空行会让「今天写过没有」变成状态判断，
 * 而「空字符串」与「没写过」在展示上应当完全一样。
 */
export function saveDailyNote(db: Db, datestr: string, text: string, nowMs: number): { datestr: string; text: string | null } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datestr)) throw new DailyNoteError(400, 'datestr 需为 YYYY-MM-DD');
  const trimmed = text.trim();
  if (trimmed === '') {
    prepare(db, `DELETE FROM daily_note WHERE datestr = ?`).run(datestr);
    return { datestr, text: null };
  }
  if (trimmed.length > MAX_CHARS) throw new DailyNoteError(400, `感受太长了（上限 ${MAX_CHARS} 字）`);
  const now = isoSeconds(nowMs);
  prepare(
    db,
    `INSERT INTO daily_note (datestr, text, created_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(datestr) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`,
  ).run(datestr, trimmed, now, now);
  return { datestr, text: trimmed };
}
