#!/usr/bin/env node
/**
 * scripts/analyze_probe.mjs — 对 data/probe/*.json 做离线统计
 *
 * 用途：探针把原始响应落盘后，用这个脚本回答「我的历史数据里到底有什么」，
 * 从而校准架构文档里的假设（尤其是 RPE 可得性、标题可得性、训练频率）。
 *
 * 用法：node scripts/analyze_probe.mjs
 * 依赖：无第三方依赖。不联网，只读本地文件。
 */

import fs from 'node:fs';
import path from 'node:path';

const DIR = 'data/probe';

if (!fs.existsSync(DIR)) {
  console.error(`找不到 ${DIR}/，请先运行：node scripts/probe_xunji.mjs --days=90 --dump-raw`);
  process.exit(1);
}

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : 'n/a');

/** 聚合容器 */
const agg = {
  days: files.length,
  daysWithTrain: 0,
  trains: 0,
  sets: 0,
  movementsTotal: 0,
  dupNames: new Set(),
  nameCount: new Map(),
  titleEmpty: 0,
  titleNonEmpty: 0,
  trainNote: 0,
  rpeFilled: 0,
  setNote: 0,
  comment: 0,
  doneFalse: 0,
  timePositive: 0,
  leftAsym: 0,
  selfWeight: 0,
  durationMin: [],
  setType: new Map(),
  exetype: new Map(),
  movementType: new Map(),
};

for (const f of files) {
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  const res = raw.res ?? {};
  const trains = res.trains ?? [];
  if (!trains.length) continue;
  agg.daysWithTrain++;

  for (const t of trains) {
    agg.trains++;
    if (!t.title || String(t.title).trim() === '') agg.titleEmpty++;
    else agg.titleNonEmpty++;
    if (t.note && String(t.note).trim() !== '') agg.trainNote++;

    // 训练时长：start/end 毫秒时间戳
    if (t.start && t.end && t.end > t.start) {
      agg.durationMin.push((t.end - t.start) / 60000);
    }

    for (const m of t.movements ?? []) {
      agg.movementsTotal++;
      agg.dupNames.add(m.name);
      agg.nameCount.set(m.name, (agg.nameCount.get(m.name) ?? 0) + 1);
      const key = m.type ?? '(空)';
      agg.movementType.set(key, (agg.movementType.get(key) ?? 0) + 1);
      const ek = m.exetype ?? '(空)';
      agg.exetype.set(ek, (agg.exetype.get(ek) ?? 0) + 1);

      for (const s of m.sets ?? []) {
        agg.sets++;
        if (s.rpe !== '' && s.rpe != null) agg.rpeFilled++;
        if (s.note) agg.setNote++;
        if (s.comment) agg.comment++;
        if (s.done === false) agg.doneFalse++;
        if (s.time) agg.timePositive++;
        if (s.selfWeight) agg.selfWeight++;
        if (s.leftWeight && s.weight && String(s.leftWeight) !== String(s.weight)) agg.leftAsym++;
        const st = s.setType || '(空)';
        agg.setType.set(st, (agg.setType.get(st) ?? 0) + 1);
      }
    }
  }
}

const sortedNames = [...agg.nameCount.entries()].sort((a, b) => b[1] - a[1]);
const dupDurations = agg.durationMin.slice().sort((a, b) => a - b);
const median = (arr) =>
  arr.length ? arr[Math.floor(arr.length / 2)] : 0;

console.log('════════ 训记历史数据离线统计 ════════\n');
console.log(`扫描天数：${agg.days}（${files[0]?.replace('.json', '')} ~ ${files.at(-1)?.replace('.json', '')}）`);
console.log(`有训练天数：${agg.daysWithTrain}（${pct(agg.daysWithTrain, agg.days)}）`);
console.log(`每周训练频率估算：${(agg.daysWithTrain / (agg.days / 7)).toFixed(1)} 天/周`);
console.log(`训练条数：${agg.trains} | 动作条目：${agg.movementsTotal} | 总组数：${agg.sets}`);
console.log(`去重动作名：${agg.dupNames.size} 个\n`);

console.log('── 关键字段可得性（决定哪些分析能落地） ──');
console.log(`训练标题 title     非空：${agg.titleNonEmpty} / ${agg.trains}  空占比 ${pct(agg.titleEmpty, agg.trains)}`);
console.log(`训练备注 note      非空：${agg.trainNote} / ${agg.trains}  (${pct(agg.trainNote, agg.trains)})`);
console.log(`RPE               非空：${agg.rpeFilled} / ${agg.sets}  (${pct(agg.rpeFilled, agg.sets)})`);
console.log(`组备注 note        非空：${agg.setNote} / ${agg.sets}  (${pct(agg.setNote, agg.sets)})`);
console.log(`组评论 comment     非空：${agg.comment} / ${agg.sets}  (${pct(agg.comment, agg.sets)})`);
console.log(`未完成组 done=false：${agg.doneFalse} / ${agg.sets}  (${pct(agg.doneFalse, agg.sets)})`);
console.log(`计时组 time>0      ：${agg.timePositive} / ${agg.sets}  (${pct(agg.timePositive, agg.sets)})`);
console.log(`左右不等重         ：${agg.leftAsym} / ${agg.sets}  (${pct(agg.leftAsym, agg.sets)})`);
console.log(`自重组 selfWeight  ：${agg.selfWeight} / ${agg.sets}  (${pct(agg.selfWeight, agg.sets)})`);

console.log('\n── 训练时长（由 start/end 推算） ──');
console.log(`样本数：${dupDurations.length}`);
if (dupDurations.length) {
  console.log(`中位数：${median(dupDurations).toFixed(0)} 分钟`);
  console.log(`区间：${dupDurations[0].toFixed(0)} ~ ${dupDurations.at(-1).toFixed(0)} 分钟`);
}

console.log('\n── 动作分类分布（type / exetype） ──');
console.log('movement.type：', [...agg.movementType.entries()].map(([k, v]) => `${k}=${v}`).join('  '));
console.log('movement.exetype：', [...agg.exetype.entries()].map(([k, v]) => `${k}=${v}`).join('  '));
console.log('set.setType：', [...agg.setType.entries()].map(([k, v]) => `${k}=${v}`).join('  '));

console.log('\n── 去重动作名清单（按出现次数降序） ──');
sortedNames.forEach(([n, c], i) => console.log(`${String(i + 1).padStart(3)}. ${n}  (${c})`));
