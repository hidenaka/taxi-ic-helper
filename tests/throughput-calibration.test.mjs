import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import {
  computeThroughputCalibration,
  WINDOW_MS,
  MIN_WINDOWS_FOR_LEARNING,
  K_MAX,
  sumTrackDepartedInWindow,
  applyThroughputScale,
  applyThroughputScaleToAccuracy,
  trackRowDeparted,
  trackRowDepartedByStall,
  TRACK_SCHEMA_VERSIONS,
} from '../scripts/lib/throughput-calibration.mjs';

// net-diff 1 行を作る。s1/s2/s3/s4 は diff_occupied_from_prev。
function makeNetDiffRow(ts, { s1 = 0, s2 = 0, s3 = 0, s4 = 0, lum = 100, schema = 3 } = {}) {
  return {
    schema_version: schema,
    ts,
    img1: { roi: { luminance_mean: lum } },
    stalls: {
      stall1: { diff_occupied_from_prev: s1 },
      stall2: { diff_occupied_from_prev: s2 },
      stall3: { diff_occupied_from_prev: s3 },
      stall4: { diff_occupied_from_prev: s4 },
    },
  };
}

// departed を 2 カメラに分けた v3 track 行を作る (全カメラ合計 = departed)
function makeTrackRowV3(ts, departed) {
  const half = Math.floor(departed / 2);
  return {
    schema_version: 3,
    ts,
    cameras: { real01_line: { departed: half }, real02: { departed: departed - half } },
  };
}

// windows 個の5分窓ぶんの net-diff 行 + track 行を作る。
// 各窓の track 行は窓 (T-5min, T] 内に 30s, 90s, ... の位置で配置。
function buildFixture(windows, opts = {}) {
  const { trackPerWindow = 5, departedPerTick = 2, s1 = -8, s2 = 0, s3 = 0, s4 = 0 } = opts;
  const base = new Date('2026-05-14T10:00:00+09:00').getTime();
  const netDiffHistory = [];
  const trackHistory = [];
  for (let i = 0; i < windows; i++) {
    const endMs = base + i * WINDOW_MS;
    netDiffHistory.push(makeNetDiffRow(new Date(endMs).toISOString(), { s1, s2, s3, s4 }));
    for (let j = 0; j < trackPerWindow; j++) {
      const tsMs = endMs - 30000 - j * 60000; // 窓内: -0.5min, -1.5min, ...
      trackHistory.push(makeTrackRowV3(new Date(tsMs).toISOString(), departedPerTick));
    }
  }
  return { netDiffHistory, trackHistory };
}

test('computeThroughputCalibration: track 空 → windowCount 0, bootstrapping, k 1.0', () => {
  const { netDiffHistory } = buildFixture(20);
  const r = computeThroughputCalibration(netDiffHistory, []);
  assert.equal(r.windowCount, 0);
  assert.equal(r.state, 'bootstrapping');
  assert.equal(r.k, 1.0);
});

test('computeThroughputCalibration: 12 窓以上 → learning, k = trackSum/netDiffSum', () => {
  // 12 窓 × (track 5 本 × departed 2 = 10) = trackSum 120
  // 12 窓 × netDiff 8 = netDiffSum 96 → k = 1.25
  const { netDiffHistory, trackHistory } = buildFixture(12, { departedPerTick: 2, s1: -8 });
  const r = computeThroughputCalibration(netDiffHistory, trackHistory);
  assert.equal(r.windowCount, 12);
  assert.equal(r.state, 'learning');
  assert.equal(r.trackSum, 120);
  assert.equal(r.netDiffSum, 96);
  assert.equal(r.k, 1.25);
});

test('computeThroughputCalibration: 窓 12 未満 → bootstrapping, k 1.0', () => {
  const { netDiffHistory, trackHistory } = buildFixture(11);
  const r = computeThroughputCalibration(netDiffHistory, trackHistory);
  assert.equal(r.windowCount, 11);
  assert.equal(r.state, 'bootstrapping');
  assert.equal(r.k, 1.0);
});

