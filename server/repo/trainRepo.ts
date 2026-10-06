import { isoSeconds } from '../util/clock.js';
import type { Db } from '../db/index.js';
import { prepare, toDb } from '../db/index.js';
import { flattenSets } from '../ingest/parser.js';
import type { ParsedDay, ParsedSessionRow, ParsedSetRow } from '../ingest/parser.js';

/**
 * train_session / session_movement / movement_set 仓库（T1）。
 *
 * 幂等策略（§3.1 + §6.2.3）：
 *  - train_session 按 UNIQUE(datestr, localid) upsert；
 *  - 重写某条训练时，先 DELETE 该训练的全部 session_movement（movement_set 级联删除，
 *    foreign_keys=ON），再整批重插 —— 保证「重复同步不产生重复记录」；
 *  - 由调用方（SyncEngine）包在单天事务里，中断不留半截。
 */
export class TrainRepo {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  private sessionUpsertStmt() {
    return prepare(
      this.db,
      `INSERT INTO train_session
         (datestr, localid, title, title_source, note, start_ms, end_ms, started_at, ended_at,
          server_truncated, duration_min, duration_src, is_outlier, outlier_reason,
          is_cardio, is_rest, session_type, content_hash, raw_id, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(datestr, localid) DO UPDATE SET
         title = excluded.title,
         title_source = excluded.title_source,
         note = excluded.note,
         start_ms = excluded.start_ms,
         end_ms = excluded.end_ms,
         started_at = excluded.started_at,
         ended_at = excluded.ended_at,
         server_truncated = excluded.server_truncated,
         duration_min = excluded.duration_min,
         duration_src = excluded.duration_src,
         is_outlier = excluded.is_outlier,
         outlier_reason = excluded.outlier_reason,
         is_cardio = excluded.is_cardio,
         is_rest = excluded.is_rest,
         session_type = excluded.session_type,
         content_hash = excluded.content_hash,
         raw_id = excluded.raw_id,
         synced_at = excluded.synced_at`,
    );
  }

  private sessionIdOf(datestr: string, localid: string): number {
    const row = prepare(this.db, 'SELECT id FROM train_session WHERE datestr = ? AND localid = ?').get(
      datestr,
      localid,
    ) as { id: number } | undefined;
    if (!row) throw new Error(`train_session upsert 后未找到行：${datestr}/${localid}`);
    return Number(row.id);
  }

