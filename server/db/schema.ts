/**
 * SQLite schema v1（§3.2 完整 DDL，逐字转录自架构文档）。
 *
 * 说明：DDL 在架构里是「单一版本化 schema」而非按任务拆分的表集。
 * T1 一次性建全量 schema（v1），理由：
 *   1) 外键闭包要求 —— `session_movement.catalog_id → movement_catalog(id)`、
 *      `sync_write_job.plan_id → plan(id)`、`analysis_report.job_run_id → job_run(id)`
 *      等跨任务外键在 `PRAGMA foreign_keys = ON` 下要求父表必须存在；
 *   2) 建表与使用解耦 —— T2/T3/T4 只写业务代码，不再动 schema；
 *   3) `CREATE TABLE IF NOT EXISTS` 幂等，重复执行无副作用。
 * T1 实际写入的表：schema_migration / app_config / notification / raw_train_raw /
 * train_session / session_movement / movement_set / sync_date_state / job_run。
 * 其余表（映射、计划、写回、总结等）仅创建，供后续任务使用。
 */
export const SCHEMA_V1_DDL = `
-- ============================================================
-- ai_training_planner / SQLite schema v1
-- 连接后立即执行：
--   PRAGMA journal_mode = WAL;
--   PRAGMA foreign_keys = ON;
--   PRAGMA synchronous = NORMAL;
-- ============================================================

-- ---------- 0. 元信息与配置 ----------
CREATE TABLE IF NOT EXISTS schema_migration (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  applied_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_config (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notification (
  id          INTEGER PRIMARY KEY,
  level       TEXT NOT NULL CHECK (level IN ('info','warn','error')),
  title       TEXT NOT NULL,
  body        TEXT,
  ref_type    TEXT,             -- 'job_run' | 'plan' | 'sync' | 'review'
  ref_id      TEXT,
  is_read     INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0,1)),
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notification_unread ON notification(is_read, created_at DESC);

-- ---------- 1. 原始快照层（第1层数据） ----------
CREATE TABLE IF NOT EXISTS raw_train_raw (
  id            INTEGER PRIMARY KEY,
  datestr       TEXT NOT NULL,
  fetched_at    TEXT NOT NULL,
  request_json  TEXT NOT NULL,
  payload_json  TEXT,                      -- 解压后的完整 res
  payload_hash  TEXT,                      -- sha256(payload_json)，用于增量判定
  http_status   INTEGER,
  ok            INTEGER NOT NULL DEFAULT 0 CHECK (ok IN (0,1)),
  error_code    TEXT,                      -- 'apikey missing'|'apikey invalid'|'vip_only'|'too frequent'|'network'|'http5xx'|'parse'|'unknown'
  error_msg     TEXT,                      -- 已脱敏
  UNIQUE (datestr, fetched_at)
);
CREATE INDEX IF NOT EXISTS idx_raw_datestr ON raw_train_raw(datestr);
CREATE INDEX IF NOT EXISTS idx_raw_latest  ON raw_train_raw(datestr, fetched_at DESC);

-- ---------- 2. 结构化训练数据（第1层数据的清洗结果） ----------
CREATE TABLE IF NOT EXISTS train_session (
  id             INTEGER PRIMARY KEY,
  datestr        TEXT NOT NULL,
  localid        TEXT,                     -- 训记侧 ID；写入后回填
  title          TEXT,                     -- 实测：86% 为空，展示时须按主导肌群自动生成标题
  title_source   TEXT CHECK (title_source IN ('server','generated',NULL)),
  note           TEXT,                     -- 实测：91% 有值，主观状态的重要来源（仅本地分析用，不进 AI 原文）
  start_ms       INTEGER,
  end_ms         INTEGER,
  started_at     TEXT,                     -- 服务端 started_at（两种模式均有）
  ended_at       TEXT,                     -- 服务端 ended_at（两种模式均有）
  server_truncated INTEGER CHECK (server_truncated IN (0,1,NULL)),
                                       -- 读侧上限触发的截断标志：读侧 40 动作/60 组（写侧才是 15/20，见 §12.1），
                                       -- 超限即置 truncated=true，解析器必须检测并告警（§6.2.4）
  duration_min   REAL,                     -- 由 end_ms-start_ms 计算；缺失时 NULL
  duration_src   TEXT CHECK (duration_src IN ('start_end','declared','estimated',NULL)),
  is_outlier     INTEGER NOT NULL DEFAULT 0 CHECK (is_outlier IN (0,1)),  -- 极端时长（<20 或 >150 分钟）
  outlier_reason TEXT CHECK (outlier_reason IN ('too_short','too_long','missing_duration',NULL)),
  is_cardio      INTEGER NOT NULL DEFAULT 0 CHECK (is_cardio IN (0,1)),
  is_rest        INTEGER NOT NULL DEFAULT 0 CHECK (is_rest IN (0,1)),
  session_type   TEXT,                     -- 'strength'|'cardio'|'mixed'|'rest'|'other'
  content_hash   TEXT NOT NULL,            -- 结构内容哈希，用于判定是否需重算
  raw_id         INTEGER REFERENCES raw_train_raw(id) ON DELETE SET NULL,
  synced_at      TEXT NOT NULL,
  UNIQUE (datestr, localid)
);
CREATE INDEX IF NOT EXISTS idx_session_date    ON train_session(datestr);
CREATE INDEX IF NOT EXISTS idx_session_range   ON train_session(datestr, session_type);
CREATE INDEX IF NOT EXISTS idx_session_localid ON train_session(localid);

CREATE TABLE IF NOT EXISTS session_movement (
  id             INTEGER PRIMARY KEY,
  session_id     INTEGER NOT NULL REFERENCES train_session(id) ON DELETE CASCADE,
  ord            INTEGER NOT NULL,
  server_index   INTEGER,                  -- 服务端 movements[].index（读侧单训练 ≤40 动作，res.limits.maxMovesPerTrain）
  name_raw       TEXT NOT NULL,            -- 训记返回的原始动作名
  name_norm      TEXT NOT NULL,            -- 归一化后（全角转半角/去空格/繁转简）
  catalog_id     INTEGER REFERENCES movement_catalog(id) ON DELETE SET NULL,
  resolve_status TEXT NOT NULL DEFAULT 'unresolved'
                 CHECK (resolve_status IN ('exact','alias','server','rule','manual','unresolved')),
  server_type    TEXT,                     -- 【实测新增】服务端自带肌群标签：背/腿/胸/臀部/二头/肩/三头/全身/腹部/拉伸
                                           -- 实测覆盖约 46%；为空则走本地规则
  exetype        TEXT,                     -- 【实测新增】服务端动作性质。N4 确认：仅 'cardio' 可用（→ is_cardio=1）；
                                           -- help/plus_weight/weight 语义未确认，只落库留证不参与计算
  single_side    INTEGER CHECK (single_side IN (0,1,NULL)),   -- full 模式独有
  rest_time_s    INTEGER,                  -- full 模式独有：组间休息（**疲劳代理指标之一**）
  warn_rest_time INTEGER,                  -- full 模式独有
  is_cardio      INTEGER NOT NULL DEFAULT 0 CHECK (is_cardio IN (0,1)),
  is_stretch     INTEGER NOT NULL DEFAULT 0 CHECK (is_stretch IN (0,1)),
  record_preset  TEXT,                     -- 有氧日 preset
  metrics_json   TEXT,                     -- distance/kcal/workoutTime/avgHeartRate/maxHeartRate
  items_json     TEXT,                     -- 超级组/递减组子动作原始结构
  notes          TEXT,                     -- full 模式独有：movement 级备注
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sm_server_type ON session_movement(server_type);
CREATE INDEX IF NOT EXISTS idx_sm_exetype     ON session_movement(exetype);
CREATE INDEX IF NOT EXISTS idx_sm_session  ON session_movement(session_id);
CREATE INDEX IF NOT EXISTS idx_sm_catalog  ON session_movement(catalog_id);
CREATE INDEX IF NOT EXISTS idx_sm_name     ON session_movement(name_norm);
CREATE INDEX IF NOT EXISTS idx_sm_resolve  ON session_movement(resolve_status);

CREATE TABLE IF NOT EXISTS movement_set (
  id                 INTEGER PRIMARY KEY,
  session_movement_id INTEGER NOT NULL REFERENCES session_movement(id) ON DELETE CASCADE,
  server_index       INTEGER,              -- 服务端 sets[].index（读侧单动作 ≤60 组，res.limits.maxSetsPerMove）
  ord                INTEGER NOT NULL,
  parent_set_id      INTEGER REFERENCES movement_set(id) ON DELETE CASCADE, -- 超级组子项
  done               INTEGER NOT NULL DEFAULT 1 CHECK (done IN (0,1)),      -- 未打勾组 = 0
  set_type           TEXT,                 -- 【实测新增】full 模式独有：'热'=热身组（实测 57/912），其余为空
  is_warmup          INTEGER NOT NULL DEFAULT 0 CHECK (is_warmup IN (0,1)), -- 由 set_type='热' 推导
  warmup_source      TEXT CHECK (warmup_source IN ('server_set_type','heuristic',NULL)),
  weight_kg          REAL,
  weight_unit        TEXT,                 -- 服务端 unit
  reps               INTEGER,
  rpe                REAL,                 -- full 模式独有；**实测填充率 0%**
  duration_s         INTEGER,
  time_s             INTEGER,              -- 服务端 time（实练秒数，**疲劳代理指标之一**）
  time_label         TEXT,                 -- 服务端 timeLabel
  left_weight_kg     REAL,                 -- full 模式独有：左侧重量（实测 0 例）
  is_self_weight     INTEGER CHECK (is_self_weight IN (0,1,NULL)), -- 服务端 selfWeight
  distance_m         REAL,
  kcal               REAL,
  avg_heart_rate     INTEGER,
  max_heart_rate     INTEGER,
  side               TEXT CHECK (side IN ('left','right',NULL)),
  note               TEXT,                 -- full 模式独有：set 级备注
  comment            TEXT,                 -- full 模式独有：完成感受
  raw_json           TEXT,                 -- 兜底：无法结构化的字段原样保留
  UNIQUE (session_movement_id, ord, parent_set_id)
);
CREATE INDEX IF NOT EXISTS idx_set_mv       ON movement_set(session_movement_id);
CREATE INDEX IF NOT EXISTS idx_set_done     ON movement_set(done);
CREATE INDEX IF NOT EXISTS idx_set_warmup   ON movement_set(is_warmup);
CREATE INDEX IF NOT EXISTS idx_set_set_type ON movement_set(set_type);

-- ---------- 3. 动作标准名与映射（R-04 核心） ----------
CREATE TABLE IF NOT EXISTS movement_catalog (
  id           INTEGER PRIMARY KEY,
  seq_no       INTEGER NOT NULL UNIQUE,    -- Xunji-movements 序号 1..1187
  name         TEXT NOT NULL UNIQUE,       -- 中文标准名（写回时只能用这一列）
  name_norm    TEXT NOT NULL,              -- 归一化名，用于匹配
  segment_code TEXT,                       -- 序号区间隐含分段提示：chest/back/leg_glute/shoulder/...（仅提示，非事实）
  is_cardio    INTEGER NOT NULL DEFAULT 0 CHECK (is_cardio IN (0,1)),
  is_stretch   INTEGER NOT NULL DEFAULT 0 CHECK (is_stretch IN (0,1)),
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_catalog_norm    ON movement_catalog(name_norm);
CREATE INDEX IF NOT EXISTS idx_catalog_segment ON movement_catalog(segment_code);

CREATE TABLE IF NOT EXISTS muscle_group (
  code        TEXT PRIMARY KEY,            -- 细分肌群码，见 §3.3
  name_zh     TEXT NOT NULL,
  parent_code TEXT,                        -- 粗粒度聚合父码（自引用，可为空）
  region      TEXT NOT NULL CHECK (region IN ('upper','lower','core','other')),
  size        TEXT NOT NULL CHECK (size IN ('large','small','other')),
  sort_no     INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (parent_code) REFERENCES muscle_group(code)
);

-- 【实测新增】服务端 movement.type 粗粒度标签 -> 本系统细分肌群码 的映射
-- 实测取值分布(214条): 空=114, 背=28, 腿=21, 胸=13, 臀部=11, 二头=10, 肩=8, 三头=4, 全身=3, 腹部=1, 拉伸=1
-- 注意：服务端是**粗粒度**（"肩"不区分前/中/后束），细分仍需本地关键词规则补充
CREATE TABLE IF NOT EXISTS server_type_map (
  server_type  TEXT PRIMARY KEY,           -- '背' / '腿' / '胸' / '臀部' / '二头' / '肩' / '三头' / '全身' / '腹部' / '拉伸'
  muscle_code  TEXT NOT NULL REFERENCES muscle_group(code),
  role         TEXT NOT NULL CHECK (role IN ('primary','secondary')),
  weight       REAL NOT NULL DEFAULT 1.0 CHECK (weight > 0 AND weight <= 1),
  pattern_hint TEXT CHECK (pattern_hint IN ('push','pull','squat','hinge','isolation','core','cardio','stretch',NULL)),
  note         TEXT,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS movement_muscle_map (
  id          INTEGER PRIMARY KEY,
  catalog_id  INTEGER NOT NULL REFERENCES movement_catalog(id) ON DELETE CASCADE,
  muscle_code TEXT NOT NULL REFERENCES muscle_group(code),
  role        TEXT NOT NULL CHECK (role IN ('primary','secondary')),
  weight      REAL NOT NULL DEFAULT 1.0 CHECK (weight > 0 AND weight <= 1),
  -- source 优先级（高->低）：manual > server > rule > segment
  source      TEXT NOT NULL CHECK (source IN ('manual','server','rule','segment','llm')),
  confidence  TEXT NOT NULL CHECK (confidence IN ('high','medium','low')),
  confirmed   INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0,1)),  -- 用户已确认
  updated_at  TEXT NOT NULL,
  UNIQUE (catalog_id, muscle_code, role)
);
CREATE INDEX IF NOT EXISTS idx_mmm_catalog ON movement_muscle_map(catalog_id);
CREATE INDEX IF NOT EXISTS idx_mmm_muscle  ON movement_muscle_map(muscle_code);
CREATE INDEX IF NOT EXISTS idx_mmm_conf    ON movement_muscle_map(confirmed, confidence);

CREATE TABLE IF NOT EXISTS movement_pattern_map (
  id         INTEGER PRIMARY KEY,
  catalog_id INTEGER NOT NULL REFERENCES movement_catalog(id) ON DELETE CASCADE,
  pattern    TEXT NOT NULL CHECK (pattern IN
              ('push','pull','squat','hinge','lunge','carry','isolation','core','cardio','stretch','other')),
  is_unilateral INTEGER NOT NULL DEFAULT 0 CHECK (is_unilateral IN (0,1)),
  source     TEXT NOT NULL CHECK (source IN ('manual','rule','segment')),
  confidence TEXT NOT NULL CHECK (confidence IN ('high','medium','low')),
  updated_at TEXT NOT NULL,
  UNIQUE (catalog_id, pattern)
);
CREATE INDEX IF NOT EXISTS idx_mpm_catalog ON movement_pattern_map(catalog_id);
CREATE INDEX IF NOT EXISTS idx_mpm_pattern ON movement_pattern_map(pattern);

CREATE TABLE IF NOT EXISTS movement_joint_flag (
  id          INTEGER PRIMARY KEY,
  catalog_id  INTEGER NOT NULL REFERENCES movement_catalog(id) ON DELETE CASCADE,
  joint_code  TEXT NOT NULL CHECK (joint_code IN ('lumbar','shoulder','knee','wrist','neck','hip','ankle')),
  stress_level INTEGER NOT NULL CHECK (stress_level BETWEEN 0 AND 3),  -- 0无 1低 2中 3高
  source      TEXT NOT NULL CHECK (source IN ('manual','rule')),
  updated_at  TEXT NOT NULL,
  UNIQUE (catalog_id, joint_code)
);
CREATE INDEX IF NOT EXISTS idx_mjf_catalog ON movement_joint_flag(catalog_id);
CREATE INDEX IF NOT EXISTS idx_mjf_joint   ON movement_joint_flag(joint_code, stress_level);

CREATE TABLE IF NOT EXISTS movement_alias (
  id         INTEGER PRIMARY KEY,
  alias_norm TEXT NOT NULL UNIQUE,         -- 训记里出现的非标准名
  catalog_id INTEGER NOT NULL REFERENCES movement_catalog(id) ON DELETE CASCADE,
  source     TEXT NOT NULL CHECK (source IN ('manual','auto')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alias_catalog ON movement_alias(catalog_id);

CREATE TABLE IF NOT EXISTS movement_unresolved (
  id           INTEGER PRIMARY KEY,
  name_raw     TEXT NOT NULL UNIQUE,
  name_norm    TEXT NOT NULL,
  hit_count    INTEGER NOT NULL DEFAULT 1,
  first_seen   TEXT NOT NULL,
  last_seen    TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','ignored')),
  resolved_catalog_id INTEGER REFERENCES movement_catalog(id) ON DELETE SET NULL,
  resolved_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_unres_status ON movement_unresolved(status, hit_count DESC);

-- ---------- 4. 目标与约束（R-07） ----------
CREATE TABLE IF NOT EXISTS user_goal (
  id                INTEGER PRIMARY KEY,
  goal_type         TEXT NOT NULL,          -- 'fatloss_keep_strength'|'hypertrophy'|'strength'|'general'
  sessions_per_week INTEGER NOT NULL CHECK (sessions_per_week BETWEEN 1 AND 7),
  min_duration_min  INTEGER NOT NULL CHECK (min_duration_min > 0),
  max_duration_min  INTEGER NOT NULL CHECK (max_duration_min >= min_duration_min),
  week_start_dow    INTEGER NOT NULL DEFAULT 1 CHECK (week_start_dow BETWEEN 0 AND 6), -- 0=周日
  preferred_dows    TEXT,                   -- JSON array，如 [1,3,5,0]；为空则系统自排
  notes             TEXT,
  is_active         INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  effective_from    TEXT NOT NULL,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_goal_active ON user_goal(is_active, effective_from DESC);

CREATE TABLE IF NOT EXISTS constraint_rule (
  id           INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('keep','avoid','dislike','limit_volume','limit_load')),
  target_type  TEXT NOT NULL CHECK (target_type IN ('movement','muscle','pattern','joint')),
  target_value TEXT NOT NULL,               -- catalog_id / muscle_code / pattern / joint_code
  severity     TEXT NOT NULL CHECK (severity IN ('hard','soft')),
  param_json   TEXT,                        -- limit_* 的阈值，如 {"max_sets_per_week": 12}
  reason       TEXT,                        -- "腰椎避免高压"、"肩部不适"
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cr_active ON constraint_rule(is_active, kind);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cr_target ON constraint_rule(kind, target_type, target_value)
  WHERE is_active = 1;

-- ---------- 5. 分析结果（第2层数据） ----------
CREATE TABLE IF NOT EXISTS analysis_report (
  id            INTEGER PRIMARY KEY,
  window_start  TEXT NOT NULL,
  window_end    TEXT NOT NULL,
  window_preset TEXT NOT NULL CHECK (window_preset IN ('w12','w26','w4','last','custom')),
  params_json   TEXT NOT NULL,              -- 口径版本、阈值快照、肌群字典版本
  payload_json  TEXT NOT NULL,              -- 完整 AnalysisReport（不可变）
  payload_hash  TEXT NOT NULL,              -- sha256，用于判定是否需重新生成 AI 计划
  schema_version TEXT NOT NULL DEFAULT '1.0',
  generated_at  TEXT NOT NULL,
  job_run_id    INTEGER REFERENCES job_run(id) ON DELETE SET NULL,
  kind          TEXT NOT NULL DEFAULT 'adhoc' CHECK (kind IN ('snapshot','adhoc')),
  version_no    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ar_window ON analysis_report(window_end DESC, window_preset);
CREATE INDEX IF NOT EXISTS idx_ar_hash   ON analysis_report(payload_hash);
CREATE INDEX IF NOT EXISTS idx_ar_kind   ON analysis_report(kind, generated_at DESC);

CREATE TABLE IF NOT EXISTS analysis_finding (
  id          INTEGER PRIMARY KEY,
  report_id   INTEGER NOT NULL REFERENCES analysis_report(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,                -- 'R-AG-01' 等
  severity    TEXT NOT NULL CHECK (severity IN ('info','warn','high')),
  title       TEXT NOT NULL,
  detail      TEXT NOT NULL,                -- 面向用户的一句话
  evidence_json TEXT NOT NULL,              -- 量化证据 {metric, value, baseline, window, compare}
  suggestion  TEXT,
  sort_no     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_af_report ON analysis_finding(report_id, severity, sort_no);
CREATE INDEX IF NOT EXISTS idx_af_code   ON analysis_finding(code);

-- ---------- 6. 计划（第3层数据） ----------
CREATE TABLE IF NOT EXISTS plan (
  id           INTEGER PRIMARY KEY,
  week_start   TEXT NOT NULL,
  week_end     TEXT NOT NULL,
  version_no   INTEGER NOT NULL DEFAULT 1,
  parent_plan_id INTEGER REFERENCES plan(id) ON DELETE SET NULL,
  status       TEXT NOT NULL CHECK (status IN
                ('draft','approved','writing','written','partial','failed','archived','cancelled')),
  source       TEXT NOT NULL CHECK (source IN ('ai','manual','rule_fallback','adjust')),
  ai_model_tag TEXT,                        -- 'http:<model>' | 'rule_fallback'
  goal_id      INTEGER REFERENCES user_goal(id) ON DELETE SET NULL,
  report_id    INTEGER REFERENCES analysis_report(id) ON DELETE SET NULL,
  summary_json TEXT,                        -- 计划级总量：总组数、肌群分布、预计总时长
  warnings_json TEXT,                       -- 熔断放行的告警：[{code, datestr, value, range, message}]
  ai_attempts  INTEGER NOT NULL DEFAULT 0,  -- 本次生成实际尝试次数（用于审计与调 prompt）
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  approved_at  TEXT,
  confirmed_at TEXT,
  UNIQUE (week_start, version_no)
);
CREATE INDEX IF NOT EXISTS idx_plan_status ON plan(status, week_start DESC);
CREATE INDEX IF NOT EXISTS idx_plan_week   ON plan(week_start DESC);

CREATE TABLE IF NOT EXISTS plan_day (
  id                INTEGER PRIMARY KEY,
  plan_id           INTEGER NOT NULL REFERENCES plan(id) ON DELETE CASCADE,
  datestr           TEXT NOT NULL,
  dow               INTEGER NOT NULL CHECK (dow BETWEEN 0 AND 6),
  ord               INTEGER NOT NULL,
  day_type          TEXT,                   -- '下肢力量'|'上肢推'|'上肢拉'|'全身'|'有氧'|'休息'
  title             TEXT NOT NULL,
  target_muscles_json TEXT,                 -- ["legs","glutes"]
  est_duration_min  INTEGER,
  est_sets          INTEGER,
  why_json          TEXT,                   -- 该训练日的解释（含 evidence 引用）
  lock_state        TEXT NOT NULL DEFAULT 'planned'
                    CHECK (lock_state IN ('planned','done','locked','skipped')),
  localid           TEXT,                   -- 写入训记后回填
  write_status      TEXT CHECK (write_status IN ('pending','dry_run_ok','success','failed',NULL)),
  UNIQUE (plan_id, datestr)
);
CREATE INDEX IF NOT EXISTS idx_pd_plan  ON plan_day(plan_id, ord);
CREATE INDEX IF NOT EXISTS idx_pd_date  ON plan_day(datestr);

CREATE TABLE IF NOT EXISTS plan_exercise (
  id           INTEGER PRIMARY KEY,
  plan_day_id  INTEGER NOT NULL REFERENCES plan_day(id) ON DELETE CASCADE,
  ord          INTEGER NOT NULL,
  catalog_id   INTEGER REFERENCES movement_catalog(id) ON DELETE SET NULL,
  name         TEXT NOT NULL,               -- 必须为中文标准名
  sets         INTEGER NOT NULL CHECK (sets > 0 AND sets <= 20),
  reps         INTEGER,                     -- 力量用次数
  weight_kg    REAL,
  weight_source TEXT CHECK (weight_source IN ('history_best','history_avg','estimate','user_input',NULL)),
  rpe          REAL CHECK (rpe IS NULL OR (rpe >= 1 AND rpe <= 10)),
                                           -- ⚠️ 已弃用（PRD-v2 §11.4 决策 A：AI 不给 RPE）。
                                           -- 列保留仅为免迁移；新行恒为 NULL，读写链路已全部移除。
  rest_s       INTEGER,
  duration_s   INTEGER,                     -- 有氧/计时动作
  is_cardio    INTEGER NOT NULL DEFAULT 0 CHECK (is_cardio IN (0,1)),
  record_preset TEXT,
  metrics_json TEXT,
  est_duration_min REAL,
  why_json     TEXT,                        -- 单动作级解释
  source       TEXT NOT NULL DEFAULT 'ai' CHECK (source IN ('ai','manual','user_keep')),
  UNIQUE (plan_day_id, ord)
);
CREATE INDEX IF NOT EXISTS idx_pe_day     ON plan_exercise(plan_day_id, ord);
CREATE INDEX IF NOT EXISTS idx_pe_catalog ON plan_exercise(catalog_id);

CREATE TABLE IF NOT EXISTS plan_edit_log (
  id          INTEGER PRIMARY KEY,
  plan_id     INTEGER NOT NULL REFERENCES plan(id) ON DELETE CASCADE,
  actor       TEXT NOT NULL CHECK (actor IN ('user','ai','system')),
  action      TEXT NOT NULL CHECK (action IN ('create','update','delete','reorder','adjust','regenerate')),
  target_type TEXT NOT NULL CHECK (target_type IN ('plan','day','exercise')),
  target_id   INTEGER,
  field       TEXT,
  before_json TEXT,
  after_json  TEXT,
  instruction TEXT,                         -- AI 调整时的原始指令
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pel_plan ON plan_edit_log(plan_id, created_at DESC);

-- ---------- 7. 写入任务与结果（R-12） ----------
CREATE TABLE IF NOT EXISTS sync_write_job (
  id             INTEGER PRIMARY KEY,
  plan_id        INTEGER NOT NULL REFERENCES plan(id) ON DELETE CASCADE,
  status         TEXT NOT NULL CHECK (status IN
                  ('pending','dry_running','awaiting_confirm','writing','success','partial','failed','cancelled')),
  total_batches  INTEGER NOT NULL DEFAULT 0,
  finished_batches INTEGER NOT NULL DEFAULT 0,
  dry_run_result_json TEXT,
  created_at     TEXT NOT NULL,
  approved_at    TEXT,
  started_at     TEXT,
  finished_at    TEXT,
  error_json     TEXT
);
CREATE INDEX IF NOT EXISTS idx_swj_plan   ON sync_write_job(plan_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_swj_status ON sync_write_job(status);

CREATE TABLE IF NOT EXISTS write_batch (
  id                INTEGER PRIMARY KEY,
  job_id            INTEGER NOT NULL REFERENCES sync_write_job(id) ON DELETE CASCADE,
  batch_no          INTEGER NOT NULL,
  datestr           TEXT NOT NULL,            -- 同一批必须同一天
  client_request_id TEXT NOT NULL UNIQUE,     -- 幂等键
  status            TEXT NOT NULL CHECK (status IN
                     ('pending','dry_run','dry_run_ok','success','failed','skipped')),
  train_count       INTEGER NOT NULL CHECK (train_count > 0 AND train_count <= 4),
  request_json      TEXT NOT NULL,            -- 脱敏后的请求体（供审计/重试）
  response_json     TEXT,
  error_code        TEXT,
  error_msg         TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  finished_at       TEXT,
  UNIQUE (job_id, batch_no)
);
CREATE INDEX IF NOT EXISTS idx_wb_job ON write_batch(job_id, batch_no);

CREATE TABLE IF NOT EXISTS write_item (
  id               INTEGER PRIMARY KEY,
  batch_id         INTEGER NOT NULL REFERENCES write_batch(id) ON DELETE CASCADE,
  plan_day_id      INTEGER NOT NULL REFERENCES plan_day(id) ON DELETE CASCADE,
  ord              INTEGER NOT NULL,
  action           TEXT NOT NULL CHECK (action IN ('create','update')),
  localid_before   TEXT,
  localid_after    TEXT,
  result           TEXT CHECK (result IN ('success','failed',NULL)),
  message          TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wi_batch ON write_item(batch_id);
CREATE INDEX IF NOT EXISTS idx_wi_day   ON write_item(plan_day_id);

-- ---------- 8. 周期总结（R-14） ----------
CREATE TABLE IF NOT EXISTS review (
  id              INTEGER PRIMARY KEY,
  period_start    TEXT NOT NULL,
  period_end      TEXT NOT NULL,
  plan_id_anchor  INTEGER REFERENCES plan(id) ON DELETE SET NULL,
  data_summary_json TEXT NOT NULL,           -- 次数/完成率/训练量变化/动作进步
  ai_summary_json TEXT,                      -- {strengths, issues, suggestions}
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','done','failed')),
  ai_model_tag    TEXT,
  generated_at    TEXT NOT NULL,
  UNIQUE (period_start, period_end)
);
CREATE INDEX IF NOT EXISTS idx_review_period ON review(period_end DESC);

-- ---------- 9. 任务调度与同步状态 ----------
CREATE TABLE IF NOT EXISTS job_run (
  id           INTEGER PRIMARY KEY,
  job_type     TEXT NOT NULL CHECK (job_type IN
                ('sync_full','sync_incremental','sync_retry','analysis_refresh',
                 'plan_draft','plan_adjust','review_generate','db_backup','catalog_import')),
  status       TEXT NOT NULL CHECK (status IN
                ('pending','running','awaiting_agent','paused','success','partial','failed','cancelled')),
  triggered_by TEXT NOT NULL CHECK (triggered_by IN ('auto','manual','catchup','startup')),
  scheduled_at TEXT,
  started_at   TEXT,
  finished_at  TEXT,
  progress_json TEXT,                         -- {total, done, failed, current, eta_seconds, message}
  params_json  TEXT,
  result_ref   TEXT,                          -- 'plan:12' / 'report:34' / 'review:5'
  error_json   TEXT,
  awaiting_agent INTEGER NOT NULL DEFAULT 0 CHECK (awaiting_agent IN (0,1))
);
CREATE INDEX IF NOT EXISTS idx_jr_type_status ON job_run(job_type, status, scheduled_at DESC);
CREATE INDEX IF NOT EXISTS idx_jr_status      ON job_run(status, started_at DESC);

CREATE TABLE IF NOT EXISTS sync_date_state (
  datestr         TEXT PRIMARY KEY,
  status          TEXT NOT NULL CHECK (status IN ('pending','fetching','done','empty','failed','skipped')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  last_success_at TEXT,
  next_retry_at   TEXT,
  content_hash    TEXT,
  session_count   INTEGER NOT NULL DEFAULT 0,
  error_code      TEXT,
  error_msg       TEXT
);
CREATE INDEX IF NOT EXISTS idx_sds_status ON sync_date_state(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_sds_retry  ON sync_date_state(next_retry_at);
`;