test('computeThroughputCalibration: 窓内 track 4 本未満 → その窓は不採用', () => {
  const { netDiffHistory, trackHistory } = buildFixture(20, { trackPerWindow: 3 });
  const r = computeThroughputCalibration(netDiffHistory, trackHistory);
  assert.equal(r.windowCount, 0);
  assert.equal(r.state, 'bootstrapping');
});

test('computeThroughputCalibration: netDiffSum 0 → learning でも k 1.0 (0除算しない)', () => {
  const { netDiffHistory, trackHistory } = buildFixture(12, { s1: 0, departedPerTick: 1 });
  const r = computeThroughputCalibration(netDiffHistory, trackHistory);
  assert.equal(r.windowCount, 12);
  assert.equal(r.state, 'learning');
  assert.equal(r.netDiffSum, 0);
  assert.equal(r.k, 1.0);
});

test('computeThroughputCalibration: k が K_MAX を超えたら clip', () => {
  // netDiff 1/窓、track 5本×20 = 100/窓 → ratio 100 → K_MAX に clip
  const { netDiffHistory, trackHistory } = buildFixture(12, { s1: -1, departedPerTick: 20 });
  const r = computeThroughputCalibration(netDiffHistory, trackHistory);
  assert.equal(r.k, K_MAX);
});

test('computeThroughputCalibration: 信頼サブセット外の net-diff 行は窓に数えない', () => {
  const base = new Date('2026-05-14T10:00:00+09:00').getTime();
  const ts = new Date(base).toISOString();
  const trackHistory = [0, 1, 2, 3, 4].map(j =>
    makeTrackRowV3(new Date(base - 30000 - j * 60000).toISOString(), 1));
  const netDiffHistory = [
    makeNetDiffRow(ts, { s1: -5, schema: 2 }),   // schema≠3
    makeNetDiffRow(ts, { s1: -5, lum: 10 }),      // 夜間
    { schema_version: 3, ts, img1: { roi: { luminance_mean: 100 } }, stalls: null }, // stalls null
  ];
  const r = computeThroughputCalibration(netDiffHistory, trackHistory);
  assert.equal(r.windowCount, 0);
});

test('computeThroughputCalibration: net-diff outflow は stall1〜4 を合算 (stall4 を含む)', () => {
  // 各窓 stall1 -3 / stall4 -100 → netDiffSum = 12*(3+100) = 1236
  const { netDiffHistory, trackHistory } = buildFixture(12, { s1: -3, s4: -100, departedPerTick: 5 });
  const r = computeThroughputCalibration(netDiffHistory, trackHistory);
  assert.equal(r.netDiffSum, 1236);
  assert.equal(r.trackSum, 300); // 12 窓 × 5本 × 5
});

test('computeThroughputCalibration: 正の diff (入庫) は outflow に数えない', () => {
  const { netDiffHistory, trackHistory } = buildFixture(12, { s1: 4, s2: -6, departedPerTick: 1 });
  const r = computeThroughputCalibration(netDiffHistory, trackHistory);
  assert.equal(r.netDiffSum, 72); // stall2 の -6 のみ × 12
});

// ts ミリ秒の連番 track 行を作る
function makeTrackRows(startMs, count, stepMs, departed) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    rows.push(makeTrackRowV3(new Date(startMs + i * stepMs).toISOString(), departed));
  }
  return rows;
}

test('sumTrackDepartedInWindow: 窓内本数が minTicks 以上 → departed 合算', () => {
  const base = new Date('2026-05-14T10:00:00+09:00').getTime();
  const rows = makeTrackRows(base, 60, 60000, 1); // 60 本、各 departed 1
  const sum = sumTrackDepartedInWindow(rows, base - 1, base + 60 * 60000, 48);
  assert.equal(sum, 60);
});

test('sumTrackDepartedInWindow: 窓内本数が minTicks 未満 → null', () => {
  const base = new Date('2026-05-14T10:00:00+09:00').getTime();
  const rows = makeTrackRows(base, 10, 60000, 1); // 10 本のみ
  const sum = sumTrackDepartedInWindow(rows, base - 1, base + 60 * 60000, 48);
  assert.equal(sum, null);
});

