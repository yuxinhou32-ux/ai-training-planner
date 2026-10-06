/**
 * 日期工具（T1）。
 *
 * 约定（§3.1）：datestr 一律 `YYYY-MM-DD` 本地日期（字典序 = 时间序）；
 * 时间戳字段一律 epoch 毫秒。
 */

/** 校验 YYYY-MM-DD 格式与真实日期合法性。 */
export function isValidDateStr(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** Date → 本地时区 YYYY-MM-DD。 */
export function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 当前（本地时区）日期字符串。 */
export function todayStr(now: number = Date.now()): string {
  return toDateStr(new Date(now));
}

/** datestr 平移 delta 天（可为负）。 */
export function shiftDays(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  return toDateStr(dt);
}

/**
 * 构造拉取窗口：[anchor-(days-1), anchor]，升序。
 * days <= 0 时返回空数组；days=1 → 只有 anchor 当天。
 */
export function buildDateWindow(anchor: string, days: number): string[] {
  if (!isValidDateStr(anchor) || days <= 0) return [];
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    out.push(shiftDays(anchor, -i));
  }
  return out;
}

/** epoch 毫秒 → ISO-8601 UTC 秒精度文本（供 started_at/ended_at 等列使用）。 */
export function msToIsoUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** datestr 的星期几（0=周日）。按 UTC 解析 —— 与 planService / cycleService 的 dowOf 同一口径。 */
export function dowOfDateStr(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}

/**
 * 目标周内与给定星期几相同的那个日期（模板平移到本周时用）。
 * 理论上必定能命中（7 天窗口覆盖全部 dow）；命中不了时退回周起点 ——
 * 调用方会因此拿到重复日期并走纠错重试，而不是静默产出一个错日期。
 */
export function datestrForDow(weekStart: string, dow: number): string {
  for (let off = 0; off < 7; off++) {
    const ds = shiftDays(weekStart, off);
    if (dowOfDateStr(ds) === dow) return ds;
  }
  return weekStart;
}