export interface Migration {
  version: number;
  name: string;
  sql: string;
  /** 事务外执行的前置语句（PRAGMA 不能在事务内生效，如 foreign_keys=OFF）。 */
  preSql?: string;
  /** 事务提交后执行的后置语句（finally 语义：失败回滚后也会执行）。 */
  postSql?: string;
}

/**
 * V3：写回三态语义——为 plan / plan_day / sync_write_job / write_batch / write_item
 * 的状态 CHECK 约束增加 'uncertain'。
 *
 * 依据（2026-09-30 实测， probe 报告误判修正）：
 *   - 实写成功响应 res.trains 恒为空数组（不回显），与限频静默丢弃的空响应不可区分；
 *   - 旧三态（success/failed/partial）会把「结果未知」误判为 failed，诱发危险的重写（重复计划）；
 *   - 新增 uncertain：写响应为空 → full 读回验证 → 命中=success / 无记录=failed /
 *     读回不可定（限频/异常）=uncertain（人工到 App 核实，绝不自动重写）。
 *
 * 重建顺序：父表先建先换（FK 在 preSql 中关闭，COMMIT 后恢复）。
 */
const SCHEMA_V3_UNCERTAIN_STATUS = `
CREATE TABLE plan_v3 (
  id           INTEGER PRIMARY KEY,
  week_start   TEXT NOT NULL,
  week_end     TEXT NOT NULL,
  version_no   INTEGER NOT NULL DEFAULT 1,
  parent_plan_id INTEGER REFERENCES plan(id) ON DELETE SET NULL,
  status       TEXT NOT NULL CHECK (status IN
              ('draft','approved','writing','written','partial','failed','uncertain','archived','cancelled')),
  source       TEXT NOT NULL CHECK (source IN ('ai','manual','rule_fallback','adjust')),
  ai_model_tag TEXT,
  goal_id      INTEGER REFERENCES user_goal(id) ON DELETE SET NULL,
  report_id    INTEGER REFERENCES analysis_report(id) ON DELETE SET NULL,
  summary_json TEXT,
  warnings_json TEXT,
  ai_attempts  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  approved_at  TEXT,
  confirmed_at TEXT,
  UNIQUE (week_start, version_no)
);
INSERT INTO plan_v3 (id, week_start, week_end, version_no, parent_plan_id, status, source, ai_model_tag,
                     goal_id, report_id, summary_json, warnings_json, ai_attempts,
                     created_at, updated_at, approved_at, confirmed_at)
  SELECT id, week_start, week_end, version_no, parent_plan_id, status, source, ai_model_tag,
         goal_id, report_id, summary_json, warnings_json, ai_attempts,
         created_at, updated_at, approved_at, confirmed_at FROM plan;
DROP TABLE plan;
ALTER TABLE plan_v3 RENAME TO plan;
CREATE INDEX IF NOT EXISTS idx_plan_status ON plan(status, week_start DESC);
CREATE INDEX IF NOT EXISTS idx_plan_week   ON plan(week_start DESC);

CREATE TABLE plan_day_v3 (
  id                INTEGER PRIMARY KEY,
  plan_id           INTEGER NOT NULL REFERENCES plan(id) ON DELETE CASCADE,
  datestr           TEXT NOT NULL,
  dow               INTEGER NOT NULL CHECK (dow BETWEEN 0 AND 6),
  ord               INTEGER NOT NULL,
  day_type          TEXT,
  title             TEXT NOT NULL,
  target_muscles_json TEXT,
  est_duration_min  INTEGER,
  est_sets          INTEGER,
  why_json          TEXT,
  lock_state        TEXT NOT NULL DEFAULT 'planned'
                    CHECK (lock_state IN ('planned','done','locked','skipped')),
  localid           TEXT,
  write_status      TEXT CHECK (write_status IN ('pending','dry_run_ok','success','failed','uncertain',NULL)),
  UNIQUE (plan_id, datestr)
);
INSERT INTO plan_day_v3 (id, plan_id, datestr, dow, ord, day_type, title, target_muscles_json,
                         est_duration_min, est_sets, why_json, lock_state, localid, write_status)
  SELECT id, plan_id, datestr, dow, ord, day_type, title, target_muscles_json,
         est_duration_min, est_sets, why_json, lock_state, localid, write_status FROM plan_day;
DROP TABLE plan_day;
ALTER TABLE plan_day_v3 RENAME TO plan_day;
CREATE INDEX IF NOT EXISTS idx_pd_plan ON plan_day(plan_id, ord);
CREATE INDEX IF NOT EXISTS idx_pd_date ON plan_day(datestr);

CREATE TABLE sync_write_job_v3 (
  id             INTEGER PRIMARY KEY,
  plan_id        INTEGER NOT NULL REFERENCES plan(id) ON DELETE CASCADE,
  status         TEXT NOT NULL CHECK (status IN
                ('pending','dry_running','awaiting_confirm','writing','success','partial','failed','uncertain','cancelled')),
  total_batches  INTEGER NOT NULL DEFAULT 0,
  finished_batches INTEGER NOT NULL DEFAULT 0,
  dry_run_result_json TEXT,
  created_at     TEXT NOT NULL,
  approved_at    TEXT,
  started_at     TEXT,
  finished_at    TEXT,
  error_json     TEXT
);
INSERT INTO sync_write_job_v3 (id, plan_id, status, total_batches, finished_batches, dry_run_result_json,
                               created_at, approved_at, started_at, finished_at, error_json)
  SELECT id, plan_id, status, total_batches, finished_batches, dry_run_result_json,
         created_at, approved_at, started_at, finished_at, error_json FROM sync_write_job;
DROP TABLE sync_write_job;
ALTER TABLE sync_write_job_v3 RENAME TO sync_write_job;
CREATE INDEX IF NOT EXISTS idx_swj_plan   ON sync_write_job(plan_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_swj_status ON sync_write_job(status);

CREATE TABLE write_batch_v3 (
  id                INTEGER PRIMARY KEY,
  job_id            INTEGER NOT NULL REFERENCES sync_write_job(id) ON DELETE CASCADE,
  batch_no          INTEGER NOT NULL,
  datestr           TEXT NOT NULL,
  -- v3 变更：原 UNIQUE 降级为普通索引。幂等键内容不变（重试/重新预演同意图），
  -- uncertain 作业保留审计时重新预演会生成同键批次——跨作业唯一会阻断合法重演，
  -- 服务端按 client_request_id 去重才是幂等的真正执行点。
  client_request_id TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN
                   ('pending','dry_run','dry_run_ok','success','failed','uncertain','skipped')),
  train_count       INTEGER NOT NULL CHECK (train_count > 0 AND train_count <= 4),
  request_json      TEXT NOT NULL,
  response_json     TEXT,
  error_code        TEXT,
  error_msg         TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  finished_at       TEXT,
  UNIQUE (job_id, batch_no)
);
INSERT INTO write_batch_v3 (id, job_id, batch_no, datestr, client_request_id, status, train_count,
                            request_json, response_json, error_code, error_msg, attempts, created_at, finished_at)
  SELECT id, job_id, batch_no, datestr, client_request_id, status, train_count,
         request_json, response_json, error_code, error_msg, attempts, created_at, finished_at FROM write_batch;
DROP TABLE write_batch;
ALTER TABLE write_batch_v3 RENAME TO write_batch;
CREATE INDEX IF NOT EXISTS idx_wb_job ON write_batch(job_id, batch_no);
CREATE INDEX IF NOT EXISTS idx_wb_req ON write_batch(client_request_id);

CREATE TABLE write_item_v3 (
  id               INTEGER PRIMARY KEY,
  batch_id         INTEGER NOT NULL REFERENCES write_batch(id) ON DELETE CASCADE,
  plan_day_id      INTEGER NOT NULL REFERENCES plan_day(id) ON DELETE CASCADE,
  ord              INTEGER NOT NULL,
  action           TEXT NOT NULL CHECK (action IN ('create','update')),
  localid_before   TEXT,
  localid_after    TEXT,
  result           TEXT CHECK (result IN ('success','failed','uncertain',NULL)),
  message          TEXT,
  created_at       TEXT NOT NULL
);
INSERT INTO write_item_v3 (id, batch_id, plan_day_id, ord, action, localid_before, localid_after, result, message, created_at)
  SELECT id, batch_id, plan_day_id, ord, action, localid_before, localid_after, result, message, created_at FROM write_item;
DROP TABLE write_item;
ALTER TABLE write_item_v3 RENAME TO write_item;
CREATE INDEX IF NOT EXISTS idx_wi_batch ON write_item(batch_id);
CREATE INDEX IF NOT EXISTS idx_wi_day   ON write_item(plan_day_id);
`;