test('sumTrackDepartedInWindow: 窓外の行は合算しない', () => {
  const base = new Date('2026-05-14T10:00:00+09:00').getTime();
  // 窓内 50 本 + 窓より後ろ 50 本
  const inWin = makeTrackRows(base, 50, 60000, 2);
  const after = makeTrackRows(base + 100 * 60000, 50, 60000, 9);
  const sum = sumTrackDepartedInWindow([...inWin, ...after], base - 1, base + 60 * 60000, 48);
  assert.equal(sum, 100); // 50 本 × 2 のみ
});

test('sumTrackDepartedInWindow: 開始/終了が NaN → null', () => {
  const base = new Date('2026-05-14T10:00:00+09:00').getTime();
  const rows = makeTrackRows(base, 60, 60000, 1);
  assert.equal(sumTrackDepartedInWindow(rows, NaN, base + 60 * 60000, 48), null);
  assert.equal(sumTrackDepartedInWindow(rows, base, NaN, 48), null);
});

test('sumTrackDepartedInWindow: ts 不正な行はスキップ', () => {
  const base = new Date('2026-05-14T10:00:00+09:00').getTime();
  const rows = makeTrackRows(base, 60, 60000, 1);
  rows.push({ ts: 'not-a-date', departed: 999 });
  const sum = sumTrackDepartedInWindow(rows, base - 1, base + 60 * 60000, 48);
  assert.equal(sum, 60); // 不正行は無視
});

test('sumTrackDepartedInWindow: 区間は (startMs, endMs] の半開区間', () => {
  const base = new Date('2026-05-14T10:00:00+09:00').getTime();
  const rows = makeTrackRows(base, 60, 60000, 1);
  // startMs ちょうどの行 (rows[0]) は除外、endMs ちょうどの行 (rows[59]) は含む
  const endMs = base + 59 * 60000;
  const sum = sumTrackDepartedInWindow(rows, base, endMs, 48);
  assert.equal(sum, 59); // rows[1..59]
});

test('computeThroughputCalibration: schema_version!==3 の track 行は無視される', () => {
  // 12 窓ぶんの net-diff + track だが track 行を旧 v2 (flat) で作る
  const base = new Date('2026-05-14T10:00:00+09:00').getTime();
  const netDiffHistory = [];
  const trackHistory = [];
  for (let i = 0; i < 12; i++) {
    const endMs = base + i * WINDOW_MS;
    netDiffHistory.push(makeNetDiffRow(new Date(endMs).toISOString(), { s1: -8 }));
    for (let j = 0; j < 5; j++) {
      trackHistory.push({ schema_version: 2, ts: new Date(endMs - 30000 - j * 60000).toISOString(), departed: 2 });
    }
  }
  const r = computeThroughputCalibration(netDiffHistory, trackHistory);
  assert.equal(r.windowCount, 0); // v2 行は無視 → 各窓 track 0 本 → 不採用
  assert.equal(r.state, 'bootstrapping');
});

test('sumTrackDepartedInWindow: schema_version!==3 の行は合算しない', () => {
  const base = new Date('2026-05-14T10:00:00+09:00').getTime();
  const v3 = makeTrackRows(base, 60, 60000, 1);  // makeTrackRows は v3、全カメラ合計 departed 1/行
  const v2 = [];
  for (let i = 0; i < 60; i++) {
    v2.push({ schema_version: 2, ts: new Date(base + i * 60000).toISOString(), departed: 100 });
  }
  const sum = sumTrackDepartedInWindow([...v3, ...v2], base - 1, base + 60 * 60000, 48);
  assert.equal(sum, 60); // v3 の 60本×1 のみ。v2 は無視
});

test('sumTrackDepartedInWindow: v3 行の全カメラ departed を合算する', () => {
  const base = new Date('2026-05-14T10:00:00+09:00').getTime();
  const rows = [];
  for (let i = 0; i < 60; i++) {
    rows.push({
      schema_version: 3,
      ts: new Date(base + i * 60000).toISOString(),
      cameras: { real01_line: { departed: 2 }, real02: { departed: 3 } },
    });
  }
  const sum = sumTrackDepartedInWindow(rows, base - 1, base + 60 * 60000, 48);
  assert.equal(sum, 300); // 60 本 × (2 + 3)
});

