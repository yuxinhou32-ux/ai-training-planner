/**
 * 设置页（PRD-v2 §2③）。
 *
 * 顺序严格按 §2③ 的元素表来（训练日 → 每次时长 → 一周起始日 → 长期目标 →
 * 体重 → 旧伤 → 用户画像 → 训记 Key / AI 配置）：
 * 前四项都在「训练基础」一张卡里，基础信息 + 体重 + 旧伤在「个人基础信息」，
 * 用户画像只给一个折叠入口（§6 决策 6：点进去才展开）。
 *
 * 2026-09-30 变动：删掉「强行修改周期目标」区块 —— 用户要求把解锁入口放到
 * **锁定按钮旁边**（首页周期卡的红色「解锁」），所以这里不再留第二个改目标的口子
 * （两个地方能改同一个东西，正是「说不清哪个才算数」的来源）。
 *
 * 2026-09-30 二次改版（用户原话：「这些都是常驻信息，不会经常要改的。现在全部都展开，
 * 看起来有点乱」「两个的展开逻辑不一样，全部做成这个小角点一下下去就展开的这交互吧」）：
 *   - 五个区块**全部默认收起**，统一用 `CollapsibleCard`（卡片头整行可点、右端小三角旋转）；
 *     此前诊断与维护用原生 `<details>`、用户画像用「展开查看」按钮，三种长相两种逻辑。
 *   - 「AI 排计划」改名 **「AI 设置」**、「身体信息」改名 **「个人基础信息」**。
 *   - 收起态右侧保留**当前值摘要**（`summary`），收起不等于看不见。
 *
 * 页面上**不该出现的东西**都收进了底部「诊断与维护」折叠区：
 *   - 数据分析报告（v1 曾是一个顶级导航项）
 *   - 手动备份 / 任务历史 / 未处理提醒
 *   - 254 条动作映射表、未识别动作清单
 * 它们不是没用，是「出问题时才来翻」—— 平铺在设置页就是噪音。
 *
 * ⚠️ 2026-10-01：**手动同步不在折叠区里**了。同步入口跟着 Key 走 ——
 *    挪进了顶部的「训记接入」卡片（用户原话：「要把它这个接口拖出来放在网页上」）。
 *    同步归同步、备份归诊断，不再有两个地方能触发同一件事。
 *
 * v2：已移除「自动化」区块（定时调度与开关已砍，任务全部手动按钮触发）。
 * V1：新增「训练基础」表单。V4：新增「AI 设置」配置。
 * V9：新增「个人基础信息」（性别 / 年龄 / 身高 / 训练年限 + 体重 + 趋势 + 旧伤）与
 *     「用户画像」折叠入口。旧伤**只作背景参考**，不产生任何禁用动作的联动（§5）。
 * 2026-10-01：新增「训记接入」（网页配 XUNJI_API_KEY + 手动同步），排在第一位 ——
 *     没配 Key 什么数据都拉不到，它是所有功能的前置。
 */
import { GoalForm } from '../components/settings/GoalForm.js';
import { BodyForm } from '../components/settings/BodyForm.js';
import { ProfileEntry } from '../components/settings/ProfileEntry.js';
import { AiConfigForm } from '../components/settings/AiConfigForm.js';
import { XunjiKeyForm } from '../components/settings/XunjiKeyForm.js';
import { DiagnosticsEntry } from '../components/settings/DiagnosticsEntry.js';
import { DangerZone } from '../components/settings/DangerZone.js';
import { reopenOnboarding } from '../components/onboarding/OnboardingDialog.js';

export function SettingsPage(): React.ReactNode {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">设置</h1>
        <p className="mt-0.5 text-xs text-slate-500">
          这里的值都是 AI 排计划的<span className="font-medium text-slate-600">常驻基准</span>，改完立刻生效
          —— 不用重开周期，也不用手动刷新报告。
        </p>
      </div>

      {/* ① 训记接入：数据来源，没配 Key 什么都干不了，所以放最前 */}
      <XunjiKeyForm />

      {/* ② 训练日（＝一周几练）/ 每次时长 / 一周起始日 / 长期目标 */}
      <GoalForm />

      {/* ③ 基础信息（性别 / 年龄 / 身高 / 训练年限）+ 体重（趋势）/ 旧伤 · 基础疾病 */}
      <BodyForm />

      {/* ④ 用户画像：只放一个入口，点进去才展开（§6 决策 6） */}
      <ProfileEntry />

      {/* ⑤ AI 设置（DeepSeek Key / 端点 / 模型） */}
      <AiConfigForm />

      {/* ⑥ 诊断与维护：默认收起，日常不用看 */}
      <DiagnosticsEntry />

      {/* ⑦ 重新运行首次引导：纯前端重开三步向导（不改服务端完成位），是「办完事就走」的兜底入口 */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200/80 bg-white px-5 py-3.5 shadow-[0_1px_3px_rgba(15,23,42,0.05)]">
        <div className="min-w-0">
          <div className="text-[15px] font-semibold tracking-tight text-slate-800">重新运行首次引导</div>
          <p className="mt-0.5 text-xs text-slate-500">
            再看一遍「训记接入 → 训练基础 → 个人基础信息」三步，随时可以关掉。
          </p>
        </div>
        <button
          type="button"
          onClick={reopenOnboarding}
          className="shrink-0 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600"
        >
          重新运行首次引导
        </button>
      </div>

      {/* ⑧ 危险区：清空本次生成的计划（默认收起；测试期用来反复跑验收） */}
      <DangerZone />
    </div>
  );
}
