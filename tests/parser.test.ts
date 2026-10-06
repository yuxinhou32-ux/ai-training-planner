import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDay, parseSet, parseTrain, flattenSets } from '../server/ingest/parser.js';
import { makeCardioTrain, makeEnvelope, makeMovement, makeSet, makeTrain } from './fixtures.js';
import type { ResBody } from '../server/xunji/types.js';

const D = '2026-09-14';

function resOf(trains: Record<string, unknown>[], extra: Record<string, unknown> = {}): ResBody {
  return (makeEnvelope(D, trains, extra).res as ResBody) ?? ({} as ResBody);
}

test('字段映射：字符串数值（weight/reps/rpe 实测为 string）正确落库', () => {
  const day = parseDay(D, resOf([makeTrain()]));
  assert.equal(day.counts.trains, 1);
  assert.equal(day.counts.movements, 1);
  assert.equal(day.counts.sets, 2);
  const s = day.sessions[0]?.movements[0]?.sets[0];
  assert.ok(s);
  assert.equal(s?.weightKg, 30);
  assert.equal(s?.weightUnit, 'kg');
  assert.equal(s?.reps, 10);
  assert.equal(s?.rpe, null); // rpe 实测空串 → null（填充率 0%）
  assert.equal(s?.timeS, 60);
  assert.equal(s?.done, 1);
  const s2 = day.sessions[0]?.movements[0]?.sets[1];
  assert.equal(s2?.weightKg, 32.5);
});

test('热身组：setType=热 → is_warmup=1 + warmup_source=server_set_type（实测 57/912）', () => {
  const s = parseSet(makeSet({ setType: '热' }) as never);
  assert.equal(s.isWarmup, 1);
  assert.equal(s.warmupSource, 'server_set_type');
  assert.equal(s.setType, '热');
  const s2 = parseSet(makeSet({ setType: '' }) as never);
  assert.equal(s2.isWarmup, 0);
  assert.equal(s2.warmupSource, null);
});

test('未打勾组：done=false → 0（实测 4/912）', () => {
  const s = parseSet(makeSet({ done: false }) as never);
  assert.equal(s.done, 0);
});

test('有氧分支：exetype=cardio + metrics（distance km→m、kcal、bpm）+ 未知字段进 raw_json', () => {
  const day = parseDay(D, resOf([makeCardioTrain(D)]));
  const m = day.sessions[0]?.movements[0];
  assert.ok(m);
  assert.equal(m?.isCardio, 1);
  assert.equal(m?.nameRaw, '有氧训练');
  const s = m?.sets[0];
  assert.ok(s);
  assert.equal(s?.distanceM, 1970); // 1.97 km → 1970 m
  assert.equal(s?.kcal, 266.71);
  assert.equal(s?.avgHeartRate, 133);
  // recordFieldKeys 是未知字段 → raw_json 兜底（不静默丢弃）
  assert.ok(s?.rawJson);
  const raw = JSON.parse(s?.rawJson ?? '{}') as Record<string, unknown>;
  assert.ok(Array.isArray(raw['recordFieldKeys']));
});

test('未知字段兜底：set 级未知字段全部进 raw_json；已知字段不重复进', () => {
  const s = parseSet(makeSet({ weirdField: 'x', anotherOne: 42 }) as never);
  assert.ok(s.rawJson);
  const raw = JSON.parse(s.rawJson) as Record<string, unknown>;
  assert.deepEqual(Object.keys(raw).sort(), ['anotherOne', 'weirdField']);
  const s2 = parseSet(makeSet() as never);
  assert.equal(s2.rawJson, null);
});

test('movement 级：type/exetype 空串→null；restTime/warn_restTime/singleSide/note', () => {
  const day = parseDay(D, resOf([makeTrain({ movements: [makeMovement({ type: '', exetype: '', note: '感觉良好', restTime: 90, warn_restTime: 5, singleSide: true })] })]));
  const m = day.sessions[0]?.movements[0];
  assert.ok(m);
  assert.equal(m?.serverType, null);
  assert.equal(m?.exetype, null);
  assert.equal(m?.restTimeS, 90);
  assert.equal(m?.warnRestTime, 5);
  assert.equal(m?.singleSide, 1);
  assert.equal(m?.notes, '感觉良好');
  assert.equal(m?.isCardio, 0);
  assert.equal(m?.nameNorm, '杠铃卧推');
});

test('归一化：全角/空格/大小写（NFKC + 折叠空白 + 小写）', () => {
  const day = parseDay(D, resOf([makeTrain({ movements: [makeMovement({ name: 'Ｖ－ＢＡＲ  绳索下压' })] })]));
  assert.equal(day.sessions[0]?.movements[0]?.nameNorm, 'v-bar 绳索下压');
});

test('train 级：localid 数字→文本；started_at 毫秒→ISO 文本；title 空串→null', () => {
  const day = parseDay(D, resOf([makeTrain()]));
  const s = day.sessions[0];
  assert.ok(s);
  assert.equal(s?.localid, '1789344000001');
  assert.equal(s?.title, null);
  assert.equal(s?.titleSource, null);
  assert.equal(s?.note, '状态不错');
  assert.equal(s?.startMs, 1_789_344_000_000);
  assert.match(s?.startedAt ?? '', /^2026-/);
  assert.ok(s?.startedAt?.endsWith('Z'));
  assert.equal(s?.durationMin, 67);
  assert.equal(s?.durationSrc, 'start_end');
  assert.equal(s?.isOutlier, 0);
});