test('sumTrackDepartedInWindow: departed が数値でないカメラは 0 として扱う', () => {
  const base = new Date('2026-05-14T10:00:00+09:00').getTime();
  const rows = [];
  for (let i = 0; i < 60; i++) {
    rows.push({
      schema_version: 3,
      ts: new Date(base + i * 60000).toISOString(),
      cameras: { real01_line: { departed: 1 }, real02: {} },  // real02 に departed 無し
    });
  }
  const sum = sumTrackDepartedInWindow(rows, base - 1, base + 60 * 60000, 48);
  assert.equal(sum, 60); // real01_line の 1 のみ × 60、real02 は 0
});

// --- applyThroughputScale (B案) ---

// forecast 形の出力オブジェクトを作る
function makeForecastObj() {
  return {
    schemaVersion: 1,
    trendFactor: 1.5,
    trendWindow: { actual: 9, expected: 7.5, source: 'track', k: 2 },
    slots: [
      { slotStart: '12:05', slotEnd: '12:10', flightFactor: 1.0, stall1: 2, stall2: 3, stall3: 0, stall4: 1, total: 6 },
      { slotStart: '12:10', slotEnd: '12:15', flightFactor: 2.0, stall1: 1, stall2: 1, stall3: 1, stall4: 1, total: 4 },
    ],
  };
}

test('applyThroughputScale: slot の stall1-4 を k 倍し total を再計算', () => {
  const r = applyThroughputScale(makeForecastObj(), 2);
  assert.equal(r.slots[0].stall1, 4);
  assert.equal(r.slots[0].stall2, 6);
  assert.equal(r.slots[0].stall3, 0);
  assert.equal(r.slots[0].stall4, 2);
  assert.equal(r.slots[0].total, 12); // 4+6+0+2
});

test('applyThroughputScale: k=1 は恒等 (数値不変)', () => {
  const r = applyThroughputScale(makeForecastObj(), 1);
  assert.equal(r.slots[0].stall1, 2);
  assert.equal(r.slots[0].total, 6);
  assert.equal(r.throughputScaleK, 1);
});

test('applyThroughputScale: 非 slot フィールド保持、trendWindow はスケールしない', () => {
  const r = applyThroughputScale(makeForecastObj(), 2);
  assert.equal(r.schemaVersion, 1);
  assert.equal(r.trendFactor, 1.5);
  assert.equal(r.trendWindow.actual, 9);    // net-diff 診断値、スケールしない
  assert.equal(r.trendWindow.expected, 7.5);
  assert.equal(r.slots[0].slotStart, '12:05');
  assert.equal(r.slots[0].flightFactor, 1.0);
});

test('applyThroughputScale: 入力を破壊しない', () => {
  const obj = makeForecastObj();
  applyThroughputScale(obj, 2);
  assert.equal(obj.slots[0].stall1, 2);   // 元のまま
  assert.equal(obj.slots[0].total, 6);
  assert.equal(obj.throughputScaleK, undefined);
});

test('applyThroughputScale: throughputScaleK を付与', () => {
  const r = applyThroughputScale(makeForecastObj(), 2.5);
  assert.equal(r.throughputScaleK, 2.5);
});

test('applyThroughputScale: ensemble 形 (slots に leadBucket) でも動く', () => {
  const ens = {
    schemaVersion: 1,
    weights: { lead30: { w_fc: 0.5, w_pm: 0.5 } },
    slots: [{ slotStart: '12:05', leadBucket: 'lead30', stall1: 2, stall2: 2, stall3: 2, stall4: 2, total: 8 }],
  };
  const r = applyThroughputScale(ens, 3);
  assert.equal(r.slots[0].stall1, 6);
  assert.equal(r.slots[0].total, 24);
  assert.equal(r.slots[0].leadBucket, 'lead30');
  assert.deepEqual(r.weights, { lead30: { w_fc: 0.5, w_pm: 0.5 } });
});