  private movementInsertStmt() {
    return prepare(
      this.db,
      `INSERT INTO session_movement
         (session_id, ord, server_index, name_raw, name_norm, catalog_id, resolve_status,
          server_type, exetype, single_side, rest_time_s, warn_rest_time,
          is_cardio, is_stretch, record_preset, metrics_json, items_json, notes, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, 'unresolved', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    );
  }

  private setInsertStmt() {
    return prepare(
      this.db,
      `INSERT INTO movement_set
         (session_movement_id, server_index, ord, parent_set_id, done, set_type, is_warmup, warmup_source,
          weight_kg, weight_unit, reps, rpe, duration_s, time_s, time_label, left_weight_kg, is_self_weight,
          distance_m, kcal, avg_heart_rate, max_heart_rate, side, note, comment, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    );
  }

  private insertSet(sessionMovementId: number, s: ParsedSetRow, ord: number, parentId: number | null): number {
    const r = this.setInsertStmt().run(
      sessionMovementId,
      toDb(s.serverIndex),
      ord,
      toDb(parentId),
      s.done,
      toDb(s.setType),
      s.isWarmup,
      toDb(s.warmupSource),
      toDb(s.weightKg),
      toDb(s.weightUnit),
      toDb(s.reps),
      toDb(s.rpe),
      toDb(s.timeS),
      toDb(s.timeLabel),
      toDb(s.leftWeightKg),
      toDb(s.isSelfWeight),
      toDb(s.distanceM),
      toDb(s.kcal),
      toDb(s.avgHeartRate),
      toDb(s.side),
      toDb(s.note),
      toDb(s.comment),
      toDb(s.rawJson),
    );
    return Number(r.lastInsertRowid);
  }

  /** 写入/重写单条训练的 movements + sets（调用方负责事务）。返回 (movements, sets) 行数。 */
  private replaceMovements(sessionId: number, session: ParsedSessionRow, syncedAtMs: number): {
    movements: number;
    sets: number;
  } {
    prepare(this.db, 'DELETE FROM session_movement WHERE session_id = ?').run(sessionId);

    const insertMovement = this.movementInsertStmt();
    let movementCount = 0;
    let setCount = 0;
    const createdAt = isoSeconds(syncedAtMs);

    for (const m of session.movements) {
      const r = insertMovement.run(
        sessionId,
        m.ord,
        toDb(m.serverIndex),
        m.nameRaw,
        m.nameNorm,
        toDb(m.serverType),
        toDb(m.exetype),
        toDb(m.singleSide),
        toDb(m.restTimeS),
        toDb(m.warnRestTime),
        m.isCardio,
        m.isStretch,
        toDb(m.metricsJson),
        toDb(m.itemsJson),
        toDb(m.notes),
        createdAt,
      );
      movementCount += 1;
      const movementId = Number(r.lastInsertRowid);

      // 超级组父子：父行先插，子行挂 parent_set_id；ord 全局递增保证唯一
      let ord = 1;
      const stack: Array<{ row: ParsedSetRow; parent: number | null }> = m.sets
        .slice()
        .reverse()
        .map((row) => ({ row, parent: null as number | null }));
      while (stack.length > 0) {
        const { row, parent } = stack.pop() as { row: ParsedSetRow; parent: number | null };
        const setId = this.insertSet(movementId, row, ord, parent);
        setCount += 1;
        ord += 1;
        for (const child of row.children.slice().reverse()) {
          stack.push({ row: child, parent: setId });
        }
      }
    }
    return { movements: movementCount, sets: setCount };
  }

  /**
   * 幂等写入一整天（调用方负责事务与 raw 层）。
   * 结构化重写策略：先删该训练的 movements（sets 级联），再重插。
   */
  upsertDay(
    parsed: ParsedDay,
    opts: { rawId: number | null; syncedAtMs: number },
  ): { sessions: number; movements: number; sets: number } {
    const upsertSession = this.sessionUpsertStmt();
    let movementTotal = 0;
    let setTotal = 0;

    for (const session of parsed.sessions) {
      upsertSession.run(
        session.datestr,
        session.localid,
        toDb(session.title),
        toDb(session.titleSource),
        toDb(session.note),
        toDb(session.startMs),
        toDb(session.endMs),
        toDb(session.startedAt),
        toDb(session.endedAt),
        toDb(session.serverTruncated),
        toDb(session.durationMin),
        toDb(session.durationSrc),
        session.isOutlier,
        toDb(session.outlierReason),
        session.isCardio,
        session.isRest,
        toDb(session.sessionType),
        session.contentHash,
        toDb(opts.rawId),
        isoSeconds(opts.syncedAtMs),
      );
      const sessionId = this.sessionIdOf(session.datestr, session.localid);
      const { movements, sets } = this.replaceMovements(sessionId, session, opts.syncedAtMs);
      movementTotal += movements;
      setTotal += sets;
    }

    return { sessions: parsed.sessions.length, movements: movementTotal, sets: setTotal };
  }

  /* ---------------- 查询（reconcile / 测试用） ---------------- */

  counts(): { sessions: number; movements: number; sets: number } {
    const s = prepare(this.db, 'SELECT COUNT(*) AS c FROM train_session').get() as { c: number };
    const m = prepare(this.db, 'SELECT COUNT(*) AS c FROM session_movement').get() as { c: number };
    const t = prepare(this.db, 'SELECT COUNT(*) AS c FROM movement_set').get() as { c: number };
    return { sessions: Number(s.c), movements: Number(m.c), sets: Number(t.c) };
  }

  countsByDate(datestr: string): { sessions: number; movements: number; sets: number } {
    const s = prepare(this.db, 'SELECT COUNT(*) AS c FROM train_session WHERE datestr = ?').get(datestr) as {
      c: number;
    };
    const m = prepare(
      this.db,
      `SELECT COUNT(*) AS c FROM session_movement sm
       JOIN train_session ts ON ts.id = sm.session_id WHERE ts.datestr = ?`,
    ).get(datestr) as { c: number };
    const t = prepare(
      this.db,
      `SELECT COUNT(*) AS c FROM movement_set ms
       JOIN session_movement sm ON sm.id = ms.session_movement_id
       JOIN train_session ts ON ts.id = sm.session_id WHERE ts.datestr = ?`,
    ).get(datestr) as { c: number };
    return { sessions: Number(s.c), movements: Number(m.c), sets: Number(t.c) };
  }
}

/**
 * 有没有可分析的训练数据（≥1 个已同步日期）。
 * 中立位置：jobs/handlers.ts（同步、刷新分析）与 plan/planService.ts（排计划）都要用，
 * 放在训练数据仓库避免任何一侧反向依赖。
 */
export function hasTrainingData(db: Db): boolean {
  const row = prepare(db, 'SELECT COUNT(DISTINCT datestr) AS c FROM train_session').get() as { c: number };
  return Number(row.c) > 0;
}