/**
 * V2：重建 server_type_map 为复合主键（server_type, muscle_code）。
 *
 * 依据（2026-09-29 N1 实测，按「实测事实 > 架构定稿」裁决）：
 *   - v1 的 server_type 单列主键无法承载架构 §3.4 seed 的拆分映射
 *     （"背"→上背 0.5 + 背阔 0.5、"腿"→三行、"肩"→两行）；
 *   - pattern_hint 的 CHECK 缺 'lunge'/'carry'（KR-016 保加利亚蹲 / KR-017 农夫行走需要）；
 *   - 当前生产库该表为空（T2 才首次导入），重建零数据风险。
 */
const SCHEMA_V2_SERVER_TYPE_MAP = `
CREATE TABLE server_type_map_v2 (
  server_type  TEXT NOT NULL,
  muscle_code  TEXT NOT NULL REFERENCES muscle_group(code),
  role         TEXT NOT NULL CHECK (role IN ('primary','secondary')),
  weight       REAL NOT NULL DEFAULT 1.0 CHECK (weight > 0 AND weight <= 1),
  pattern_hint TEXT CHECK (pattern_hint IN
              ('push','pull','squat','hinge','lunge','carry','isolation','core','cardio','stretch','other',NULL)),
  note         TEXT,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (server_type, muscle_code)
);
INSERT INTO server_type_map_v2
  SELECT server_type, muscle_code, role, weight, pattern_hint, note, updated_at FROM server_type_map;
DROP TABLE server_type_map;
ALTER TABLE server_type_map_v2 RENAME TO server_type_map;
`;

