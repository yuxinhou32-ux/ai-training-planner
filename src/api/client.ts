/**
 * API 客户端 + TanStack Query hooks（§2.3 src/api/client.ts）。
 *
 * 服务端状态 100% 由 TanStack Query 管理（§8.4）：staleTime 30s；
 * 本地状态只保留 Tab/展开/表单临时值。
 */
import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { AnalysisReport } from '../../server/analysis/reportSchema.js';

export interface LatestResponse {
  exists: boolean;
  reportId?: number;
  report?: AnalysisReport;
  generatedAt?: string;
  /** 该报告所属的画像版本号；`null` = 不是快照（过程产物 / 无快照时的回退报告）。 */
  version_no: number | null;
}

export interface MappingMuscle {
  code: string;
  name: string | null;
  role: string;
  weight: number;
  source: string;
  confidence: string;
  confirmed: boolean;
}

export interface MappingMovement {
  catalogId: number;
  name: string;
  muscles: MappingMuscle[];
}

export interface UnresolvedItem {
  nameRaw: string;
  nameNorm: string;
  hitCount: number;
  firstSeen: string;
  lastSeen: string;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} 失败：${res.status}`);
  return (await res.json()) as T;
}

/**
 * 取画像。不传 `versionNo` = 最新快照（一份快照都没有时服务端回退最新报告）；
 * 传 `versionNo` = 指定版本快照，不存在则服务端回 `{ exists: false }`。
 */
export async function fetchLatestAnalysis(versionNo?: number): Promise<LatestResponse> {
  const qs = versionNo === undefined ? '' : `?version_no=${versionNo}`;
  return getJson<LatestResponse>(`/api/analysis/latest${qs}`);
}

export async function refreshAnalysis(): Promise<LatestResponse> {
  const res = await fetch('/api/analysis/refresh', { method: 'POST' });
  if (!res.ok) throw new Error(`重新分析失败：${res.status}`);
  return (await res.json()) as LatestResponse;
}

export async function fetchMappings(): Promise<{ movements: MappingMovement[] }> {
  return getJson<{ movements: MappingMovement[] }>('/api/catalog/mappings');
}

export async function fetchUnresolved(): Promise<{ unresolved: UnresolvedItem[] }> {
  return getJson<{ unresolved: UnresolvedItem[] }>('/api/catalog/unresolved');
}

export const qk = {
  analysis: ['analysis', 'latest'] as const,
  mappings: ['catalog', 'mappings'] as const,
  unresolved: ['catalog', 'unresolved'] as const,
  plan: ['plan', 'current'] as const,
  goal: ['goal'] as const,
  cycle: ['cycle'] as const,
};

// ---------------------------------------------------------------------------
// 计划（T3）
// ---------------------------------------------------------------------------

export interface PlanExercise {
  id: number;
  ord: number;
  catalog_id: number | null;
  name: string;
  sets: number;
  reps: number | null;
  weight_kg: number | null;
  weight_source: string | null;
  rest_s: number | null;
  is_cardio: boolean;
  why: string;
  source: string;
}

export interface PlanDay {
  id: number;
  datestr: string;
  dow: number;
  ord: number;
  day_type: string | null;
  title: string;
  target_muscles: string[];
  est_duration_min: number | null;
  why: { summary: string; evidence_refs: Array<{ type: string; ref: string; text: string }> } | null;
  exercises: PlanExercise[];
}

export interface PlanSummary {
  total_sessions: number;
  total_sets: number;
  est_total_min: number;
  muscle_distribution: Record<string, number>;
}

export interface PlanDetail {
  plan: {
    id: number;
    week_start: string;
    week_end: string;
    version_no: number;
    status: string;
    source: string;
    ai_model_tag: string | null;
    ai_attempts: number;
    warnings: Array<Record<string, unknown>>;
    summary: PlanSummary | null;
    report_id: number | null;
    /** 周期模板来源周次（1~4）；null = 全量生成。 */
    template_week_no: number | null;
    created_at: string;
    updated_at: string;
  };
  days: PlanDay[];
}

export interface GenerateResult {
  plan_id: number;
  /** 本次是否沿用了周期上一周的模板。 */
  used_template: boolean;
  template_week_no: number | null;
  generation:
    | { status: 'accepted'; attempts: number; warnings: Array<Record<string, unknown>>; clamped: string[] }
    | { status: 'rule_fallback'; reason: string; attempts: number }
    | { status: 'rule_fallback'; reason: 'manual'; attempts?: number };
  detail: PlanDetail;
}

async function sendJson<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      const err = (await res.json()) as { error?: string };
      if (err.error) msg = err.error;
    } catch {
      // 保持状态码
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export async function fetchCurrentPlan(): Promise<PlanDetail> {
  return getJson<PlanDetail>('/api/plans/current');
}

/**
 * 生成计划。`mode='auto'`（默认）在周期第 2~4 周会沿用上一周模板；`'full'` 强制重新全量生成。
 */
export function generatePlan(weekStart?: string, mode?: 'auto' | 'full'): Promise<GenerateResult> {
  return sendJson<GenerateResult>('/api/plans/generate', 'POST', {
    ...(weekStart ? { week_start: weekStart } : {}),
    ...(mode ? { mode } : {}),
  });
}

export function regenerateTemplate(weekStart?: string): Promise<GenerateResult> {
  return sendJson<GenerateResult>('/api/plans/regenerate-template', 'POST', weekStart ? { week_start: weekStart } : {});
}

export function updateExercise(planId: number, exerciseId: number, patch: Record<string, unknown>): Promise<PlanDetail> {
  return sendJson<PlanDetail>(`/api/plans/${planId}/exercises/${exerciseId}`, 'PATCH', patch);
}

export function deleteExercise(planId: number, exerciseId: number): Promise<PlanDetail> {
  return sendJson<PlanDetail>(`/api/plans/${planId}/exercises/${exerciseId}`, 'DELETE');
}

/**
 * 把整个训练日挪到另一天（V7）。目标日已有训练日时服务端会「交换」两个训练日。
 * 返回最新详情（含重排后的 ord / 重算的 summary）。
 */
export function movePlanDay(planId: number, dayId: number, datestr: string): Promise<PlanDetail> {
  return sendJson<PlanDetail>(`/api/plans/${planId}/days/${dayId}/move`, 'POST', { datestr });
}

// ---------------------------------------------------------------------------
// 写回（T4）：approve → preview(dry_run) → confirm(confirmed=true) 双栏杆
// ---------------------------------------------------------------------------

export interface WriteDayPreview {
  plan_day_id: number;
  datestr: string;
  title: string;
  action: 'create' | 'skip_existing';
  moves: number;
  sets: number;
  existing_localid: string | null;
}

export interface WriteBatchOutcome {
  batch_no: number;
  datestr: string;
  title: string;
  client_request_id: string;
  status: string;
  error: string | null;
  localid_after: string | null;
}

export interface WriteJobSummary {
  job_id: number | null;
  plan_id: number;
  status: string;
  total_batches: number;
  finished_batches: number;
  window: { start: string; end: string } | null;
  days: WriteDayPreview[];
  batches: WriteBatchOutcome[];
}

export function approvePlan(planId: number): Promise<{ planId: number; status: string }> {
  return sendJson<{ planId: number; status: string }>(`/api/plans/${planId}/approve`, 'POST', {});
}

/** 预演纯本地（零网络请求），即时返回作业摘要；返回后由 useWriteJob 读取批次清单。 */
export function writePreview(planId: number): Promise<WriteJobSummary> {
  return sendJson<WriteJobSummary>(`/api/plans/${planId}/write/preview`, 'POST', {});
}

/** confirm 的同步受理回执（异步作业）：批次在后台跑，终态由 useWriteJob 轮询得到。 */
export interface WriteConfirmAccepted {
  job_id: number;
  plan_id: number;
  total_batches: number;
  backup_path: string | null;
  plan_status: string;
}

export function writeConfirm(planId: number): Promise<WriteConfirmAccepted> {
  return sendJson<WriteConfirmAccepted>(`/api/plans/${planId}/write/confirm`, 'POST', { confirmed: true });
}

export function fetchWriteJob(planId: number): Promise<WriteJobSummary> {
  return getJson<WriteJobSummary>(`/api/plans/${planId}/write/job`);
}

/**
 * 🔴 为什么这三处要包一层 `withReset`：
 *
 * TanStack Query v5.104 的 `useMutation(options)` 里，`onSuccess` 的签名是
 *   (data, variables, onMutateResult, context: MutationFunctionContext)
 * —— **拿不到 Mutation 实例**，所以配置里没法调 `mutation.reset()`。
 *
 * 而 `mutation.error` 在成功后**不会自动清空**，也不随 query 刷新而清。不处理的话：
 * 上一次批准失败留下红字 → 这次成功 → 第一道栏杆（draft 分支）已收起 →
 * 页面上只剩一行「计划当前状态为 X，只有草稿可以批准」，看起来像自相矛盾。
 *
 * 修法：先用 `useMutation` 拿到返回的 mutation 对象，再用 `useEffect` 在它成功时
 * `reset()` 掉 error（reset 只清状态，不重发请求；此时 onSuccess 里的 invalidate 已生效）。
 */
function useResetOnSuccess<T extends { isSuccess: boolean; reset: () => void }>(m: T): void {
  useEffect(() => {
    if (m.isSuccess) m.reset();
  }, [m.isSuccess, m]);
}

/**
 * 批准计划（draft → approved）。
 * onSuccess 里 invalidate 计划查询 → 页面立刻拿到 approved，第一道栏杆收起。
 */
export function useApprovePlan() {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: approvePlan,
    onSuccess: (_data, planId) => {
      void qc.invalidateQueries({ queryKey: qk.plan });
      void qc.invalidateQueries({ queryKey: ['plan', 'by-id', planId] });
    },
  });
  useResetOnSuccess(m);
  return m;
}

/**
 * 预演。预演是长任务（受训记 45s/批限频），HTTP 返回的是 job 摘要而非最终结果，
 * 任务状态由 useWriteJob 轮询；此处 invalidate 是为了立即触发一次拉取。
 */
export function useWritePreview() {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: writePreview,
    onSuccess: (_data, planId) => {
      void qc.invalidateQueries({ queryKey: ['write', 'job', planId] });
    },
  });
  useResetOnSuccess(m);
  return m;
}

/** 确认写入（第二道栏杆）。 */
export function useWriteConfirm() {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: writeConfirm,
    onSuccess: (_data, planId) => {
      void qc.invalidateQueries({ queryKey: qk.plan });
      void qc.invalidateQueries({ queryKey: ['plan', 'by-id', planId] });
      void qc.invalidateQueries({ queryKey: ['write', 'job', planId] });
    },
  });
  useResetOnSuccess(m);
  return m;
}

/** 写入作业的终态（不再变化）——用于停轮询 + 触发计划查询刷新。 */
const WRITE_TERMINAL_STATUSES = new Set(['success', 'partial', 'failed', 'uncertain', 'cancelled']);

export function useWriteJob(planId: number | null) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['write', 'job', planId],
    queryFn: () => fetchWriteJob(planId as number),
    enabled: planId !== null,
    staleTime: 3_000,
    refetchInterval: (query) => {
      const s = query.state.data?.status;
      return s === 'writing' || s === 'dry_running' ? 3_000 : false;
    },
  });
  // 作业进入终态时 invalidate 计划查询：qk.plan / by-id 的 staleTime 30s，
  // 后台写完后前端若不主动拉取，顶部状态徽章会永远停在「写入中…」。
  // 只做 invalidate，不改 refetchInterval 语义（writing/dry_running → 3000ms）。
  const status = q.data?.status;
  useEffect(() => {
    if (planId === null || status === undefined || !WRITE_TERMINAL_STATUSES.has(status)) return;
    void qc.invalidateQueries({ queryKey: qk.plan });
    void qc.invalidateQueries({ queryKey: ['plan', 'by-id', planId] });
  }, [status, planId, qc]);
  return q;
}

export function useCurrentPlan() {
  return useQuery({ queryKey: qk.plan, queryFn: fetchCurrentPlan, staleTime: 30_000, retry: false });
}

export function fetchPlanById(planId: number): Promise<PlanDetail> {
  return getJson<PlanDetail>(`/api/plans/${planId}`);
}

export function usePlanById(planId: number | null) {
  return useQuery({
    queryKey: ['plan', 'by-id', planId],
    queryFn: () => fetchPlanById(planId as number),
    enabled: planId !== null,
    staleTime: 30_000,
    retry: false,
  });
}

export function useGeneratePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars?: { weekStart?: string; mode?: 'auto' | 'full' }) => generatePlan(vars?.weekStart, vars?.mode),
    onSuccess: (data) => qc.setQueryData(qk.plan, data.detail),
  });
}

export function useRegenerateTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (weekStart?: string) => regenerateTemplate(weekStart),
    onSuccess: (data) => qc.setQueryData(qk.plan, data.detail),
  });
}

export function useUpdateExercise(planId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { exerciseId: number; patch: Record<string, unknown> }) =>
      updateExercise(planId, args.exerciseId, args.patch),
    onSuccess: (data) => qc.setQueryData(qk.plan, data),
  });
}

export function useDeleteExercise(planId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (exerciseId: number) => deleteExercise(planId, exerciseId),
    onSuccess: (data) => qc.setQueryData(qk.plan, data),
  });
}

export function useMovePlanDay(planId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { dayId: number; datestr: string }) => movePlanDay(planId, args.dayId, args.datestr),
    onSuccess: (data) => qc.setQueryData(qk.plan, data),
  });
}

/**
 * 画像。
 * - 不传 `versionNo` → 最新快照（等价于旧行为，`queryKey` 仍是 `qk.analysis`，
 *   这样 `useRefreshAnalysis` 的 `setQueryData(qk.analysis)` 依旧命中）；
 * - 传 `versionNo` → 该版本，`queryKey` 里带上版本号，切换版本才会重新取数。
 *
 * `placeholderData` 保留上一个版本的数据，切换版本时不会整页闪「加载中…」
 * （`isPending` 只在首次没有任何数据时为 true）。
 */
export function useLatestAnalysis(versionNo?: number) {
  return useQuery({
    queryKey: versionNo === undefined ? qk.analysis : [...qk.analysis, versionNo],
    queryFn: () => fetchLatestAnalysis(versionNo),
    staleTime: 30_000,
    placeholderData: (prev: LatestResponse | undefined) => prev,
  });
}

export function useRefreshAnalysis() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: refreshAnalysis,
    // 过程产物（kind='adhoc'）不进版本列表；只就地更新「最新」缓存（无参 key）。
    onSuccess: (data) => qc.setQueryData(qk.analysis, data),
  });
}

// ---------------------------------------------------------------------------
// 画像版本（快照）：一个训练周期一版
//
// 版本 0 = 首次建立画像；之后每个训练周期末 +1。每份快照互相独立、都从原始数据重算；
// 过程产物（`kind='adhoc'`，见「重新分析」）不占版本号、不进版本列表。
// ---------------------------------------------------------------------------

/** 版本列表里的一行（已按版本号倒序）。 */
export interface SnapshotMeta {
  report_id: number;
  version_no: number;
  generated_at: string;
  window_start: string;
  window_end: string;
  weeks: number;
  active_weeks: number | null;
  finding_count: number;
  high_count: number;
}

export interface SnapshotVersionsResponse {
  versions: SnapshotMeta[];
}

/** POST /api/analysis/snapshot 的返回（无训练数据时 400，message 为中文说明）。 */
export interface SnapshotCreated {
  created: true;
  report_id: number;
  version_no: number;
  generated_at: string;
  window_start: string;
  window_end: string;
  weeks: number;
  active_weeks: number | null;
  finding_count: number;
  high_count: number;
}

export interface CompareSide {
  version_no: number;
  generated_at: string;
  window_start: string;
  window_end: string;
  weeks: number;
  active_weeks: number | null;
}

/** 动作在两版之间的重量/判定变化。 */
export interface CompareMovement {
  name: string;
  from_weight: number | null;
  to_weight: number | null;
  delta_pct: number | null;
  from_verdict: string | null;
  to_verdict: string | null;
  changed: boolean;
}

/** 肌群在两版之间的周均组数变化。`name` 已是中文肌群名。 */
export interface CompareMuscle {
  code: string;
  name: string;
  from_weekly_sets: number;
  to_weekly_sets: number;
  delta_pct: number | null;
  from_verdict: string | null;
  to_verdict: string | null;
}

export interface CompareFinding {
  code: string;
  severity: string;
  title: string;
}

/** 版本对比结果（服务端已排好序，前端只做展示）。 */
export interface VersionCompare {
  from: CompareSide;
  to: CompareSide;
  movements: CompareMovement[];
  muscles: CompareMuscle[];
  findings: {
    added: CompareFinding[];
    removed: CompareFinding[];
  };
  summary: {
    movements_changed: number;
    muscles_changed: number;
    findings_added: number;
    findings_removed: number;
  };
}

export async function fetchSnapshotVersions(): Promise<SnapshotVersionsResponse> {
  return getJson<SnapshotVersionsResponse>('/api/analysis/snapshots');
}

export function fetchVersionCompare(from: number, to: number): Promise<VersionCompare> {
  return getJson<VersionCompare>(`/api/analysis/snapshots/compare?from=${from}&to=${to}`);
}

/**
 * 生成一份画像快照（新的训练周期末）。
 * 不用 `sendJson` 是因为 400 的中文说明走在 `message` 字段上（不是 `error`）。
 */
export async function createSnapshot(): Promise<SnapshotCreated> {
  const res = await fetch('/api/analysis/snapshot', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) {
    let msg = `生成画像版本失败：${res.status}`;
    try {
      const err = (await res.json()) as { message?: string; error?: string };
      if (err.message) msg = err.message;
      else if (err.error) msg = err.error;
    } catch {
      // 保持默认状态码说明
    }
    throw new Error(msg);
  }
  return (await res.json()) as SnapshotCreated;
}

export function useSnapshotVersions() {
  return useQuery({
    queryKey: ['analysis', 'snapshots'],
    queryFn: fetchSnapshotVersions,
    staleTime: 30_000,
  });
}

/** 生成新版本后，`analysis` 命名空间下的版本列表 / 最新 / 对比全部失效重取。 */
export function useCreateSnapshot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createSnapshot,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['analysis'] }),
  });
}

/** 两个版本号都非 null 时才请求 —— 收起对比区时传 null，避免打开页面就发请求。 */
export function useVersionCompare(from: number | null, to: number | null) {
  return useQuery({
    queryKey: ['analysis', 'compare', from, to],
    queryFn: () => fetchVersionCompare(from as number, to as number),
    enabled: from !== null && to !== null,
    staleTime: 30_000,
    retry: false,
  });
}

export function useMappings() {
  return useQuery({ queryKey: qk.mappings, queryFn: fetchMappings, staleTime: 60_000 });
}

export function useUnresolved() {
  return useQuery({ queryKey: qk.unresolved, queryFn: fetchUnresolved, staleTime: 60_000 });
}

// ---------------------------------------------------------------------------
// 训练基础（V1）：训练日 / 每次时长 / 一周起始日 / 长期目标
// ---------------------------------------------------------------------------

export interface GoalSettings {
  id: number;
  goalType: string;
  /** 由 preferredDows.length 推导，前端只读显示 */
  sessionsPerWeek: number;
  minDurationMin: number;
  maxDurationMin: number;
  /** 0=周日 1=周一 */
  weekStartDow: number;
  /** 0=周日 … 6=周六，已按周起点排序 */
  preferredDows: number[];
  effectiveFrom: string;
}

/** PUT 入参：不带 sessions_per_week（服务端由训练日数量推导）。 */
export interface GoalPayload {
  goal_type: string;
  min_duration_min: number;
  max_duration_min: number;
  week_start_dow: number;
  preferred_dows: number[];
}

export interface GoalSaveResult {
  goal: GoalSettings;
}

export function fetchGoal(): Promise<{ goal: GoalSettings | null }> {
  return getJson<{ goal: GoalSettings | null }>('/api/goal');
}

export function saveGoal(payload: GoalPayload): Promise<GoalSaveResult> {
  return sendJson<GoalSaveResult>('/api/goal', 'PUT', payload);
}

export function useGoal() {
  return useQuery({ queryKey: qk.goal, queryFn: fetchGoal, staleTime: 30_000 });
}

export function useSaveGoal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: saveGoal,
    onSuccess: (data) => {
      qc.setQueryData(qk.goal, { goal: data.goal });
    },
  });
}

// ---------------------------------------------------------------------------
// 训练周期（V2）：4 周 = 3 周渐进 + 第 4 周减量；周期目标周期内锁定
// ---------------------------------------------------------------------------

export interface CycleInfo {
  id: number;
  cycleNo: number;
  firstWeekStart: string;
  lastWeekStart: string;
  goalText: string;
  status: 'active' | 'closed';
  /** 非空 = 这个周期的目标被「强行修改」过 */
  forceEditedAt: string | null;
  createdAt: string;
  closedAt: string | null;
}

export interface CycleStatusResponse {
  cycle: CycleInfo | null;
  /** **今天所在周**是周期第几周（1~4）；不在周期内 = null */
  week_no: number | null;
  is_deload: boolean;
  /** 4 周已跑完，需要开新周期 */
  expired: boolean;
  /**
   * **计划周**（下一周）在周期里的位置 —— 首页整页讲的是下一周，所以首页用这一组。
   *
   * 为什么要跟上面那组分开：周期通常从下一周开始计，而「今天所在的周」还在周期开始之前
   * → `week_no` 是 null，界面会显示「本周期第 —/4 周」并误报「不在周期范围内」。
   * 排计划用的 `cycleContextFor(db, planWeek)` 一直是按计划周算的，两边必须一致。
   */
  plan_week: {
    week_no: number | null;
    in_cycle: boolean;
    is_deload: boolean;
    /** 计划周已越过周期最后一周 = 该开新周期了 */
    expired: boolean;
    /**
     * 起始周（Week 0）—— 用户中途开始用、本周只剩几个训练日时，本周照样排计划，
     * 但**不占周期第 1 周**（`week_no` 为 null）。前端要显式标注，否则用户会以为是程序算错了。
     */
    is_starter_week: boolean;
  };
  /** 开新周期时的默认开始周（下一个计划周起点） */
  next_week_start: string;
  /** 排计划实际用的那一周起点（起始周时可能是「本周」，否则等于 next_week_start） */
  plan_week_start: string;
}

export const CYCLE_WEEKS = 4;

export function fetchCycle(): Promise<CycleStatusResponse> {
  return getJson<CycleStatusResponse>('/api/cycle');
}

export function openCycle(goalText: string, firstWeekStart?: string): Promise<CycleStatusResponse> {
  return sendJson<CycleStatusResponse>('/api/cycle', 'POST', {
    goal_text: goalText,
    ...(firstWeekStart ? { first_week_start: firstWeekStart } : {}),
  });
}

/** 「强行修改」周期目标 —— 唯一改动入口（周期内锁定，防止频繁改目标等于没目标）。 */
export function forceEditCycleGoal(goalText: string): Promise<CycleStatusResponse> {
  return sendJson<CycleStatusResponse>('/api/cycle/goal', 'PUT', { goal_text: goalText });
}

export function closeCycle(): Promise<CycleStatusResponse> {
  return sendJson<CycleStatusResponse>('/api/cycle/close', 'POST', {});
}

export function useCycle() {
  return useQuery({ queryKey: qk.cycle, queryFn: fetchCycle, staleTime: 30_000 });
}

export function useOpenCycle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { goalText: string; firstWeekStart?: string }) => openCycle(args.goalText, args.firstWeekStart),
    onSuccess: (data) => qc.setQueryData(qk.cycle, data),
  });
}

export function useForceEditCycleGoal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (goalText: string) => forceEditCycleGoal(goalText),
    onSuccess: (data) => qc.setQueryData(qk.cycle, data),
  });
}

export function useCloseCycle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: closeCycle,
    onSuccess: (data) => qc.setQueryData(qk.cycle, data),
  });
}

// ---------------------------------------------------------------------------
// AI 配置（V4）：Key 只写 .env，前端只见掩码
// ---------------------------------------------------------------------------

export interface AiConfigView {
  mode: 'http' | 'off';
  base_url: string;
  model: string;
  max_tokens: number;
  temperature: number;
  /** 只回布尔值，永不回传 Key 内容 */
  has_key: boolean;
  /** `****abcd` */
  key_hint: string | null;
  ready: boolean;
  blocked_reason: string | null;
  local_endpoint: boolean;
}

export interface AiConfigResponse {
  config: AiConfigView;
  env_file: string;
}

/** PUT 入参：不带 api_key 就保持原 Key 不动（前端拿不到明文，也就不会误清空）。 */
export interface AiConfigPayload {
  mode: 'http' | 'off';
  base_url: string;
  model: string;
  max_tokens: number;
  temperature: number;
  api_key?: string;
  clear_key?: boolean;
}

export function fetchAiConfig(): Promise<AiConfigResponse> {
  return getJson<AiConfigResponse>('/api/ai/config');
}

export function saveAiConfig(payload: AiConfigPayload): Promise<AiConfigResponse & { applied: boolean }> {
  return sendJson<AiConfigResponse & { applied: boolean }>('/api/ai/config', 'PUT', payload);
}

export const qkAi = { config: ['ai', 'config'] as const };

export function useAiConfig() {
  return useQuery({ queryKey: qkAi.config, queryFn: fetchAiConfig, staleTime: 30_000 });
}

export function useSaveAiConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: saveAiConfig,
    onSuccess: (data) => qc.setQueryData(qkAi.config, { config: data.config, env_file: data.env_file }),
  });
}

// ---------------------------------------------------------------------------
// 训记接入（XUNJI_API_KEY）
// 与 AI 配置同一条安全纪律：明文只落 .env，接口只回掩码，前端不回读明文。
// ---------------------------------------------------------------------------

export interface XunjiKeyView {
  has_key: boolean;
  /** 形如 `****abcd`；未配置时为 null。**永远不是明文**。 */
  key_hint: string | null;
}

export interface XunjiConfigResponse {
  config: XunjiKeyView;
  env_file: string;
}

export interface XunjiKeyPayload {
  /** 新 Key；不传表示保持原值（所以「保存一次」不会把已有 Key 清空）。 */
  api_key?: string;
  clear_key?: boolean;
}

export function fetchXunjiConfig(): Promise<XunjiConfigResponse> {
  return getJson<XunjiConfigResponse>('/api/xunji/config');
}

export function saveXunjiConfig(payload: XunjiKeyPayload): Promise<XunjiConfigResponse & { applied: boolean }> {
  return sendJson<XunjiConfigResponse & { applied: boolean }>('/api/xunji/config', 'PUT', payload);
}

export const qkXunji = { config: ['xunji', 'config'] as const };

export function useXunjiConfig() {
  return useQuery({ queryKey: qkXunji.config, queryFn: fetchXunjiConfig, staleTime: 30_000 });
}

export function useSaveXunjiConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: saveXunjiConfig,
    onSuccess: (data) => qc.setQueryData(qkXunji.config, { config: data.config, env_file: data.env_file }),
  });
}

// ---------------------------------------------------------------------------
// 任务编排 / 通知
// ---------------------------------------------------------------------------

export interface JobRunView {
  id: number;
  job_type: string;
  status: string;
  triggered_by: string;
  scheduled_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  progress: { total?: number; fetched?: number; empty?: number; failed?: number; skipped?: number; message?: string } | null;
  result_ref: string | null;
  error: unknown;
  label: string;
}

export interface JobsRecentResponse {
  jobs: JobRunView[];
  runner: { busy: boolean; job_type: string | null; pending: number };
}

export interface NotificationItem {
  id: number;
  level: 'info' | 'warn' | 'error';
  title: string;
  body: string | null;
  ref_type: string | null;
  ref_id: string | null;
  is_read: number;
  created_at: string;
}

export interface NotificationsResponse {
  notifications: NotificationItem[];
  unread: number;
}

export async function fetchJobsRecent(): Promise<JobsRecentResponse> {
  return getJson<JobsRecentResponse>('/api/jobs/recent');
}

export async function triggerJob(jobType: string): Promise<{ queued: boolean; job_type: string }> {
  return sendJson('/api/jobs/trigger', 'POST', { job_type: jobType });
}

export async function fetchNotifications(): Promise<NotificationsResponse> {
  return getJson<NotificationsResponse>('/api/notifications');
}

export async function markNotificationsRead(ids: number[]): Promise<{ marked: number }> {
  return sendJson('/api/notifications/read', 'POST', { ids });
}

export const qkJobs = {
  recent: ['jobs', 'recent'] as const,
  notifications: ['notifications'] as const,
};

export function useJobsRecent() {
  return useQuery({
    queryKey: qkJobs.recent,
    queryFn: fetchJobsRecent,
    staleTime: 5_000,
    refetchInterval: (query) => (query.state.data?.runner.busy ? 3_000 : 15_000),
  });
}

export function useTriggerJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: triggerJob,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qkJobs.recent });
    },
  });
}

export function useNotifications() {
  return useQuery({ queryKey: qkJobs.notifications, queryFn: fetchNotifications, staleTime: 10_000, refetchInterval: 20_000 });
}

export function useMarkNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: markNotificationsRead,
    onSuccess: () => qc.invalidateQueries({ queryKey: qkJobs.notifications }),
  });
}

// ---------------------------------------------------------------------------
// 周复盘（V8）：手账式周视图 + 每日感受
//
// 感受（daily_note）只写本地库，**不同步回训记**（§6 决策 1）。
// 周级数字由服务端从逐日 days **现算**（2026-09-30 修：原先取自 loadPlanActual 的
// 「计划 vs 实际」口径，没计划的历史周会全为 0），前端只做展示，不重算。
// ---------------------------------------------------------------------------

/** 逐动作明细（手账式展示：每个动作做了几组、用的多少公斤；次数不展示）。 */
export interface WeekMovementItem {
  name: string;
  sets: number;
  /** 重量摘要，如 `80kg` / `80kg / 82.5kg`；没记重量则为空串 */
  weight: string;
}

export interface WeekDayActual {
  sessions: number;
  movements: number;
  effective_sets: number;
  duration_min: number | null;
  /** 逐动作明细（按训记里的排练顺序） */
  items: WeekMovementItem[];
}

export interface WeekDayPlanned {
  plan_day_id: number;
  title: string;
  target_muscles: string[];
  planned_sets: number;
  est_duration_min: number | null;
}

/** done=达标(≥80%) partial=未完成 missed=没练 extra=额外加练 rest=休息 upcoming=未到 */
export type WeekDayStatus = 'done' | 'partial' | 'missed' | 'extra' | 'rest' | 'upcoming';

export interface WeekDayRow {
  datestr: string;
  dow: number;
  planned: WeekDayPlanned | null;
  actual: WeekDayActual;
  /** 实际有效组 / 计划组；无计划 → null。可能 >1（超额） */
  completion: number | null;
  status: WeekDayStatus;
  /** 用户写的当日感受 */
  note: string | null;
}

export interface WeekSummaryNumbers {
  planned_sessions: number;
  trained_days: number;
  planned_sets: number;
  effective_sets: number;
  /** 0~1 的比值，无计划时为 0 */
  completion: number;
  missed_days: string[];
  skipped_movements: string[];
  missed_weight: string[];
  notes_count: number;
}

/** 该周已生成的 AI 复盘（V8 输出，刻意很短）。 */
export interface WeeklyReviewAi {
  status: string;
  ai_summary: { verdict: string; adjustments: string[]; note_reply: string } | null;
  data_summary: object | null;
  generated_at: string;
}

/** 复盘锁定判据码（与服务端 reviewLockReason 同源）。 */
export type ReviewLockCode = 'no_takeover' | 'pre_takeover' | 'not_over' | 'no_content';

/** 服务端下发的复盘锁定（唯一判据；前端不再自己镜像规则）。 */
export interface ReviewLock {
  code: ReviewLockCode;
  /** 完整原因：按钮 title 与说明正文 */
  reason: string;
  /** 锁定态按钮上的短标签 */
  label: string;
}

export interface WeekView {
  week_start: string;
  week_end: string;
  today: string;
  /** 该周是否已结束（week_end < today）。未结束不允许做 AI 复盘。 */
  is_over: boolean;
  /** 接管起点（第一个由本软件规划的训练周）；尚未接管 → null。早于它的周只进画像、不复盘。 */
  takeover_start_week: string | null;
  /** 复盘锁定；null = 可复盘。pre_takeover / no_takeover 时整页只显示说明卡。 */
  lock: ReviewLock | null;
  plan: { id: number; status: string; source: string } | null;
  cycle: { week_no: number; total_weeks: number; goal_text: string; is_deload: boolean } | null;
  days: WeekDayRow[];
  summary: WeekSummaryNumbers;
  review: WeeklyReviewAi | null;
}

/** POST /api/reviews/weekly 的返回。status='draft' 时 detail 说明为何没有 AI 部分。 */
export interface WeeklyGenerateResult {
  status: 'done' | 'draft';
  week_start: string;
  week_end: string;
  ai_summary: { verdict: string; adjustments: string[]; note_reply: string } | null;
  detail?: string;
}

/** 周视图缓存 key（就地更新每日感受时按同一个 key 精准命中）。 */
export function qkWeek(weekStart: string | null): readonly [string, string, string | null] {
  return ['reviews', 'week', weekStart] as const;
}

/** 不传 weekStart = 服务端按周起点设置算的当前周。 */
export function fetchWeekView(weekStart?: string): Promise<WeekView> {
  const qs = weekStart !== undefined && weekStart !== '' ? `?week_start=${encodeURIComponent(weekStart)}` : '';
  return getJson<WeekView>(`/api/reviews/week${qs}`);
}

/** 最近 N 周的 week_start（新 → 旧），第一个是当前周。 */
export function fetchReviewWeeks(count = 8): Promise<string[]> {
  return getJson<{ weeks: string[] }>(`/api/reviews/weeks?count=${count}`).then((r) => r.weeks);
}

/** 写某天的感受；text 去空白后为空 → 服务端删行并返回 text: null。 */
export function saveDailyNote(datestr: string, text: string): Promise<{ datestr: string; text: string | null }> {
  return sendJson<{ datestr: string; text: string | null }>('/api/reviews/note', 'PUT', { datestr, text });
}

/** 生成该周 AI 复盘。周未结束 → 抛错（错误信息来自服务端 400）。 */
export function generateWeeklyReview(weekStart: string): Promise<WeeklyGenerateResult> {
  return sendJson<WeeklyGenerateResult>('/api/reviews/weekly', 'POST', { week_start: weekStart });
}

/**
 * 周视图。
 *  - **不传** `weekStart` → 当前周（服务端按「一周起始日」设置算）；首页用这个。
 *  - 传 `null` → 周次还没确定，先别发请求（复盘页在 weeks 列表加载完之前就是这状态）。
 * ⚠️ 别把两者搞混：首页曾经写成 `useWeekView(null)`，看着像「要当前周」，
 *    实际命中 `enabled: false`，周视图永远不请求 —— 于是首页的「本周特殊情况」恒不渲染。
 */
export function useWeekView(weekStart?: string | null) {
  return useQuery({
    queryKey: qkWeek(weekStart ?? null),
    queryFn: () => fetchWeekView(weekStart ?? undefined),
    enabled: weekStart !== null,
    staleTime: 30_000,
    retry: false,
  });
}

export function useReviewWeeks() {
  return useQuery({
    queryKey: ['reviews', 'weeks'],
    queryFn: () => fetchReviewWeeks(8),
    staleTime: 60_000,
    retry: false,
  });
}

/**
 * 保存每日感受，**成功后就地更新该周视图缓存里那一天的 note**，不整页 refetch ——
 * 整页 refetch 会让正在输入的其他输入框被服务端旧值回灌而打断（§10.3 V8）。
 * weekStart 走 mutation 变量，保证并发保存时各自命中自己那一周的缓存。
 */
export function useSaveDailyNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { weekStart: string; datestr: string; text: string }) => saveDailyNote(args.datestr, args.text),
    onSuccess: (data, args) => {
      qc.setQueryData<WeekView>(qkWeek(args.weekStart), (prev) => {
        if (!prev) return prev;
        let delta = 0;
        const days = prev.days.map((d) => {
          if (d.datestr !== data.datestr) return d;
          const wasWritten = d.note !== null;
          const nowWritten = data.text !== null;
          if (wasWritten !== nowWritten) delta = nowWritten ? 1 : -1;
          return { ...d, note: data.text };
        });
        return {
          ...prev,
          days,
          summary: { ...prev.summary, notes_count: prev.summary.notes_count + delta },
        };
      });
    },
  });
}

/**
 * 生成该周 AI 复盘。结果落在 view.review，需要重取该周视图才能看到；
 * 这里 invalidate 只影响这一周的缓存，且每日输入框的本地 state 不会因父级重渲染而重置。
 */
export function useGenerateWeeklyReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (weekStart: string) => generateWeeklyReview(weekStart),
    onSuccess: (_data, weekStart) => qc.invalidateQueries({ queryKey: qkWeek(weekStart) }),
  });
}

// ---------------------------------------------------------------------------
// 个人基础信息 + 用户画像（V9，2026-09-30 从「身体信息」扩为「个人基础信息」）
//
// 体重与这些字段都是**手动填**的，不是从训记推出来的（训记里没有这些）。
// 🔴 全部可空、非必填：留空在传参里用 `null`（文本字段也可用空串）表示，
//    服务端存 null，进 AI 摘要层也是 null —— 语义是「用户没告诉我」，不是「待补全」。
// 🔴 旧伤只作背景参考：前端只负责展示/编辑这段文本，
//    不做任何「因为旧伤所以推荐/禁用某动作」的联动（PRD-v2 §5）。
// ---------------------------------------------------------------------------

/**
 * 性别候选项。
 * ⚠️ 必须与 `server/body/bodyService.ts` 的 `GENDER_VALUES` 逐字一致 ——
 *    服务端按白名单校验（这些值会原样进 AI 的 prompt），不一致会直接 400。
 */
export const GENDERS = ['女', '男'] as const;

/** 训练年限候选项。同上，必须与 `TRAINING_YEARS_VALUES` 一致。 */
export const TRAINING_YEARS = ['不到 1 年', '1~3 年', '3 年以上'] as const;

/** 年龄 / 身高的合理区间（与服务端 `AGE_MIN/MAX`、`HEIGHT_MIN/MAX` 一致）—— 只拦误输入。 */
export const AGE_RANGE = { min: 10, max: 100 } as const;
export const HEIGHT_RANGE = { min: 100, max: 250 } as const;

export interface WeightPoint {
  datestr: string;
  weight_kg: number;
}

export interface BodyInfo {
  /** 旧伤 / 基础疾病；空串 = 没填 */
  conditions: string;
  /** 性别（`女` / `男`）；null = 没填 */
  gender: string | null;
  /** 年龄；null = 没填 */
  age: number | null;
  /** 身高（cm）；null = 没填 */
  height_cm: number | null;
  /** 训练年限；null = 没填 */
  training_years: string | null;
  weight_kg: number | null;
  weight_date: string | null;
  /** 相对 30 天前最近一次的变化（kg），正 = 涨；不足两条记录 → null */
  delta_30d_kg: number | null;
  updated_at: string | null;
}

export interface BodyResponse {
  info: BodyInfo;
  /** 近 180 天，升序 */
  weights: WeightPoint[];
}

/**
 * 部分更新：给哪个字段改哪个。
 * - `weight_kg: null` + `datestr` = 删掉那天的记录
 * - 基础信息传 `null`（或空串）= 清空那一项（用户把选中的按钮再点一下就是取消选择）
 */
export interface BodyPatch {
  conditions?: string;
  gender?: string | null;
  age?: number | null;
  height_cm?: number | null;
  training_years?: string | null;
  weight_kg?: number | null;
  datestr?: string;
}

export const qkBody = { body: ['body'] as const, profile: ['profile'] as const };

export function fetchBody(): Promise<BodyResponse> {
  return getJson<BodyResponse>('/api/body');
}

export function saveBody(patch: BodyPatch): Promise<BodyResponse> {
  return sendJson<BodyResponse>('/api/body', 'PUT', patch);
}

export function useBody() {
  return useQuery({ queryKey: qkBody.body, queryFn: fetchBody, staleTime: 30_000, retry: false });
}

export function useSaveBody() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: BodyPatch) => saveBody(patch),
    // 服务端把整份状态回传了，直接落地，不用再问一次
    onSuccess: (data) => qc.setQueryData(qkBody.body, data),
  });
}

export interface ProfileMovement {
  name: string;
  last_weight: number | null;
  verdict: string;
  delta_pct: number | null;
  weeks: number;
  last_performed: string | null;
}

export interface ProfileView {
  generated_at: string;
  report_id: number;
  week_start: string;
  /** `active_weeks` = 窗口内实际被训练数据覆盖的周数（周均类指标的分母；旧报告可能没有）。 */
  window: { start: string; end: string; weeks: number; active_weeks?: number };
  habit: {
    sessions_per_week: number;
    goal_sessions_per_week: number | null;
    avg_duration_min: number | null;
    duration_median_min: number | null;
    trained_dows: number[];
  };
  muscles: Array<{ code: string; name: string; weekly_sets: number; verdict: string | null }>;
  structure: { push_pull_ratio: number | null; upper_lower_ratio: number | null };
  body: {
    weight_kg: number | null;
    weight_date: string | null;
    delta_30d_kg: number | null;
    conditions: string;
    gender: string | null;
    age: number | null;
    height_cm: number | null;
    training_years: string | null;
  };
  movements: ProfileMovement[];
  cycle: { week_no: number; total_weeks: number; goal_text: string; is_deload: boolean } | null;
  goal: {
    goal_type: string;
    sessions_per_week: number;
    preferred_dows: number[];
    min_duration_min: number;
    max_duration_min: number;
  } | null;
}

/**
 * 用户画像 = 系统实际喂给 AI 的长期画像（§6 决策 6：只放一个入口，点进去才展开）。
 *
 * `enabled` 由「展开」按钮控制：**折叠状态下不发请求** ——
 * 画像是现算的（要拼一遍 digest），设置页每次打开都白算一遍没有意义。
 */
export function useProfile(enabled: boolean) {
  return useQuery({
    queryKey: qkBody.profile,
    queryFn: () => getJson<{ profile: ProfileView | null }>('/api/profile').then((r) => r.profile),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// 计划周特殊情况（2026-09-30 用户定案）—— 排计划时优先级最高的输入
// ---------------------------------------------------------------------------

/**
 * 🔴 与「复盘页的逐日感受」是**两回事**，所以是两个接口：
 *   - 这里（`/api/week-note`）：**事前**写的一句话，给**排计划**用。优先级高于周期目标
 *     （「这周来经期 → 先按经期减容，再谈周期目标要练什么」）。
 *   - `/api/reviews/note`：**事后**感受，给**复盘**用，不直接进排计划输入。
 *
 * 按 `week_start` 存。不传 week_start 时服务端给的是**计划周**（下一周，与生成计划同源），
 * 所以前端不用自己算周起点。
 */
export interface WeekNote {
  week_start: string;
  /** null = 没写过（或已清空） */
  text: string | null;
}

export const qkWeekNote = (weekStart: string | null): readonly [string, string, string | null] =>
  ['week-note', 'plan', weekStart] as const;

export function fetchWeekNote(weekStart?: string): Promise<WeekNote> {
  const qs = weekStart ? `?week_start=${encodeURIComponent(weekStart)}` : '';
  return getJson<WeekNote>(`/api/week-note${qs}`);
}

export function saveWeekNote(text: string, weekStart?: string): Promise<WeekNote> {
  return sendJson<WeekNote>('/api/week-note', 'PUT', { text });
}

/** 不传 weekStart = 计划周（下一周）。 */
export function useWeekNote(weekStart?: string) {
  return useQuery({
    queryKey: qkWeekNote(weekStart ?? null),
    queryFn: () => fetchWeekNote(weekStart),
    staleTime: 30_000,
    retry: false,
  });
}

export function useSaveWeekNote(weekStart?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (text: string) => saveWeekNote(text, weekStart),
    onSuccess: (data) => qc.setQueryData(qkWeekNote(weekStart ?? null), data),
  });
}

// ---------------------------------------------------------------------------
// 计划重置（2026-10-05 用户定案）—— 设置页底部「危险区」
// ---------------------------------------------------------------------------

/** 会删掉什么 + 什么**不会**被删（后者明写在界面上，让用户放心） */
export interface ResetPreview {
  plans: number;
  plan_days: number;
  plan_exercises: number;
  write_jobs: number;
  weekly_reviews: number;
  cycles: number;
  protected: {
    training_sessions: number;
    training_sets: number;
    active_goals: number;
    daily_notes: number;
    week_notes: number;
    weight_logs: number;
  };
}

export interface ResetPlanResult {
  plans: number;
  plan_days: number;
  plan_exercises: number;
  plan_edit_logs: number;
  write_jobs: number;
  write_batches: number;
  write_items: number;
  weekly_reviews: number;
  cycles: number;
  cleared_cycle: boolean;
}

export const qkReset = { preview: ['reset', 'preview'] as const };

export function fetchResetPreview(): Promise<ResetPreview> {
  return getJson<ResetPreview>('/api/reset/preview');
}

export function useResetPreview(enabled: boolean) {
  return useQuery({
    queryKey: qkReset.preview,
    queryFn: fetchResetPreview,
    enabled,
    staleTime: 0,
  });
}

export interface ResetPlanResponse {
  ok: true;
  result: ResetPlanResult;
  preview: ResetPreview;
}

/**
 * 清空「本次生成的计划」。
 *
 * `confirm` 恒为 `'CLEAR'` —— 服务端要求逐字匹配，是防误触闸门（不是安全边界）。
 * 成功后把计划/周期/复盘相关的缓存全部作废，让首页与设置页立刻回到空态。
 */
export function resetPlan(opts: { clearCycle: boolean }): Promise<ResetPlanResponse> {
  return sendJson<ResetPlanResponse>('/api/reset/plan', 'POST', {
    clear_cycle: opts.clearCycle,
    confirm: 'CLEAR',
  });
}

export function useResetPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: resetPlan,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qkReset.preview });
      void qc.invalidateQueries({ queryKey: qk.plan });
      void qc.invalidateQueries({ queryKey: qk.cycle });
      void qc.invalidateQueries({ queryKey: ['reviews'] });
    },
  });
}

// ---------------------------------------------------------------------------
// 首次使用引导（2026-10-06）—— 只读写一个完成位
//
// 🔴 引导三步的业务写入仍走既有的 /api/xunji/config、/api/goal、/api/body，
//    这里**只**管一个布尔完成位。完成位一旦置位不可回退（服务端拒绝 done:false），
//    要重新看引导走设置页的「重新运行首次引导」入口（纯前端强制打开，不改服务端状态）。
// ---------------------------------------------------------------------------

export interface OnboardingState {
  done: boolean;
}

export function fetchOnboarding(): Promise<OnboardingState> {
  return getJson<OnboardingState>('/api/onboarding');
}

/** 置完成位。只接受 `{ done: true }`（服务端会拒绝 false）。 */
export function completeOnboarding(): Promise<OnboardingState> {
  return sendJson<OnboardingState>('/api/onboarding', 'PUT', { done: true });
}

export const qkOnboarding = { state: ['onboarding'] as const };

export function useOnboarding() {
  return useQuery({
    queryKey: qkOnboarding.state,
    queryFn: fetchOnboarding,
    staleTime: 30_000,
    retry: false,
  });
}

export function useCompleteOnboarding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: completeOnboarding,
    onSuccess: (data) => qc.setQueryData(qkOnboarding.state, data),
  });
}
