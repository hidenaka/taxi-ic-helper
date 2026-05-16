# 追跡 throughput → forecast 接続 実装 Plan (Phase G-1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** F-3 の車両追跡 throughput (`vehicle-track-history.jsonl` の `departed`) を forecast の `trendFactor` に接続し、直近 outflow 実績信号を粗い net-diff から正確な追跡値に差し替える。

**Architecture:** 純関数モジュール `throughput-calibration.mjs` が track と net-diff を5分窓で突き合わせ累積比 `k` を算出。`computeForecast` は新引数 `trackTrend` を受け、`trendFactor = clip(trackActual / (k × trendExpected))` で単位を揃えて track 経路を使う。track 不足時は net-diff 経路にフォールバック。forecast 出力単位は不変なので D-1・correction・ensemble は非変更。

**Tech Stack:** Node.js ESM (`.mjs`)、`node:test`、純関数。新 pip 依存・新 npm 依存なし。

**Spec:** `docs/superpowers/specs/2026-05-16-throughput-forecast-connection-design.md`

**git 運用:** 本プロジェクトは main 直 push 運用 (feature branch なし)。worktree 不要、main workdir で作業。各 Task の最後に commit → `git pull --rebase --autostash origin main` → `git push origin main`。コミットは scripts/tests/docs のみ、観測データファイル (`data/*-history.jsonl` 等) は混ぜない (`git diff --cached --name-only` で確認)。コミットメッセージ末尾に `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`。

**作業ディレクトリ:** `/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係`（以下、全パスはここからの相対）。

---

## File Structure

| ファイル | 役割 | Task |
|---|---|---|
| `scripts/lib/throughput-calibration.mjs` | **新規**。純関数2つ: `computeThroughputCalibration` (k 算出)、`sumTrackDepartedInWindow` (窓内 departed 合算)。定数群。 | 1, 2 |
| `tests/throughput-calibration.test.mjs` | **新規**。上記2関数の node:test。 | 1, 2 |
| `scripts/lib/forecast-engine.mjs` | **改修**。`computeForecast` に第5引数 `trackTrend` を追加。 | 3 |
| `tests/forecast-engine.test.mjs` | **改修**。`trackTrend` 経路のテストを追加。 | 3 |
| `scripts/observe-taxi-pool.mjs` | **改修**。forecast try ブロックで calibration を算出・JSON 書き出し・`computeForecast` に渡す。 | 4 |
| `scripts/observe-tick-local.sh` | **改修**。`data/throughput-calibration.json` を git checkout/add 行に追加。 | 5 |

---

## Task 1: `throughput-calibration.mjs` — `computeThroughputCalibration`

net-diff history と track history を5分窓で突き合わせ、累積比 `k` を返す純関数。

**Files:**
- Create: `scripts/lib/throughput-calibration.mjs`
- Test: `tests/throughput-calibration.test.mjs`

- [ ] **Step 1: 失敗テストを書く**

`tests/throughput-calibration.test.mjs` を新規作成:

```js
import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import {
  computeThroughputCalibration,
  WINDOW_MS,
  MIN_WINDOWS_FOR_LEARNING,
  K_MAX,
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
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm test -- tests/throughput-calibration.test.mjs 2>&1 | tail -15`
Expected: FAIL — `Cannot find module '.../throughput-calibration.mjs'`

- [ ] **Step 3: `throughput-calibration.mjs` を実装**

`scripts/lib/throughput-calibration.mjs` を新規作成:

```js
/**
 * 追跡 throughput キャリブレーション (Phase G-1)。
 *
 * 設計: docs/superpowers/specs/2026-05-16-throughput-forecast-connection-design.md
 *
 * net-diff outflow は真の出庫 throughput を系統的に過小評価する。
 * F-3 の track departed を5分窓で突き合わせ、累積比 k を算出する。
 * 純関数のみ (副作用なし)。
 */

export const WINDOW_MS = 5 * 60 * 1000;          // net-diff 1 tick = 5 分
export const MIN_TRACK_TICKS_PER_WINDOW = 4;     // k 算出: この本数未満の窓は不採用
export const MIN_WINDOWS_FOR_LEARNING = 12;      // 採用窓がこの数に達したら learning
export const MIN_TRACK_TICKS_FOR_TREND = 48;     // trendActual 用 60 分窓の最小 track 本数
export const K_MIN = 0.5;
export const K_MAX = 5.0;
export const NIGHT_LUMINANCE_THRESHOLD = 30;     // 信頼サブセット条件

/**
 * net-diff history と track history を5分窓で突き合わせ、累積比 k を返す。
 *
 * 信頼サブセット条件: schema_version=3 ∧ img1.roi.luminance_mean>=30 ∧ stalls 非 null。
 * net-diff outflow = stall1+stall2+stall3 の負 diff の絶対値合算 (stall4 は track 対象外)。
 *
 * @param {Array} netDiffHistory taxi-pool-history.jsonl の行配列
 * @param {Array} trackHistory   vehicle-track-history.jsonl の行配列
 * @returns {{k:number, state:string, windowCount:number, trackSum:number, netDiffSum:number}}
 */
export function computeThroughputCalibration(netDiffHistory, trackHistory) {
  // track 行を {tsMs, departed} に1回だけパース
  const trackParsed = [];
  for (const row of trackHistory) {
    const tsMs = new Date(row.ts).getTime();
    if (Number.isNaN(tsMs)) continue;
    const departed = typeof row.departed === 'number' ? row.departed : 0;
    trackParsed.push({ tsMs, departed });
  }

  let trackSum = 0;
  let netDiffSum = 0;
  let windowCount = 0;

  for (const row of netDiffHistory) {
    if (row.schema_version !== 3) continue;
    const lum = row.img1?.roi?.luminance_mean;
    if (typeof lum !== 'number' || lum < NIGHT_LUMINANCE_THRESHOLD) continue;
    if (!row.stalls) continue;
    const endMs = new Date(row.ts).getTime();
    if (Number.isNaN(endMs)) continue;
    const startMs = endMs - WINDOW_MS;

    // 窓 (startMs, endMs] の track departed 合算 + 本数
    let winTrack = 0;
    let winTicks = 0;
    for (const t of trackParsed) {
      if (t.tsMs > startMs && t.tsMs <= endMs) {
        winTrack += t.departed;
        winTicks += 1;
      }
    }
    if (winTicks < MIN_TRACK_TICKS_PER_WINDOW) continue;

    // net-diff outflow = stall1+2+3 の負 diff 絶対値
    let winNetDiff = 0;
    for (const name of ['stall1', 'stall2', 'stall3']) {
      const d = row.stalls[name]?.diff_occupied_from_prev;
      if (typeof d === 'number' && d < 0) winNetDiff += -d;
    }

    trackSum += winTrack;
    netDiffSum += winNetDiff;
    windowCount += 1;
  }

  let state = 'bootstrapping';
  let k = 1.0;
  if (windowCount >= MIN_WINDOWS_FOR_LEARNING) {
    state = 'learning';
    if (netDiffSum > 0) {
      k = Math.max(K_MIN, Math.min(K_MAX, trackSum / netDiffSum));
    }
  }

  return { k, state, windowCount, trackSum, netDiffSum };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm test -- tests/throughput-calibration.test.mjs 2>&1 | tail -15`
Expected: PASS — 9 tests passing。

- [ ] **Step 5: コミット**

```bash
git add scripts/lib/throughput-calibration.mjs tests/throughput-calibration.test.mjs
git diff --cached --name-only   # この2ファイルのみであることを確認
git commit -m "$(cat <<'EOF'
feat(G-1): computeThroughputCalibration 純関数を追加

track と net-diff を5分窓で突き合わせ累積比 k を算出。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git pull --rebase --autostash origin main && git push origin main
```

---

## Task 2: `throughput-calibration.mjs` — `sumTrackDepartedInWindow`

`computeForecast` に渡す `trackActual` (直近60分窓の departed 合算) を算出する純関数。同じファイルに追加。

**Files:**
- Modify: `scripts/lib/throughput-calibration.mjs` (末尾に関数追加)
- Test: `tests/throughput-calibration.test.mjs` (テスト追加)

