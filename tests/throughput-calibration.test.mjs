import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import {
  computeThroughputCalibration,
  WINDOW_MS,
  MIN_WINDOWS_FOR_LEARNING,
  K_MAX,
  sumTrackDepartedInWindow,
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
      trackHistory.push({ schema_version: 1, ts: new Date(tsMs).toISOString(), departed: departedPerTick });
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
  const trackHistory = [0, 1, 2, 3, 4].map(j => ({
    ts: new Date(base - 30000 - j * 60000).toISOString(), departed: 1,
  }));
  const netDiffHistory = [
    makeNetDiffRow(ts, { s1: -5, schema: 2 }),   // schema≠3
    makeNetDiffRow(ts, { s1: -5, lum: 10 }),      // 夜間
    { schema_version: 3, ts, img1: { roi: { luminance_mean: 100 } }, stalls: null }, // stalls null
  ];
  const r = computeThroughputCalibration(netDiffHistory, trackHistory);
  assert.equal(r.windowCount, 0);
});

test('computeThroughputCalibration: net-diff outflow は stall1+2+3 のみ、stall4 は除外', () => {
  // 各窓 stall1 -3 / stall4 -100 → netDiffSum は 12*3=36 のみ
  const { netDiffHistory, trackHistory } = buildFixture(12, { s1: -3, s4: -100, departedPerTick: 5 });
  const r = computeThroughputCalibration(netDiffHistory, trackHistory);
  assert.equal(r.netDiffSum, 36);
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
    rows.push({ ts: new Date(startMs + i * stepMs).toISOString(), departed });
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
