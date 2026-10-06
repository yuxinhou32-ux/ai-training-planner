/**
 * 训记接入（设置页）。
 *
 * 为什么要有这张卡：以前 `XUNJI_API_KEY` 只能自己改 `.env` —— 别人拿到这个项目，
 * 第一步就卡在「Key 填哪儿」。这里照 AI 配置那套做：网页填 → 写回 `.env` → **立即生效**。
 *
 * 设计取舍（与 AiConfigForm 一致）：
 *  - **Key 输入框永远是空的**，已配置时只显示 `****后四位`；不填 = 保持原值，
 *    所以「看一眼状态顺手点保存」不会把 Key 清掉（清空要显式勾选）。
 *  - 保存后服务端会**重建同步引擎与写回客户端**，不用重启进程。
 *
 * 顺带把「同步是怎么跑的」写在卡片里 —— 这是最容易误解的地方（比如以为
 * 「回补历史」会重复插入训练记录，其实是按日期覆盖）。
 */
import { useState } from 'react';
import { useJobsRecent, useSaveXunjiConfig, useTriggerJob, useXunjiConfig } from '../../api/client.js';
import { CollapsibleCard } from '../common/ui.js';

/** 任务类型 → 中文（只说人话，跟诊断区的 `label` 口径一致）。 */
const JOB_ZH: Record<string, string> = {
  sync_incremental: '增量同步',
  sync_full: '全量同步',
  sync_retry_failed: '重试失败的日期',
  sync_single: '单日同步',
  plan_draft: '生成下周草稿',
  db_backup: '数据库备份',
  analysis_refresh: '重新分析',
  report_prune: '清理旧报告',
};

export function XunjiKeyForm(): React.ReactNode {
  const cfg = useXunjiConfig();
  const save = useSaveXunjiConfig();
  const trigger = useTriggerJob();
  const jobs = useJobsRecent();

  const config = cfg.data?.config ?? null;
  const hasKey = config?.has_key ?? false;
  const keyHint = config?.key_hint ?? null;

  // 后端 /api/jobs/trigger 是无条件入队的（不会因忙碌而拒绝），所以这里的禁用
  // 是唯一一道防重复点击的闸 —— 别去掉。
  const runnerBusy = jobs.data?.runner.busy ?? false;
  const runningJob = jobs.data?.runner.job_type ?? null;
  const pendingCount = jobs.data?.runner.pending ?? 0;

  const [keyInput, setKeyInput] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dirty = confirmClear || keyInput.trim() !== '';

  function submit(): void {
    setError(null);
    setNotice(null);
    if (confirmClear) {
      save.mutate(
        { clear_key: true },
        {
          onSuccess: () => {
            setKeyInput('');
            setConfirmClear(false);
            setNotice('已清除，同步与写回已停用');
          },
          onError: (e) => setError((e as Error).message),
        },
      );
      return;
    }
    const key = keyInput.trim();
    if (key === '') {
      setNotice('没有改动');
      return;
    }
    save.mutate(
      { api_key: key },
      {
        onSuccess: (d) => {
          setKeyInput('');
          setNotice(d.config.has_key ? '已保存并立即生效' : '已保存');
        },
        onError: (e) => setError((e as Error).message),
      },
    );
  }

  return (
    <CollapsibleCard
      title="训记接入"
      summary={hasKey ? `已配置 ${keyHint ?? ''}` : '未配置 —— 同步与写回不可用'}
    >
      <div className="space-y-4">
        <div>
          <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-sm font-medium text-slate-800">训记 API Key</span>
            <span className="text-xs text-slate-500">
              {hasKey ? `已配置 ${keyHint ?? ''}，不填则保持不变` : '未配置'}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="password"
              autoComplete="off"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              disabled={confirmClear}
              placeholder={hasKey ? '••••••••（留空 = 不改）' : '粘贴你的训记 API Key'}
              className="w-full max-w-md rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm text-slate-800 placeholder:text-slate-300 focus:border-sky-400 focus:outline-none disabled:bg-slate-50"
            />
            {hasKey && (
              <label className="flex items-center gap-1.5 text-xs text-slate-500">
                <input
                  type="checkbox"
                  checked={confirmClear}
                  onChange={(e) => setConfirmClear(e.target.checked)}
                  className="accent-rose-500"
                />
                清除已保存的 Key
              </label>
            )}
            <button
              type="button"
              onClick={submit}
              disabled={!dirty || save.isPending}
              className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-1.5 text-sm text-sky-700 hover:bg-sky-100 disabled:opacity-40"
            >
              {save.isPending ? '保存中…' : '保存'}
            </button>
            {notice !== null && <span className="text-xs text-emerald-600">{notice}</span>}
            {error !== null && <span className="text-xs text-rose-600">{error}</span>}
          </div>
          <p className="mt-1.5 text-xs text-slate-400">
            Key 只写进本机 <span className="font-medium text-slate-500">.env</span>
            （已被 git 忽略），不入库、不写日志；保存后立即生效，不用重启。
          </p>
        </div>

        {/* 自动同步是怎么跑的 —— 用户最容易误解的地方，写在按钮正上方 */}
        <div className="rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2.5">
          <div className="text-sm font-medium text-slate-700">同步是怎么自动跑的</div>
          <ul className="mt-1.5 space-y-1 text-xs leading-relaxed text-slate-500">
            <li>
              · <span className="text-slate-600">打开软件时自动同步一次</span>
              ：接上次同步到的日期，补齐到今天，通常只有一两天。
            </li>
            <li>
              · <span className="text-slate-600">第一次会自动整段导入</span>
              ：只要还没有历史数据（刚填完 Key、或开机时库里是空的），就直接拉最近 26 周 ——
              实测约 10 秒，不用你手动点。
            </li>
            <li>
              · 同步只<span className="text-slate-600">读取</span>训记，绝不写入训记；重复同步按日期覆盖，
              不会产生重复记录。
            </li>
          </ul>
        </div>

        <div>
          <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-sm font-medium text-slate-800">手动同步</span>
            {runnerBusy && (
              <span className="text-xs text-indigo-600">
                正在跑：{JOB_ZH[runningJob ?? ''] ?? runningJob}
                {pendingCount > 0 && `（还有 ${pendingCount} 个排队）`}
              </span>
            )}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              disabled={!hasKey || runnerBusy || trigger.isPending}
              onClick={() => trigger.mutate('sync_incremental')}
              className="rounded-lg border border-indigo-200 bg-indigo-50 p-3 text-left text-sm text-indigo-700 hover:bg-indigo-100 disabled:opacity-50"
            >
              立即同步
              <span className="block text-[10px] text-indigo-400">只拉上次同步之后的新数据</span>
            </button>
            <button
              type="button"
              disabled={!hasKey || runnerBusy || trigger.isPending}
              onClick={() => trigger.mutate('sync_full')}
              className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-left text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-50"
            >
              回补历史
              <span className="block text-[10px] text-slate-400">重拉最近 26 周 —— 在训记里改过以前的记录时用</span>
            </button>
          </div>
          <p className="mt-1.5 text-xs text-slate-400">
            {hasKey
              ? '回补历史会自动跳过刚同步过的日期；短时间内连点两次，第二次会被训记限频、需等约 30 秒（不会出错，只是慢）。'
              : '还没有配 Key —— 填上并保存后才能同步。'}
          </p>
        </div>
      </div>
    </CollapsibleCard>
  );
}