test('applyThroughputScale: k が非正・非数値 → 1.0 扱い (恒等)', () => {
  assert.equal(applyThroughputScale(makeForecastObj(), 0).throughputScaleK, 1);
  assert.equal(applyThroughputScale(makeForecastObj(), -2).throughputScaleK, 1);
  assert.equal(applyThroughputScale(makeForecastObj(), NaN).throughputScaleK, 1);
  const r = applyThroughputScale(makeForecastObj(), 0);
  assert.equal(r.slots[0].stall1, 2); // 恒等
});

test('applyThroughputScale: slots が配列でない → throughputScaleK のみ付与', () => {
  const r = applyThroughputScale({ schemaVersion: 1 }, 2);
  assert.equal(r.throughputScaleK, 2);
  assert.equal(r.schemaVersion, 1);
  assert.equal(r.slots, undefined);
});

// --- applyThroughputScaleToAccuracy ---

// accuracy 形のオブジェクトを作る
function makeAccuracyObj() {
  const bucket = (total, perStall, n) => ({ mae_total: total, mae_per_stall: perStall, n });
  const method = () => ({
    lead30: bucket(1.0, [0.5, 0.4, 0.3, 0.2], 100),
    lead60: bucket(2.0, [1.0, 0.5, 0.3, 0.2], 80),
    lead120: bucket(null, [null, null, null, null], 0),
  });
  const period = () => ({
    forecast: method(),
    patternMatch: method(),
    winner: { lead30: 'forecast', lead60: 'patternMatch', lead120: 'n/a' },
  });
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-17T10:00:00+09:00',
    logEntryCount: 86,
    recent24h: period(),
    allPeriod: period(),
  };
}

test('applyThroughputScaleToAccuracy: MAE を k 倍する (recent24h/allPeriod, forecast/patternMatch)', () => {
  const r = applyThroughputScaleToAccuracy(makeAccuracyObj(), 2);
  assert.equal(r.recent24h.forecast.lead30.mae_total, 2.0);
  assert.deepEqual(r.recent24h.forecast.lead30.mae_per_stall, [1.0, 0.8, 0.6, 0.4]);
  assert.equal(r.recent24h.forecast.lead60.mae_total, 4.0);
  assert.equal(r.recent24h.patternMatch.lead30.mae_total, 2.0);
  assert.equal(r.allPeriod.forecast.lead30.mae_total, 2.0);
  assert.equal(r.allPeriod.patternMatch.lead60.mae_total, 4.0);
});

test('applyThroughputScaleToAccuracy: null の MAE は null のまま', () => {
  const r = applyThroughputScaleToAccuracy(makeAccuracyObj(), 2);
  assert.equal(r.recent24h.forecast.lead120.mae_total, null);
  assert.deepEqual(r.recent24h.forecast.lead120.mae_per_stall, [null, null, null, null]);
});

test('applyThroughputScaleToAccuracy: n / winner / metadata を保持', () => {
  const r = applyThroughputScaleToAccuracy(makeAccuracyObj(), 2);
  assert.equal(r.recent24h.forecast.lead30.n, 100);
  assert.equal(r.recent24h.winner.lead30, 'forecast');
  assert.equal(r.recent24h.winner.lead60, 'patternMatch');
  assert.equal(r.schemaVersion, 1);
  assert.equal(r.generatedAt, '2026-05-17T10:00:00+09:00');
  assert.equal(r.logEntryCount, 86);
});

test('applyThroughputScaleToAccuracy: 入力を破壊しない', () => {
  const obj = makeAccuracyObj();
  applyThroughputScaleToAccuracy(obj, 2);
  assert.equal(obj.recent24h.forecast.lead30.mae_total, 1.0);
  assert.deepEqual(obj.recent24h.forecast.lead30.mae_per_stall, [0.5, 0.4, 0.3, 0.2]);
  assert.equal(obj.throughputScaleK, undefined);
});

test('applyThroughputScaleToAccuracy: throughputScaleK を付与', () => {
  const r = applyThroughputScaleToAccuracy(makeAccuracyObj(), 2.5);
  assert.equal(r.throughputScaleK, 2.5);
});