- [ ] **Step 1: 失敗テストを書く**

`tests/throughput-calibration.test.mjs` の import 文に `sumTrackDepartedInWindow` を追加し、ファイル末尾に以下を追加:

```js
import { sumTrackDepartedInWindow } from '../scripts/lib/throughput-calibration.mjs';

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
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm test -- tests/throughput-calibration.test.mjs 2>&1 | tail -15`
Expected: FAIL — `sumTrackDepartedInWindow is not a function` (または export されていない)。

- [ ] **Step 3: `sumTrackDepartedInWindow` を実装**

`scripts/lib/throughput-calibration.mjs` の末尾に追加:

```js
/**
 * track history のうち ts が (startMs, endMs] に入る行の departed を合算する。
 * 区間内の行数が minTicks 未満なら null (カバレッジ不足のためフォールバックさせる)。
 *
 * @param {Array} trackHistory vehicle-track-history.jsonl の行配列
 * @param {number} startMs 窓開始 (排他)
 * @param {number} endMs   窓終了 (包含)
 * @param {number} minTicks この本数未満なら null
 * @returns {number|null}
 */
export function sumTrackDepartedInWindow(trackHistory, startMs, endMs, minTicks) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  let sum = 0;
  let ticks = 0;
  for (const row of trackHistory) {
    const tsMs = new Date(row.ts).getTime();
    if (Number.isNaN(tsMs)) continue;
    if (tsMs > startMs && tsMs <= endMs) {
      sum += typeof row.departed === 'number' ? row.departed : 0;
      ticks += 1;
    }
  }
  return ticks >= minTicks ? sum : null;
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm test -- tests/throughput-calibration.test.mjs 2>&1 | tail -15`
Expected: PASS — 15 tests passing (Task 1 の 9 + Task 2 の 6)。

- [ ] **Step 5: コミット**

```bash
git add scripts/lib/throughput-calibration.mjs tests/throughput-calibration.test.mjs
git diff --cached --name-only
git commit -m "$(cat <<'EOF'
feat(G-1): sumTrackDepartedInWindow を追加

直近60分窓の track departed 合算。カバレッジ不足は null。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git pull --rebase --autostash origin main && git push origin main
```

---

## Task 3: `computeForecast` に `trackTrend` 引数を追加

`computeForecast` が第5引数 `trackTrend = { k, actual }` を受け、track 経路で `trendFactor` を算出。`trackTrend` が `null`・不正・`recentHistory` 不足のときは現状の net-diff 経路にフォールバック。

**Files:**
- Modify: `scripts/lib/forecast-engine.mjs` (`computeForecast` 関数 — シグネチャ、trendFactor ブロック、return の `trendWindow`)
- Test: `tests/forecast-engine.test.mjs` (末尾にテスト追加)

- [ ] **Step 1: 失敗テストを書く**

`tests/forecast-engine.test.mjs` の末尾に追加:

```js
// --- computeForecast: trackTrend (Phase G-1) ---

// 11:00〜11:55 の 12 tick ぶんの recent を作る
function make12Recent(totalOutflow) {
  return Array.from({ length: 12 }, (_, i) => ({
    ts: new Date(2026, 4, 15, 11, i * 5, 0).toISOString().replace('Z', '+09:00'),
    total_outflow: totalOutflow,
  }));
}

test('computeForecast: trackTrend あり → track 経路で trendFactor = clip(actual/(k*expected))', () => {
  const slots = Array.from({ length: 288 }, () => ({ stall1: 1.0, stall2: 0, stall3: 0, stall4: 0 }));
  const baseline = { slots, sampleCount: 100 };
  const recent = make12Recent(99); // net-diff 値は track 経路では無視される
  // expected = 12 slot × 1.0 = 12、k=2、actual=12 → trendFactor = clip(12/(2*12)) = 0.5
  const trackTrend = { k: 2, actual: 12 };
  const r = computeForecast(baseline, recent, makeArrivals([]), new Date('2026-05-15T12:00:00+09:00'), trackTrend);
  assert.equal(r.trendFactor, 0.5);
  assert.equal(r.trendWindow.source, 'track');
  assert.equal(r.trendWindow.k, 2);
  assert.equal(r.trendWindow.actual, 12);
});

test('computeForecast: trackTrend null → net-diff 経路、source=netdiff, k=null', () => {
  const slots = Array.from({ length: 288 }, () => ({ stall1: 1.0, stall2: 0, stall3: 0, stall4: 0 }));
  const baseline = { slots, sampleCount: 100 };
  const recent = make12Recent(2);
  const r = computeForecast(baseline, recent, makeArrivals([]), new Date('2026-05-15T12:00:00+09:00'), null);
  assert.equal(r.trendFactor, 2); // net-diff: 24/12
  assert.equal(r.trendWindow.source, 'netdiff');
  assert.equal(r.trendWindow.k, null);
});

test('computeForecast: trackTrend あっても recent 12 未満 → net-diff 経路にフォールバック', () => {
  const slots = Array.from({ length: 288 }, () => ({ stall1: 1.0, stall2: 0, stall3: 0, stall4: 0 }));
  const baseline = { slots, sampleCount: 100 };
  const r = computeForecast(baseline, [], makeArrivals([]), new Date('2026-05-15T12:00:00+09:00'), { k: 2, actual: 12 });
  assert.equal(r.trendFactor, 1.0);
  assert.equal(r.trendWindow.source, 'netdiff');
});

test('computeForecast: trackTrend.k が 0 以下 → net-diff 経路にフォールバック', () => {
  const slots = Array.from({ length: 288 }, () => ({ stall1: 1.0, stall2: 0, stall3: 0, stall4: 0 }));
  const baseline = { slots, sampleCount: 100 };
  const recent = make12Recent(2);
  const r = computeForecast(baseline, recent, makeArrivals([]), new Date('2026-05-15T12:00:00+09:00'), { k: 0, actual: 12 });
  assert.equal(r.trendWindow.source, 'netdiff');
  assert.equal(r.trendFactor, 2);
});

test('computeForecast: 4 引数呼び出し (trackTrend 省略) は従来どおり動く', () => {
  const slots = Array.from({ length: 288 }, () => ({ stall1: 1.0, stall2: 0, stall3: 0, stall4: 0 }));
  const baseline = { slots, sampleCount: 100 };
  const recent = make12Recent(2);
  const r = computeForecast(baseline, recent, makeArrivals([]), new Date('2026-05-15T12:00:00+09:00'));
  assert.equal(r.trendFactor, 2);
  assert.equal(r.trendWindow.source, 'netdiff');
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm test -- tests/forecast-engine.test.mjs 2>&1 | tail -15`
Expected: FAIL — `r.trendWindow.source` が `undefined` 等。

- [ ] **Step 3: `computeForecast` を改修**

`scripts/lib/forecast-engine.mjs` の `computeForecast` を3箇所変更する。

**3a. シグネチャ** (現 `export function computeForecast(baseline, recentHistory, arrivalsJson, now) {`) を以下に置換:

```js
export function computeForecast(baseline, recentHistory, arrivalsJson, now, trackTrend = null) {
```

**3b. trendFactor ブロック** — 現在の以下のブロック:

```js
  // --- trendFactor ---
  let trendFactor = 1.0;
  let trendActual = 0;
  let trendExpected = 0;
  if (recentHistory.length >= TREND_WINDOW_TICKS) {
    const window = recentHistory.slice(-TREND_WINDOW_TICKS);
    for (const row of window) {
      if (typeof row.total_outflow === 'number') {
        trendActual += row.total_outflow;
      }
      const ts = new Date(row.ts);
      if (!Number.isNaN(ts.getTime())) {
        const slot = baseline.slots[slotKey(ts.getHours(), ts.getMinutes())];
        if (slot && slot.stall1 !== null) {
          trendExpected += (slot.stall1 + slot.stall2 + slot.stall3 + slot.stall4);
        }
      }
    }
    if (trendExpected > 0) {
      trendFactor = clip(trendActual / trendExpected, TREND_FACTOR_MIN, TREND_FACTOR_MAX);
    }
  }
```

を、以下に置換:

```js
  // --- trendFactor ---
  // trackTrend ({ k, actual }) があれば track 経路、無ければ net-diff 経路 (Phase G-1)。
  let trendFactor = 1.0;
  let trendActual = 0;
  let trendExpected = 0;
  let trendSource = 'netdiff';
  let trendK = null;
  if (recentHistory.length >= TREND_WINDOW_TICKS) {
    const window = recentHistory.slice(-TREND_WINDOW_TICKS);
    for (const row of window) {
      if (typeof row.total_outflow === 'number') {
        trendActual += row.total_outflow;
      }
      const ts = new Date(row.ts);
      if (!Number.isNaN(ts.getTime())) {
        const slot = baseline.slots[slotKey(ts.getHours(), ts.getMinutes())];
        if (slot && slot.stall1 !== null) {
          trendExpected += (slot.stall1 + slot.stall2 + slot.stall3 + slot.stall4);
        }
      }
    }
    const useTrack = trackTrend !== null
      && typeof trackTrend.actual === 'number'
      && typeof trackTrend.k === 'number'
      && trackTrend.k > 0
      && trendExpected > 0;
    if (useTrack) {
      // track 経路: k で net-diff baseline と単位を揃える
      trendActual = trackTrend.actual;
      trendSource = 'track';
      trendK = trackTrend.k;
      trendFactor = clip(trendActual / (trackTrend.k * trendExpected), TREND_FACTOR_MIN, TREND_FACTOR_MAX);
    } else if (trendExpected > 0) {
      trendFactor = clip(trendActual / trendExpected, TREND_FACTOR_MIN, TREND_FACTOR_MAX);
    }
  }
```

**3c. return の `trendWindow`** — 現在の行:

```js
    trendWindow: { actual: trendActual, expected: trendExpected, ticks: Math.min(recentHistory.length, TREND_WINDOW_TICKS) },
```

を、以下に置換:

```js
    trendWindow: { actual: trendActual, expected: trendExpected, ticks: Math.min(recentHistory.length, TREND_WINDOW_TICKS), source: trendSource, k: trendK },
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm test -- tests/forecast-engine.test.mjs 2>&1 | tail -15`
Expected: PASS — 既存テスト + 新規 5 件すべて pass。

- [ ] **Step 5: 全体回帰テスト**

Run: `npm test 2>&1 | tail -15`
Expected: PASS — 全件 pass (407 → 約 427)。fail 0。

- [ ] **Step 6: コミット**

```bash
git add scripts/lib/forecast-engine.mjs tests/forecast-engine.test.mjs
git diff --cached --name-only
git commit -m "$(cat <<'EOF'
feat(G-1): computeForecast に trackTrend 引数を追加

track 経路で trendFactor = clip(actual/(k*expected))。
trackTrend null/不正/recent不足 時は net-diff 経路にフォールバック。
trendWindow に source/k を追加。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git pull --rebase --autostash origin main && git push origin main
```

---

## Task 4: `observe-taxi-pool.mjs` のオーケストレーション

forecast try ブロックで calibration を算出し `data/throughput-calibration.json` を書き出し、`trackActual` を算出して `computeForecast` に渡す。

**Files:**
- Modify: `scripts/observe-taxi-pool.mjs` (import、`_PATH` 定数、forecast try ブロック)

> このスクリプトは observe ジョブ本体で、単体テストハーネスを持たない。検証は構文チェック + 全体回帰テストで行う (実ランタイムは Mac mini の次 observe tick で確認)。純関数のロジックは Task 1〜3 で完全にテスト済み。

- [ ] **Step 1: import 文を追加**

`scripts/observe-taxi-pool.mjs` の `import { computeBaseline, computeForecast } from './lib/forecast-engine.mjs';` (L18) の直後に追加:

```js
import {
  computeThroughputCalibration,
  sumTrackDepartedInWindow,
  MIN_TRACK_TICKS_FOR_TREND,
} from './lib/throughput-calibration.mjs';
```

- [ ] **Step 2: `_PATH` 定数を追加**

`const T3_POOL_HISTORY_PATH = './data/t3-pool-history.jsonl';` (L46) の直後に追加:

```js
const TRACK_HISTORY_PATH = './data/vehicle-track-history.jsonl';
const THROUGHPUT_CALIBRATION_PATH = './data/throughput-calibration.json';
```

- [ ] **Step 3: forecast try ブロックを改修**

`scripts/observe-taxi-pool.mjs` の forecast try ブロック内、現在の以下の部分:

```js
    const recent = allHistory.slice(-12).map(r => {
      const stalls = r.stalls || {};
      let totalOutflow = 0;
      for (const name of ['stall1', 'stall2', 'stall3', 'stall4']) {
        const d = stalls[name]?.diff_occupied_from_prev;
        if (typeof d === 'number' && d < 0) totalOutflow += -d;
      }
      return { ts: r.ts, total_outflow: totalOutflow };
    });

    forecastResult = computeForecast(baseline, recent, arrivalsJson, new Date());
```

を、以下に置換:

```js
    const recent = allHistory.slice(-12).map(r => {
      const stalls = r.stalls || {};
      let totalOutflow = 0;
      for (const name of ['stall1', 'stall2', 'stall3', 'stall4']) {
        const d = stalls[name]?.diff_occupied_from_prev;
        if (typeof d === 'number' && d < 0) totalOutflow += -d;
      }
      return { ts: r.ts, total_outflow: totalOutflow };
    });

    // Phase G-1: 追跡 throughput キャリブレーション
    const trackHistory = [];
    if (existsSync(TRACK_HISTORY_PATH)) {
      for (const line of readFileSync(TRACK_HISTORY_PATH, 'utf8').trim().split('\n')) {
        if (!line.trim()) continue;
        try { trackHistory.push(JSON.parse(line)); } catch { /* skip bad line */ }
      }
    }
    const calibration = computeThroughputCalibration(allHistory, trackHistory);
    writeFileSync(THROUGHPUT_CALIBRATION_PATH, JSON.stringify({
      schema_version: 1,
      generated_at: jstNowIso(),
      k: calibration.k,
      state: calibration.state,
      window_count: calibration.windowCount,
      track_sum: calibration.trackSum,
      netdiff_sum: calibration.netDiffSum,
    }, null, 2) + '\n', 'utf8');

    // trendActual: 直近60分窓 (recent の最古 tick 〜 now) の track departed 合算
    const now = new Date();
    let trackTrend = null;
    if (calibration.state === 'learning' && recent.length >= 12) {
      const windowStartMs = new Date(recent[0].ts).getTime();
      const trackActual = sumTrackDepartedInWindow(
        trackHistory, windowStartMs, now.getTime(), MIN_TRACK_TICKS_FOR_TREND,
      );
      if (trackActual !== null) {
        trackTrend = { k: calibration.k, actual: trackActual };
      }
    }

    forecastResult = computeForecast(baseline, recent, arrivalsJson, now, trackTrend);
```

> 補足: 上記は forecast try ブロック内にあるため、calibration 算出や JSON 書き出しが失敗しても既存の `catch (e)` が握り、本観測は影響を受けない (spec のエラーハンドリング表「calibration 算出全体の失敗」)。

- [ ] **Step 4: 構文チェック**

Run: `node --check scripts/observe-taxi-pool.mjs && echo SYNTAX_OK`
Expected: `SYNTAX_OK`

- [ ] **Step 5: 全体回帰テスト**

Run: `npm test 2>&1 | tail -15`
Expected: PASS — 全件 pass、fail 0 (observe-taxi-pool.mjs は import 解決のみ確認、テスト数は Task 3 と同じ)。

- [ ] **Step 6: コミット**

```bash
git add scripts/observe-taxi-pool.mjs
git diff --cached --name-only   # scripts/observe-taxi-pool.mjs のみ。data/ が混ざっていないこと
git commit -m "$(cat <<'EOF'
feat(G-1): observe-taxi-pool で throughput calibration を配線

vehicle-track-history を読み込み throughput-calibration.json を生成、
learning 状態かつ track カバレッジ十分なら computeForecast に
trackTrend を渡す。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git pull --rebase --autostash origin main && git push origin main
```

---

## Task 5: `observe-tick-local.sh` の git 配線