/**
 * v4：训练周期（PRD-v2 §5 / §10.3 V2）。
 *
 * 周期 = 4 周（3 周渐进 + 第 4 周减量）。周期目标（如「着重练胸」）在周期内**锁定不可改**，
 * 唯一修改入口是设置页的「强行修改」（会留 force_edited_at 痕，频改等于没目标）。
 *
 * 🔴 与 `user_goal.goal_type` 的语义区别（别混名）：
 *   - `user_goal.goal_type` = **长期方向**（减脂保肌 / 增肌 / 力量提升），背景参考；
 *   - `training_cycle.goal_text` = **这 4 周的焦点**（着重练胸），优先级更高。
 *   两者都进 AI 输入，但优先级不同。
 *
 * 「本周是第 N/4 周」「本周是否减量周」都由 `week_start` 与 `first_week_start` 现算
 * （日期差 / 7 + 1），不落冗余列 —— 周期一旦重开，冗余列必错。
 */
const SCHEMA_V4_TRAINING_CYCLE = `
CREATE TABLE IF NOT EXISTS training_cycle (
  id               INTEGER PRIMARY KEY,
  cycle_no         INTEGER NOT NULL,        -- 第几个周期（从 1 起，仅作展示与追溯）
  first_week_start TEXT NOT NULL,           -- 第 1 周的 week_start（跟随 user_goal.week_start_dow）
  last_week_start  TEXT NOT NULL,           -- 第 4 周的 week_start
  goal_text        TEXT NOT NULL,           -- 周期目标（这 4 周的焦点）
  status           TEXT NOT NULL CHECK (status IN ('active','closed')),
  force_edited_at  TEXT,                    -- 「强行修改」留痕；非空 = 这个周期被改过目标
  created_at       TEXT NOT NULL,
  closed_at        TEXT,
  UNIQUE (first_week_start)
);
CREATE INDEX IF NOT EXISTS idx_cycle_status ON training_cycle(status, first_week_start DESC);
`;