test('时长离群：19min→too_short；125min→正常；151min→too_long；缺失→missing_duration', () => {
  const start = 1_789_344_000_000;
  const mk = (mins: number | null) =>
    makeTrain(
      mins === null
        ? { start: null, end: null, started_at: null, ended_at: null }
        : { start, end: start + mins * 60 * 1000, started_at: start, ended_at: start + mins * 60 * 1000 },
    );
  assert.equal(parseTrain(D, mk(19) as never, 1, { truncatedSources: [], warnings: [] }).outlierReason, 'too_short');
  assert.equal(parseTrain(D, mk(125) as never, 1, { truncatedSources: [], warnings: [] }).isOutlier, 0);
  assert.equal(parseTrain(D, mk(151) as never, 1, { truncatedSources: [], warnings: [] }).outlierReason, 'too_long');
  assert.equal(parseTrain(D, mk(null) as never, 1, { truncatedSources: [], warnings: [] }).outlierReason, 'missing_duration');
});

test('session_type：全有氧→cardio；混合→mixed；力量→strength；空动作→other', () => {
  const cardio = parseDay(D, resOf([makeCardioTrain(D)]));
  assert.equal(cardio.sessions[0]?.sessionType, 'cardio');
  assert.equal(cardio.sessions[0]?.isCardio, 1);

  const mixed = parseDay(D, resOf([makeTrain({ movements: [makeMovement(), makeMovement({ index: 2, name: '有氧训练', exetype: 'cardio', type: '' })] })]));
  assert.equal(mixed.sessions[0]?.sessionType, 'mixed');

  const strength = parseDay(D, resOf([makeTrain()]));
  assert.equal(strength.sessions[0]?.sessionType, 'strength');

  const empty = parseDay(D, resOf([makeTrain({ movements: [] })]));
  assert.equal(empty.sessions[0]?.sessionType, 'other');
});

test('截断检测：res/train/movement 任一 truncated → day.truncated + 来源明细（不静默丢弃）', () => {
  const resLevel = parseDay(D, resOf([], { resTruncated: true }));
  assert.equal(resLevel.truncated, true);
  assert.deepEqual(resLevel.truncatedSources, ['res.truncated']);

  const trainLevel = parseDay(D, resOf([makeTrain({ truncated: true })]));
  assert.equal(trainLevel.truncated, true);
  assert.match(trainLevel.truncatedSources[0] ?? '', /train#1/);
  assert.equal(trainLevel.sessions[0]?.serverTruncated, 1);

  const moveLevel = parseDay(D, resOf([makeTrain({ movements: [makeMovement({ truncated: true })] })]));
  assert.equal(moveLevel.truncated, true);
  assert.match(moveLevel.truncatedSources[0] ?? '', /movements/);
});

test('读侧超限：动作 >40 或组 >60 → truncated 标记（读侧 40/60，非写侧 15/20）', () => {
  const manyMoves = Array.from({ length: 41 }, (_, i) => makeMovement({ index: i + 1, name: `动作${i + 1}` }));
  const day = parseDay(D, resOf([makeTrain({ movements: manyMoves })]));
  assert.equal(day.truncated, true);
  assert.match(day.truncatedSources.join(';'), /超过读侧上限 40/);

  const manySets = Array.from({ length: 61 }, (_, i) => makeSet({ index: i + 1 }));
  const day2 = parseDay(D, resOf([makeTrain({ movements: [makeMovement({ sets: manySets })] })]));
  assert.equal(day2.truncated, true);
  assert.match(day2.truncatedSources.join(';'), /超过读侧上限 60/);
  // 不静默丢弃：61 组全部保留
  assert.equal(day2.sessions[0]?.movements[0]?.sets.length, 61);
});

test('超级组：items[] 子项递归展开（flattenSets 深度优先）', () => {
  const day = parseDay(
    D,
    resOf([
      makeTrain({
        movements: [
          makeMovement({
            sets: [
              makeSet({
                index: 1,
                weight: '',
                reps: '',
                items: [makeSet({ index: 1, weight: '20' }), makeSet({ index: 2, weight: '22.5' })],
              }),
              makeSet({ index: 2, weight: '40' }),
            ],
          }),
        ],
      }),
    ]),
  );
  const m = day.sessions[0]?.movements[0];
  assert.ok(m);
  assert.equal(m?.itemsJson && JSON.parse(m.itemsJson).length, 2); // 原始结构保留
  const flat = flattenSets(m?.sets ?? []);
  assert.equal(flat.length, 4); // 父 + 2 子 + 独立组
  assert.deepEqual(flat.map((f) => f.depth), [0, 1, 1, 0]);
});

test('content_hash：同结构同哈希；内容变化哈希变化', () => {
  const a = parseDay(D, resOf([makeTrain()]));
  const b = parseDay(D, resOf([makeTrain()]));
  assert.equal(a.sessions[0]?.contentHash, b.sessions[0]?.contentHash);
  const c = parseDay(D, resOf([makeTrain({ note: '改了备注' })]));
  assert.notEqual(a.sessions[0]?.contentHash, c.sessions[0]?.contentHash);
});

test('空日：trains=[] → 0/0/0，无截断，无告警', () => {
  const day = parseDay('2026-05-04', resOf([]));
  assert.deepEqual(day.counts, { trains: 0, movements: 0, sets: 0 });
  assert.equal(day.truncated, false);
  assert.deepEqual(day.warnings, []);
});

test('防御性：movements/sets 类型异常时告警且不崩', () => {
  const day = parseDay(D, resOf([makeTrain({ movements: 'not-an-array' })]));
  assert.equal(day.counts.trains, 1);
  assert.equal(day.counts.movements, 0);
});