`data/throughput-calibration.json` は再生成系 JSON。observe-tick の pull 前 checkout と git add に追加する。

**Files:**
- Modify: `scripts/observe-tick-local.sh` (3 行)

- [ ] **Step 1: pull 前 checkout 2 行を更新**

`scripts/observe-tick-local.sh` 内に 2 箇所ある以下の行 (L42, L50、同一内容):

```bash
  git checkout HEAD -- data/stall-forecast.json data/stall-pattern-match.json data/forecast-accuracy.json data/stall-ensemble.json data/coefficient-corrections.json 2>/dev/null || true
```

と

```bash
git checkout HEAD -- data/stall-forecast.json data/stall-pattern-match.json data/forecast-accuracy.json data/stall-ensemble.json data/coefficient-corrections.json 2>/dev/null || true
```

の両方について、`data/coefficient-corrections.json` の直後に ` data/throughput-calibration.json` を追加する。置換後はそれぞれ:

```bash
  git checkout HEAD -- data/stall-forecast.json data/stall-pattern-match.json data/forecast-accuracy.json data/stall-ensemble.json data/coefficient-corrections.json data/throughput-calibration.json 2>/dev/null || true
```

```bash
git checkout HEAD -- data/stall-forecast.json data/stall-pattern-match.json data/forecast-accuracy.json data/stall-ensemble.json data/coefficient-corrections.json data/throughput-calibration.json 2>/dev/null || true
```

(先頭インデントの有無が L42 と L50 で異なる点に注意。それぞれ既存のインデントを保つこと。)

- [ ] **Step 2: git add 行を更新**

`scripts/observe-tick-local.sh` L75 の以下の行:

```bash
git add data/taxi-pool-history.jsonl data/stall-forecast.json data/stall-pattern-match.json data/forecast-accuracy.json data/stall-ensemble.json data/coefficient-corrections.json data/t3-pool-history.jsonl data/vehicle-detection-history.jsonl data/vehicle-track-history.jsonl 2>/dev/null || true
```

の `data/vehicle-track-history.jsonl` の直後に ` data/throughput-calibration.json` を追加:

```bash
git add data/taxi-pool-history.jsonl data/stall-forecast.json data/stall-pattern-match.json data/forecast-accuracy.json data/stall-ensemble.json data/coefficient-corrections.json data/t3-pool-history.jsonl data/vehicle-detection-history.jsonl data/vehicle-track-history.jsonl data/throughput-calibration.json 2>/dev/null || true
```

- [ ] **Step 3: 検証**

Run: `bash -n scripts/observe-tick-local.sh && echo SYNTAX_OK && grep -c "throughput-calibration.json" scripts/observe-tick-local.sh`
Expected: `SYNTAX_OK` の後に `3` (checkout 2 + add 1)。

- [ ] **Step 4: コミット**

```bash
git add scripts/observe-tick-local.sh
git diff --cached --name-only
git commit -m "$(cat <<'EOF'
chore(G-1): throughput-calibration.json を observe-tick の git 配線に追加

再生成系 JSON。pull 前 checkout と git add 対象に追加。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git pull --rebase --autostash origin main && git push origin main
```

---

## 完了後

全 Task 完了後の状態:

- `npm test` 全件 pass (約 427 件、新規 throughput-calibration 15 + forecast-engine 5)。
- 次の observe tick (Mac mini) で `data/throughput-calibration.json` が生成され、`bootstrapping` 状態 (track データがまだ少ないため) で始まる。
- track データが MIN_WINDOWS_FOR_LEARNING (12 窓 = 重複5分窓 12 個) ぶん溜まると `learning` に遷移し、`stall-forecast.json` の `trendWindow.source` が `track` に変わる。
- D-1 精度評価・correction-engine・ensemble・F-1・F-2・F-3 は不変。

**Mac mini デプロイ:** `~/repos/taxi-ic-helper` で `git pull` するのみ (新 pip/npm 依存なし、launchd 変更なし)。次の observe tick から自動で有効。

**ロードマップ残 (本 plan のスコープ外):** baseline 出力の真値化 (B案、別 spec)、複数カメラ追跡、検出ベース並行 forecast。