test('applyThroughputScaleToAccuracy: k=1 は恒等', () => {
  const r = applyThroughputScaleToAccuracy(makeAccuracyObj(), 1);
  assert.equal(r.recent24h.forecast.lead30.mae_total, 1.0);
  assert.deepEqual(r.recent24h.forecast.lead30.mae_per_stall, [0.5, 0.4, 0.3, 0.2]);
  assert.equal(r.throughputScaleK, 1);
});

test('applyThroughputScaleToAccuracy: k が非正・非数値 → 1.0 扱い', () => {
  assert.equal(applyThroughputScaleToAccuracy(makeAccuracyObj(), 0).throughputScaleK, 1);
  assert.equal(applyThroughputScaleToAccuracy(makeAccuracyObj(), -3).throughputScaleK, 1);
  assert.equal(applyThroughputScaleToAccuracy(makeAccuracyObj(), NaN).throughputScaleK, 1);
  const r = applyThroughputScaleToAccuracy(makeAccuracyObj(), 0);
  assert.equal(r.recent24h.forecast.lead30.mae_total, 1.0); // 恒等
});

test('applyThroughputScaleToAccuracy: 構造が欠けても例外を投げない', () => {
  const r = applyThroughputScaleToAccuracy({ schemaVersion: 1 }, 2);
  assert.equal(r.throughputScaleK, 2);
  assert.equal(r.schemaVersion, 1);
});

// --- applyThroughputScale: slotsKey (pattern-match 対応) ---

// pattern-match 形の出力オブジェクトを作る
function makePatternMatchObj() {
  return {
    schemaVersion: 1,
    today: { date: '2026-05-17', dayType: 'sunday_holiday', filterTier: 'all' },
    candidateCount: 5,
    similarDays: [{ date: '2025-05-18', similarity: 0.9, label: 'x' }],
    historicalCurve: [
      { slotStart: '07:45', slotEnd: '07:50', stall1: 1, stall2: 2, stall3: 0, stall4: 3, total: 6 },
      { slotStart: '07:50', slotEnd: '07:55', stall1: 2, stall2: 0, stall3: 1, stall4: 1, total: 4 },
    ],
  };
}

test('applyThroughputScale: slotsKey="historicalCurve" で historicalCurve をスケール', () => {
  const r = applyThroughputScale(makePatternMatchObj(), 2, 'historicalCurve');
  assert.equal(r.historicalCurve[0].stall1, 2);
  assert.equal(r.historicalCurve[0].stall4, 6);
  assert.equal(r.historicalCurve[0].total, 12); // 2+4+0+6
  assert.equal(r.historicalCurve[1].total, 8);  // 4+0+2+2
  assert.equal(r.throughputScaleK, 2);
});

test('applyThroughputScale: slotsKey="historicalCurve" は similarDays/today/metadata を保持', () => {
  const r = applyThroughputScale(makePatternMatchObj(), 2, 'historicalCurve');
  assert.equal(r.today.dayType, 'sunday_holiday');
  assert.equal(r.candidateCount, 5);
  assert.deepEqual(r.similarDays, [{ date: '2025-05-18', similarity: 0.9, label: 'x' }]);
  assert.equal(r.schemaVersion, 1);
});

test('applyThroughputScale: slotsKey 省略時は従来どおり slots をスケール (後方互換)', () => {
  const r = applyThroughputScale(makeForecastObj(), 2);
  assert.equal(r.slots[0].stall1, 4); // makeForecastObj の slots[0].stall1=2 → ×2
  assert.equal(r.slots[0].total, 12); // 4+6+0+2
  assert.equal(r.throughputScaleK, 2);
});

test('applyThroughputScale: slotsKey 配下が配列でない → throughputScaleK のみ付与', () => {
  const r = applyThroughputScale({ schemaVersion: 1, today: {} }, 2, 'historicalCurve');
  assert.equal(r.throughputScaleK, 2);
  assert.equal(r.schemaVersion, 1);
  assert.equal(r.historicalCurve, undefined);
});

