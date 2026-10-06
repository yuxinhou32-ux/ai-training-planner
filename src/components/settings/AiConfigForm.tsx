/**
 * AI 排计划配置（PRD-v2 V4）。
 *
 * 设计取舍：
 *  - **Key 输入框永远是空的**，已配置时只显示 `****后四位`。用户不填 = 保持原值，
 *    所以「看一眼状态随手点保存」不会把 Key 清掉（清空要显式点「清除」）。
 *  - 保存 = 写回 `.env`（唯一落盘位置）+ 服务端**立即热更新**，不用重启进程。
 *  - 一行「当前状态」把话说明白：可用 / 缺什么 / 已关闭。排计划是随手点的动作，
 *    不该让用户去猜「为什么这次没走 AI」。
 */
import { useEffect, useState } from 'react';
import { useAiConfig, useSaveAiConfig, type AiConfigPayload } from '../../api/client.js';
import { CollapsibleCard } from '../common/ui.js';

interface FormState {
  mode: 'http' | 'off';
  baseUrl: string;
  model: string;
  maxTokens: number;
  temperature: number;
  apiKey: string;
}

const MODEL_SUGGESTIONS = [
  { model: 'deepseek-flash', hint: '便宜够用（默认）' },
  { model: 'deepseek-v4-pro', hint: '更强更贵' },
];

const BASE_SUGGESTIONS = [
  { url: 'https://api.deepseek.com', hint: 'DeepSeek 官方' },
];