/**
 * v5：日感受 + 周复盘（PRD-v2 §10.3 V8）。
 *
 * **为什么不复用 `review` 表**：`review` 是「4 周周期总结」（`UNIQUE(period_start, period_end)`），
 * 周复盘的周期是 1 周，两者的输入口径与输出结构都不同。塞进一张表要靠 kind 列区分，
 * 查询与唯一约束都变绕，不如分表。
 *
 * `daily_note`：
 *   - 每日期一行（`datestr` 主键），**用户自己写的主观感受**，只存在本地库，
 *     **不同步回训记**（§6 决策 1）。
 *   - ⚠️ 与 `train_session.note` 语义完全不同：后者实测 91% 有值，但内容是
 *     `calorie:284` 这类**训记自动写入的卡路里**，不是人的感受（旧版曾把它当主观信号，属数据误用）。
 *
 * `weekly_review`：
 *   - 一周一行。`data_summary_json` 由本地确定性算（完成率等），`ai_summary_json` 是 AI 的**简短**结论。
 *   - `status='draft'` = 只有数据部分（AI 不可用/失败），可重试；数据永远可信。
 */
const SCHEMA_V5_DAILY_NOTE_WEEKLY_REVIEW = `
CREATE TABLE IF NOT EXISTS daily_note (
  datestr    TEXT PRIMARY KEY,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS weekly_review (
  id                INTEGER PRIMARY KEY,
  week_start        TEXT NOT NULL,
  week_end          TEXT NOT NULL,
  data_summary_json TEXT NOT NULL,
  ai_summary_json   TEXT,
  status            TEXT NOT NULL CHECK (status IN ('done','draft')),
  ai_model_tag      TEXT,
  generated_at      TEXT NOT NULL,
  UNIQUE (week_start)
);
CREATE INDEX IF NOT EXISTS idx_wrev_end ON weekly_review(week_end DESC);
`;