test('trackRowDeparted: v4 行 (departedByStall) を合算する', () => {
  const row = { schema_version: 4, ts: '2026-05-19T12:00:00+09:00', cameras: {
    real01_line: { departedByStall: { stall1: 2, stall2: 1 } },
    real02: { departedByStall: { stall4: 3 } },
  } };
  assert.equal(trackRowDeparted(row), 6);
});

test('trackRowDeparted: v3 行 (departed) は従来どおり合算', () => {
  const row = { schema_version: 3, ts: '2026-05-19T12:00:00+09:00', cameras: {
    real01_line: { departed: 4 }, real02: { departed: 1 },
  } };
  assert.equal(trackRowDeparted(row), 5);
});

test('trackRowDepartedByStall: v4 行は乗り場別 dict を返す', () => {
  const row = { schema_version: 4, ts: '2026-05-19T12:00:00+09:00', cameras: {
    real01_line: { departedByStall: { stall1: 2, stall2: 1 } },
    real02: { departedByStall: { stall4: 3 } },
  } };
  assert.deepEqual(trackRowDepartedByStall(row), { stall1: 2, stall2: 1, stall3: 0, stall4: 3 });
});

test('trackRowDepartedByStall: v3 行は null を返す', () => {
  const row = { schema_version: 3, ts: '2026-05-19T12:00:00+09:00', cameras: { real01_line: { departed: 4 } } };
  assert.equal(trackRowDepartedByStall(row), null);
});

// --- v4 schema filter acceptance ---

// v4 track 行を作る (departedByStall)
function makeTrackRowV4(ts, byStall) {
  return {
    schema_version: 4,
    ts,
    cameras: { real01_line: { departedByStall: byStall } },
  };
}

test('TRACK_SCHEMA_VERSIONS: v3 と v4 の両方を含む', () => {
  assert.ok(TRACK_SCHEMA_VERSIONS.includes(3));
  assert.ok(TRACK_SCHEMA_VERSIONS.includes(4));
});

test('sumTrackDepartedInWindow: v4 行 (departedByStall) は合算される (schema フィルタで落とされない)', () => {
  const base = new Date('2026-05-14T10:00:00+09:00').getTime();
  // 60 本の v4 行、各 stall1:1 stall2:1 stall3:1 stall4:1 → 1行あたり departed=4
  const rows = [];
  for (let i = 0; i < 60; i++) {
    rows.push(makeTrackRowV4(
      new Date(base + i * 60000).toISOString(),
      { stall1: 1, stall2: 1, stall3: 1, stall4: 1 },
    ));
  }
  const sum = sumTrackDepartedInWindow(rows, base - 1, base + 60 * 60000, 48);
  assert.equal(sum, 240); // 60 本 × 4
});

test('computeThroughputCalibration: v4 track 行を受理して k を算出する', () => {
  // 12 窓ぶんの net-diff + v4 track 行
  // 各窓 5 本 × stall1:1 stall2:1 = departed 2/本 → trackSum = 12*5*2 = 120
  // netDiff 8/窓 × 12 = 96 → k = 1.25
  const base = new Date('2026-05-14T10:00:00+09:00').getTime();
  const netDiffHistory = [];
  const trackHistory = [];
  for (let i = 0; i < 12; i++) {
    const endMs = base + i * WINDOW_MS;
    netDiffHistory.push(makeNetDiffRow(new Date(endMs).toISOString(), { s1: -8 }));
    for (let j = 0; j < 5; j++) {
      const tsMs = endMs - 30000 - j * 60000;
      trackHistory.push(makeTrackRowV4(
        new Date(tsMs).toISOString(),
        { stall1: 1, stall2: 1, stall3: 0, stall4: 0 },
      ));
    }
  }
  const r = computeThroughputCalibration(netDiffHistory, trackHistory);
  assert.equal(r.windowCount, 12);
  assert.equal(r.state, 'learning');
  assert.equal(r.trackSum, 120);
  assert.equal(r.netDiffSum, 96);
  assert.equal(r.k, 1.25);
});