export function AiConfigForm(): React.ReactNode {
  const cfg = useAiConfig();
  const save = useSaveAiConfig();
  const [form, setForm] = useState<FormState | null>(null);
  /** 服务端当前生效值（用于判断「改动过没有」）；apiKey 恒为 ''，不参与比较 */
  const [baseline, setBaseline] = useState<FormState | null>(null);
  const [syncedKey, setSyncedKey] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const data = cfg.data?.config ?? null;
  // 只在「服务端配置变了」时同步表单：保存后服务端回新值 → 自动重新同步；
  // 后台静默 refetch 不覆盖用户正在输入的内容。
  const dataKey = data === null ? null : JSON.stringify(data);
  const pendingSync = dataKey !== null && dataKey !== syncedKey;
  // SSR 不执行 effect → 必须在渲染期就派生出一份可用表单，否则服务端渲染永远是「加载中」
  const derived: FormState | null =
    pendingSync && data
      ? {
          mode: data.mode,
          baseUrl: data.base_url,
          model: data.model,
          maxTokens: data.max_tokens,
          temperature: data.temperature,
          apiKey: '',
        }
      : null;
  const active = derived ?? form;
  const activeBaseline = derived ?? baseline;

  useEffect(() => {
    if (!pendingSync || derived === null || dataKey === null) return;
    setSyncedKey(dataKey);
    setForm(derived);
    setBaseline(derived);
    setConfirmClear(false);
  }, [pendingSync, derived, dataKey]);

  if (cfg.isError) {
    return (
      <CollapsibleCard title="AI 设置" summary={<span className="text-rose-600">读取失败</span>}>
        <div className="py-6 text-center text-sm text-rose-600">AI 配置读取失败：{String(cfg.error)}</div>
      </CollapsibleCard>
    );
  }
  if (cfg.isPending || active === null) {
    return (
      <CollapsibleCard title="AI 设置" summary="加载中…">
        <div className="py-6 text-center text-sm text-slate-400">加载中…</div>
      </CollapsibleCard>
    );
  }

  const config = data!;
  const same =
    activeBaseline !== null &&
    active.mode === activeBaseline.mode &&
    active.baseUrl.trim() === activeBaseline.baseUrl &&
    active.model.trim() === activeBaseline.model &&
    active.maxTokens === activeBaseline.maxTokens &&
    active.temperature === activeBaseline.temperature;
  const dirty = !same || active.apiKey.trim() !== '' || confirmClear;

  const submit = (): void => {
    const payload: AiConfigPayload = {
      mode: active.mode,
      base_url: active.baseUrl.trim(),
      model: active.model.trim(),
      max_tokens: active.maxTokens,
      temperature: active.temperature,
      ...(confirmClear ? { clear_key: true } : {}),
      ...(active.apiKey.trim() !== '' ? { api_key: active.apiKey.trim() } : {}),
    };
    save.mutate(payload, { onSuccess: () => setForm({ ...active, apiKey: '' }) });
  };

  const status = config.ready
    ? { cls: 'border-emerald-200 bg-emerald-50 text-emerald-700', text: `可用（${config.model}）` }
    : config.mode === 'off'
      ? { cls: 'border-slate-200 bg-slate-50 text-slate-600', text: '已关闭（排计划用规则模板）' }
      : { cls: 'border-amber-200 bg-amber-50 text-amber-700', text: `未配置完整：${config.blocked_reason ?? '未知原因'}` };

  const summary = `${status.text}${config.has_key ? ` · Key ${config.key_hint}` : ''}`;

  return (
    <CollapsibleCard title="AI 设置" summary={summary}>
      <div className="space-y-4">
        <div className={`rounded-lg border px-3 py-2 text-sm ${status.cls}`}>
          <span className="font-medium">当前状态：</span>
          {status.text}
          {config.has_key && <span className="ml-2 text-xs opacity-80">Key {config.key_hint}</span>}
        </div>

        {/* 开关 */}
        <div>
          <div className="mb-2 text-sm font-medium text-slate-800">是否用 AI 排计划</div>
          <div className="flex gap-2">
            {[
              { v: 'http' as const, label: '用 AI' },
              { v: 'off' as const, label: '关闭（只用规则模板）' },
            ].map((o) => {
              const on = active.mode === o.v;
              return (
                <button
                  key={o.v}
                  type="button"
                  onClick={() => setForm({ ...active, mode: o.v })}
                  aria-pressed={on}
                  className={
                    'rounded-lg border px-3 py-1.5 text-sm transition ' +
                    (on
                      ? 'border-sky-500 bg-sky-50 font-medium text-sky-700'
                      : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50')
                  }
                >
                  {o.label}
                </button>
              );
            })}
          </div>
          <p className="mt-1.5 text-xs text-slate-400">
            关闭后即使填了 Key 也不调用模型，排计划直接用规则模板（「关闭」是给 AI 端点不稳定时的兜底）。
          </p>
        </div>

        <div className={active.mode === 'off' ? 'space-y-4 opacity-50' : 'space-y-4'}>
          {/* 端点 */}
          <div>
            <div className="mb-2 text-sm font-medium text-slate-800">接口地址（OpenAI 兼容）</div>
            <input
              type="text"
              value={active.baseUrl}
              onChange={(e) => setForm({ ...active, baseUrl: e.target.value })}
              placeholder=" https://api.deepseek.com"
              className="w-full max-w-md rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm text-slate-800 placeholder:text-slate-300 focus:border-sky-400 focus:outline-none"
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {BASE_SUGGESTIONS.map((s) => (
                <button
                  key={s.url}
                  type="button"
                  onClick={() => setForm({ ...active, baseUrl: s.url })}
                  className="rounded-md border border-slate-200 px-2 py-0.5 text-xs text-slate-500 hover:border-slate-300 hover:bg-slate-50"
                >
                  {s.hint}
                </button>
              ))}
            </div>
          </div>

          {/* 模型 */}
          <div>
            <div className="mb-2 text-sm font-medium text-slate-800">模型</div>
            <input
              type="text"
              value={active.model}
              onChange={(e) => setForm({ ...active, model: e.target.value })}
              placeholder="deepseek-flash"
              className="w-full max-w-xs rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm text-slate-800 placeholder:text-slate-300 focus:border-sky-400 focus:outline-none"
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {MODEL_SUGGESTIONS.map((s) => (
                <button
                  key={s.model}
                  type="button"
                  onClick={() => setForm({ ...active, model: s.model })}
                  className="rounded-md border border-slate-200 px-2 py-0.5 text-xs text-slate-500 hover:border-slate-300 hover:bg-slate-50"
                >
                  {s.model}（{s.hint}）
                </button>
              ))}
            </div>
          </div>

          {/* Key */}
          <div>
            <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-sm font-medium text-slate-800">API Key</span>
              <span className="text-xs text-slate-500">
                {config.has_key ? `已配置 ${config.key_hint}，不填则保持不变` : '未配置'}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="password"
                autoComplete="off"
                value={active.apiKey}
                onChange={(e) => setForm({ ...active, apiKey: e.target.value })}
                disabled={confirmClear}
                placeholder={config.has_key ? '••••••••（留空 = 不改）' : '粘贴你的 API Key'}
                className="w-full max-w-md rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm text-slate-800 placeholder:text-slate-300 focus:border-sky-400 focus:outline-none disabled:bg-slate-50"
              />
              {config.has_key && (
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
            </div>
            <p className="mt-1.5 text-xs text-slate-400">
              Key 只写进本机 <span className="font-medium text-slate-500">.env</span>，不入库、不写日志。
            </p>
          </div>

          {/* 高级：输出上限与温度 */}
          <details className="rounded-lg border border-slate-200 px-3 py-2">
            <summary className="cursor-pointer text-sm text-slate-600">高级参数</summary>
            <div className="mt-3 space-y-3 text-sm text-slate-600">
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-40 shrink-0">单次回复上限（token）</span>
                <input
                  type="number"
                  min={256}
                  max={32768}
                  step={256}
                  value={active.maxTokens}
                  onChange={(e) => setForm({ ...active, maxTokens: Number(e.target.value) })}
                  className="w-28 rounded-lg border border-slate-200 px-2 py-1.5 tabular-nums text-slate-800 focus:border-sky-400 focus:outline-none"
                />
                <span className="text-xs text-slate-400">排计划要输出整周 JSON，设太小会被截断</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-40 shrink-0">温度</span>
                <input
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={active.temperature}
                  onChange={(e) => setForm({ ...active, temperature: Number(e.target.value) })}
                  className="w-28 rounded-lg border border-slate-200 px-2 py-1.5 tabular-nums text-slate-800 focus:border-sky-400 focus:outline-none"
                />
                <span className="text-xs text-slate-400">低一点更稳（默认 0.3）</span>
              </div>
            </div>
          </details>
        </div>

        {/* 保存 */}
        <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-3">
          <button
            type="button"
            onClick={submit}
            disabled={!dirty || save.isPending}
            className="rounded-lg bg-sky-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
          >
            {save.isPending ? '保存中…' : '保存并生效'}
          </button>
          {!dirty && !save.isSuccess && <span className="text-xs text-slate-400">与当前生效值一致</span>}
          {save.isError && <span className="text-xs text-rose-600">保存失败：{String(save.error)}</span>}
          {save.isSuccess && !dirty && (
            <span className="text-xs text-emerald-600">
              已写入 {cfg.data?.env_file ?? '.env'} 并立即生效（不用重启）
            </span>
          )}
        </div>
      </div>
    </CollapsibleCard>
  );
}