/**
 * v6：体重记录（PRD-v2 §10.3 V9）。
 *
 * 只建「体重」一列，因为 PRD 现在只要体重（手动输入 + 趋势图）。刻意做成**一行一天**的
 * 时序表而不是 `app_config` 里的 JSON 数组：
 *   1) 趋势图要按日期取连续序列，SQL 一句拿到，不用把整段 JSON 拉出来解析；
 *   2) 同一天改体重是**高频动作**（早上量、晚上复量），JSON 数组的读-改-写会在并发下丢数据；
 *   3) 以后要加体脂/腰围，加列即可，不用改序列化格式。
 *
 * ⚠️ 旧伤 / 基础疾病**不在这张表**：它是一段长期有效的自由文本，没有时序含义。
 *    存在 `app_config['body_info']`（见 `server/body/bodyService.ts`）。
 */
const SCHEMA_V6_WEIGHT_LOG = `
CREATE TABLE IF NOT EXISTS weight_log (
  datestr    TEXT PRIMARY KEY,          -- YYYY-MM-DD，一行一天，同日覆写
  weight_kg  REAL NOT NULL CHECK (weight_kg > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/**
 * V7：计划周特殊情况 `week_note`（2026-09-30 用户定案）。
 *
 * 与 `daily_note` 是**两个不同的东西**，所以是两张表而不是一张：
 *   - `week_note`：**排计划**输入，一句话描述这一周的特殊情况（经期 / 临时不适）。
 *     它是摘要层的 `week.special_note`，优先级高于周期目标。
 *   - `daily_note`：**复盘**用的逐日感受，只喂周复盘 AI。
 * 按 `week_start` 一行一周（不是按日期），旧周不删 —— 回看历史生成时还要用。
 */
const SCHEMA_V7_WEEK_NOTE = `
CREATE TABLE IF NOT EXISTS week_note (
  week_start TEXT PRIMARY KEY,          -- YYYY-MM-DD，= 计划周起点
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/**
 * v8：标记这份计划是不是「沿用周期模板」来的（2026-09-30「周期内同一个模板」）。
 *
 * 为什么要落库而不是读取时现算：控制它的两个因素（用户有没有点「重新全量生成」、
 * 生成那一刻上一周的计划在不在）事后都不可重建 —— 现算只能猜。
 * 存**来源周次**（1~4）而不是布尔：界面上要写「基于周期第 2 周模板调整」，布尔说不出来；
 * NULL = 全量生成（第 1 周、模板缺失、用户显式重新全量）。
 */
const SCHEMA_V8_PLAN_TEMPLATE_WEEK = `
ALTER TABLE plan ADD COLUMN template_week_no INTEGER;
`;

/**
 * v9：analysis_report 支持「窗口改半年（26 周）」+ 画像版本化（2026-10 窗口 12→26 定案）。
 *
 * 三处形状变化：
 *   1. window_preset 的 CHECK 增加 'w26'（旧行仍是 'w12'，保留不动）；
 *   2. kind：区分「周期末快照 snapshot」与「排计划/手动现算 adhoc」，旧行统一补 'adhoc'；
 *   3. version_no：画像版本号（旧行 NULL）。
 *
 * SQLite 不能改 CHECK 约束 → 走官方 12 步表重建。⚠️ preSql 关 FK 是**必须**的：
 * DROP TABLE analysis_report 在 FK 打开时会触发 analysis_finding 的
 * ON DELETE CASCADE，把全部 findings 一起删掉。
 */
const SCHEMA_V9_ANALYSIS_REPORT_REBUILD = `
CREATE TABLE analysis_report_new (
  id            INTEGER PRIMARY KEY,
  window_start  TEXT NOT NULL,
  window_end    TEXT NOT NULL,
  window_preset TEXT NOT NULL CHECK (window_preset IN ('w12','w26','w4','last','custom')),
  params_json   TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  payload_hash  TEXT NOT NULL,
  schema_version TEXT NOT NULL DEFAULT '1.0',
  generated_at  TEXT NOT NULL,
  job_run_id    INTEGER REFERENCES job_run(id) ON DELETE SET NULL,
  kind          TEXT NOT NULL DEFAULT 'adhoc' CHECK (kind IN ('snapshot','adhoc')),
  version_no    INTEGER
);
INSERT INTO analysis_report_new
  (id, window_start, window_end, window_preset, params_json, payload_json, payload_hash, schema_version, generated_at, job_run_id, kind, version_no)
  SELECT id, window_start, window_end, window_preset, params_json, payload_json, payload_hash, schema_version, generated_at, job_run_id, 'adhoc', NULL
  FROM analysis_report;
DROP TABLE analysis_report;
ALTER TABLE analysis_report_new RENAME TO analysis_report;
CREATE INDEX IF NOT EXISTS idx_ar_window ON analysis_report(window_end DESC, window_preset);
CREATE INDEX IF NOT EXISTS idx_ar_hash   ON analysis_report(payload_hash);
CREATE INDEX IF NOT EXISTS idx_ar_kind   ON analysis_report(kind, generated_at DESC);
`;

/**
 * v10：job_run.job_type 的 CHECK 增加 'report_prune'（历史分析报告清理任务）。
 *
 * 为什么必须建迁移而不是只改 TS 联合类型：`job_run.job_type` 有 CHECK 白名单，
 * JobRunner 对 `ownsJobRun:false` 的任务会先 INSERT 一行 job_run（拿到 id 再执行）。
 * 白名单不放行 'report_prune' → INSERT 直接违反 CHECK 抛错，而且抛出点在 runner 的
 * try 之外，enqueue 的 Promise 永不 resolve（静默挂死）。SQLite 改不了 CHECK，
 * 走官方 12 步表重建。
 *
 * FK：analysis_report.job_run_id → job_run(id) ON DELETE SET NULL。DROP 父表在 FK 打开时
 * 会把引用行的 job_run_id 置空 —— 那是溯源字段，置空可接受，但为避免重建期间触发级联，
 * 仍按 v3/v9 的惯例在事务外关 FK。
 */
const SCHEMA_V10_JOB_RUN_REPORT_PRUNE = `
CREATE TABLE job_run_v10 (
  id           INTEGER PRIMARY KEY,
  job_type     TEXT NOT NULL CHECK (job_type IN
                ('sync_full','sync_incremental','sync_retry','analysis_refresh',
                 'plan_draft','plan_adjust','review_generate','db_backup','catalog_import',
                 'report_prune')),
  status       TEXT NOT NULL CHECK (status IN
                ('pending','running','awaiting_agent','paused','success','partial','failed','cancelled')),
  triggered_by TEXT NOT NULL CHECK (triggered_by IN ('auto','manual','catchup','startup')),
  scheduled_at TEXT,
  started_at   TEXT,
  finished_at  TEXT,
  progress_json TEXT,
  params_json  TEXT,
  result_ref   TEXT,
  error_json   TEXT,
  awaiting_agent INTEGER NOT NULL DEFAULT 0 CHECK (awaiting_agent IN (0,1))
);
INSERT INTO job_run_v10
  (id, job_type, status, triggered_by, scheduled_at, started_at, finished_at,
   progress_json, params_json, result_ref, error_json, awaiting_agent)
  SELECT id, job_type, status, triggered_by, scheduled_at, started_at, finished_at,
         progress_json, params_json, result_ref, error_json, awaiting_agent
  FROM job_run;
DROP TABLE job_run;
ALTER TABLE job_run_v10 RENAME TO job_run;
CREATE INDEX IF NOT EXISTS idx_jr_type_status ON job_run(job_type, status, scheduled_at DESC);
CREATE INDEX IF NOT EXISTS idx_jr_status      ON job_run(status, started_at DESC);
`;

/** 迁移清单：按版本升序追加，禁止修改已发布版本。 */
export const MIGRATIONS: Migration[] = [  {
    version: 1,
    name: 'initial schema v1（§3.2 完整 DDL）',
    sql: SCHEMA_V1_DDL,
  },
  {
    version: 2,
    name: 'server_type_map 复合主键重建（N1 实测：拆分映射需每 type 多行）',
    sql: SCHEMA_V2_SERVER_TYPE_MAP,
  },
  {
    version: 3,
    name: '写回三态语义：全链路状态 CHECK 增加 uncertain（2026-09-30 实写空响应实测）',
    sql: SCHEMA_V3_UNCERTAIN_STATUS,
    preSql: 'PRAGMA foreign_keys = OFF;',
    postSql: 'PRAGMA foreign_keys = ON;',
  },
  {
    version: 4,
    name: '训练周期 training_cycle（PRD-v2 §5：4 周 = 3 周渐进 + 1 周减量，周期目标周期内锁定）',
    sql: SCHEMA_V4_TRAINING_CYCLE,
  },
  {
    version: 5,
    name: '日感受 daily_note + 周复盘 weekly_review（PRD-v2 §10.3 V8）',
    sql: SCHEMA_V5_DAILY_NOTE_WEEKLY_REVIEW,
  },
  {
    version: 6,
    name: '体重记录 weight_log（PRD-v2 §10.3 V9：手动输入 + 趋势图）',
    sql: SCHEMA_V6_WEIGHT_LOG,
  },
  {
    version: 7,
    name: '计划周特殊情况 week_note（排计划最高优先级输入，与复盘用的 daily_note 分表）',
    sql: SCHEMA_V7_WEEK_NOTE,
  },
  {
    version: 8,
    name: 'plan.template_week_no（周期内沿用上一周模板的来源周次；NULL = 全量生成）',
    sql: SCHEMA_V8_PLAN_TEMPLATE_WEEK,
  },
  {
    version: 9,
    name: 'analysis_report：preset 增加 w26 + kind(snapshot/adhoc) + version_no（画像版本化，"窗口改半年"）',
    sql: SCHEMA_V9_ANALYSIS_REPORT_REBUILD,
    preSql: 'PRAGMA foreign_keys = OFF;',   // 必须：DROP TABLE 在 FK 打开时会触发 analysis_finding 的 ON DELETE CASCADE，把 findings 一起删掉
    postSql: 'PRAGMA foreign_keys = ON;',
  },
  {
    version: 10,
    name: "job_run.job_type 允许 'report_prune'（历史分析报告清理任务）",
    sql: SCHEMA_V10_JOB_RUN_REPORT_PRUNE,
    preSql: 'PRAGMA foreign_keys = OFF;',   // DROP TABLE job_run 在 FK 打开时会触发 analysis_report.job_run_id 的 ON DELETE SET NULL
    postSql: 'PRAGMA foreign_keys = ON;',
  },
];
