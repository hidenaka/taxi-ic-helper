# トラッカー実測アンカー型 予測土台 再設計 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 予測のレベルを F-3 トラッカー実測出庫レートにアンカーし、満車（net-diff=0）時でも非0の予測が出るようにする。

**Architecture:** `computeForecast` に「トラッカーアンカー経路」を追加。`予測総数[i] = 実測出庫レート × フライト需要比[i]` を算出し、乗り場別に按分する。`trackTrend` が無効な時は現行の net-diff 経路へフォールバック。`computeEnsemble` には pattern-match が構造的0の時の希釈ガードを追加。

**Tech Stack:** Node.js ESM（`.mjs`）、`node:test`、`npm test`。

設計書: `docs/superpowers/specs/2026-05-18-tracker-anchored-forecast-design.md`

## 前提知識（このプロジェクト固有）

- `computeForecast(baseline, recentHistory, arrivalsJson, now, trackTrend)` — `forecast-engine.mjs`。本計画で**オプション第6引数 `latestOccupancy` を追加**（後方互換、既定 null）。設計書 §5 は「引数不変」としていたが、乗り場別按分に最新占有が必要なため1引数追加する（設計 B1 自体は不変）。
- `recentHistory` の各行は `{ ts, total_outflow }` のみ（乗り場別占有は持たない）。
- `flightSums[i]`（既存）= 将来スロット i に `lobbyExitTime` が入る便の `estimatedTaxiPax` 合計。
- `TREND_WINDOW_TICKS = 12`、`FORECAST_SLOT_COUNT = 24`、`SLOTS_PER_DAY = 288`、`FLIGHT_FACTOR_MIN = 0.3`、`FLIGHT_FACTOR_MAX = 3.0` — すべて `forecast-engine.mjs` の既存 export。
- `slotKey(h, m)` / `clip(v, min, max)` も既存 export。
- git: main 直 push。commit メッセージ末尾に `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`。commit 前に `git diff --cached --name-only` で `data/` 混入なしを確認。

## ファイル構成

| ファイル | 変更 | 責務 |
|---|---|---|
| `scripts/lib/forecast-engine.mjs` | Modify: `flightDemand`/`splitTotalToStalls` を新設、`computeForecast` にトラッカーアンカー経路追加 | ルールベース予測 |
| `tests/forecast-engine.test.mjs` | Modify: テスト追加 | 〃テスト |
| `scripts/lib/ensemble-engine.mjs` | Modify: `computeEnsemble` に希釈ガード | アンサンブル統合 |
| `tests/ensemble-engine.test.mjs` | Modify: テスト追加 | 〃テスト |
| `scripts/observe-taxi-pool.mjs` | Modify: `computeForecast` 呼び出しに `latestOccupancy` を渡す | パイプライン配線 |
| `scripts/tmp-verify-tracker-forecast.mjs` | Create（一時・コミットしない） | 実データ検証 |

---

## Task 1: フライト需要ヘルパー `flightDemand`

**Files:**
- Modify: `scripts/lib/forecast-engine.mjs`（`computeForecast` の前に新規 export 関数を追加）
- Test: `tests/forecast-engine.test.mjs`（末尾に追加）

- [ ] **Step 1: 失敗するテストを書く**

`tests/forecast-engine.test.mjs` の末尾に追加。冒頭の import に `flightDemand` を加える必要がある — ファイル先頭の `import { ... } from '../scripts/lib/forecast-engine.mjs';` に `flightDemand` を追記すること。

```javascript

test('flightDemand: 将来スロット別の便需要と直近窓の便需要を返す', () => {
  // now=12:00 → nowSlot=slotKey(12,0)=144。将来スロット0 = slot145 = 12:05。
  // 直近窓 = nowSlot-11..nowSlot = slot133..144 = 11:05..12:00。
  const arrivals = { flights: [
    { lobbyExitTime: '12:05', estimatedTaxiPax: 30 }, // 将来 slot0
    { lobbyExitTime: '12:10', estimatedTaxiPax: 12 }, // 将来 slot1
    { lobbyExitTime: '11:30', estimatedTaxiPax: 20 }, // 直近窓内
    { lobbyExitTime: '11:35', estimatedTaxiPax: 8 },  // 直近窓内
    { lobbyExitTime: '09:00', estimatedTaxiPax: 99 }, // 窓外 → 無視
  ] };
  const r = flightDemand(arrivals, slotKey(12, 0));
  assert.equal(r.futureSums.length, 24);
  assert.equal(r.futureSums[0], 30);
  assert.equal(r.futureSums[1], 12);
  assert.equal(r.recentSum, 28); // 20 + 8
});

test('flightDemand: arrivals が null → 全0', () => {
  const r = flightDemand(null, slotKey(12, 0));
  assert.equal(r.futureSums.length, 24);
  assert.equal(r.futureSums.every(v => v === 0), true);
  assert.equal(r.recentSum, 0);
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `node --test tests/forecast-engine.test.mjs`
Expected: FAIL — `flightDemand` が未定義（import エラー or ReferenceError）。

- [ ] **Step 3: `flightDemand` を実装**

`scripts/lib/forecast-engine.mjs` の `computeForecast` 関数定義（`export function computeForecast`）の**直前**に追加する。

```javascript
/**
 * フライト需要を算出する。
 * @param {{flights: Array}|null} arrivalsJson arrivals.json
 * @param {number} nowSlot 現在スロット index
 * @returns {{futureSums: number[], recentSum: number}}
 *   futureSums[i] = 将来スロット i (now+1+i) の estimatedTaxiPax 合計、
 *   recentSum = 直近 TREND_WINDOW_TICKS スロット (nowSlot-11..nowSlot) の合計。
 */
export function flightDemand(arrivalsJson, nowSlot) {
  const futureSums = new Array(FORECAST_SLOT_COUNT).fill(0);
  let recentSum = 0;
  if (!arrivalsJson || !Array.isArray(arrivalsJson.flights)) {
    return { futureSums, recentSum };
  }
  const recentSlots = new Set();
  for (let k = 0; k < TREND_WINDOW_TICKS; k++) {
    recentSlots.add((nowSlot - k + SLOTS_PER_DAY) % SLOTS_PER_DAY);
  }
  for (const f of arrivalsJson.flights) {
    if (!f.lobbyExitTime || typeof f.estimatedTaxiPax !== 'number') continue;
    const [h, m] = f.lobbyExitTime.split(':').map(Number);
    if (Number.isNaN(h) || Number.isNaN(m)) continue;
    const lobbySlot = slotKey(h, m);
    if (recentSlots.has(lobbySlot)) recentSum += f.estimatedTaxiPax;
    for (let i = 0; i < FORECAST_SLOT_COUNT; i++) {
      if (((nowSlot + 1 + i) % SLOTS_PER_DAY) === lobbySlot) {
        futureSums[i] += f.estimatedTaxiPax;
        break;
      }
    }
  }
  return { futureSums, recentSum };
}
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `node --test tests/forecast-engine.test.mjs`
Expected: PASS — 既存テスト＋新規2件すべてパス。

- [ ] **Step 5: コミット**

```bash
git add scripts/lib/forecast-engine.mjs tests/forecast-engine.test.mjs
git diff --cached --name-only
git commit -m "$(cat <<'EOF'
feat(forecast-engine): フライト需要ヘルパー flightDemand を追加

将来スロット別の便需要と直近窓の便需要を算出する純関数。
トラッカーアンカー型予測の前向き形状（便需要比）に使う。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: 乗り場別按分ヘルパー `splitTotalToStalls`

**Files:**
- Modify: `scripts/lib/forecast-engine.mjs`（`computeForecast` の前に新規 export 関数を追加）
- Test: `tests/forecast-engine.test.mjs`（末尾に追加）

- [ ] **Step 1: 失敗するテストを書く**

`tests/forecast-engine.test.mjs` 末尾に追加。ファイル先頭の import に `splitTotalToStalls` を追記すること。

```javascript

test('splitTotalToStalls: 占有比で按分する', () => {
  // 占有 2/2/4/2 = 計10 → 比 0.2/0.2/0.4/0.2
  const r = splitTotalToStalls(10, { stall1: 2, stall2: 2, stall3: 4, stall4: 2 });
  assert.equal(r.stall1, 2);
  assert.equal(r.stall2, 2);
  assert.equal(r.stall3, 4);
  assert.equal(r.stall4, 2);
});

test('splitTotalToStalls: 占有が null → 均等配分', () => {
  const r = splitTotalToStalls(8, null);
  assert.equal(r.stall1, 2);
  assert.equal(r.stall2, 2);
  assert.equal(r.stall3, 2);
  assert.equal(r.stall4, 2);
});

test('splitTotalToStalls: 占有合計が0 → 均等配分', () => {
  const r = splitTotalToStalls(8, { stall1: 0, stall2: 0, stall3: 0, stall4: 0 });
  assert.equal(r.stall1, 2);
  assert.equal(r.stall4, 2);
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `node --test tests/forecast-engine.test.mjs`
Expected: FAIL — `splitTotalToStalls` 未定義。

- [ ] **Step 3: `splitTotalToStalls` を実装**

`scripts/lib/forecast-engine.mjs` の `computeForecast` 定義の直前（`flightDemand` の後）に追加する。

```javascript
/**
 * 出庫総数を乗り場別に按分する。
 * @param {number} total 5分スロットの出庫総数
 * @param {{stall1,stall2,stall3,stall4}|null} occupancy 直近の各乗り場占有数。
 *   null または合計0なら均等配分。
 * @returns {{stall1,stall2,stall3,stall4}}
 */
export function splitTotalToStalls(total, occupancy) {
  const names = ['stall1', 'stall2', 'stall3', 'stall4'];
  let occSum = 0;
  if (occupancy) {
    for (const n of names) {
      const v = occupancy[n];
      if (typeof v === 'number' && v > 0) occSum += v;
    }
  }
  const out = {};
  for (const n of names) {
    const share = occSum > 0 ? ((occupancy[n] > 0 ? occupancy[n] : 0) / occSum) : 0.25;
    out[n] = total * share;
  }
  return out;
}
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `node --test tests/forecast-engine.test.mjs`
Expected: PASS — 新規3件を含め全件パス。

- [ ] **Step 5: コミット**

```bash
git add scripts/lib/forecast-engine.mjs tests/forecast-engine.test.mjs
git diff --cached --name-only
git commit -m "$(cat <<'EOF'
feat(forecast-engine): 乗り場別按分ヘルパー splitTotalToStalls を追加

出庫総数を直近占有比で stall1-4 へ按分する純関数。
占有データが無い/合計0なら均等配分。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: computeForecast にトラッカーアンカー経路を追加

**Files:**
- Modify: `scripts/lib/forecast-engine.mjs`（`computeForecast`）
- Test: `tests/forecast-engine.test.mjs`（末尾に追加）

- [ ] **Step 1: 失敗するテストを書く**

`tests/forecast-engine.test.mjs` 末尾に追加。`computeForecast` と `makeArrivals` は既存。

```javascript

test('computeForecast: トラッカーアンカー経路 — baseline 全0でも非0予測を出す', () => {
  // baseline 全0（満車で net-diff=0 を模す）。trackTrend 有効。
  const baseline = {
    slots: Array.from({ length: 288 }, () => ({ stall1: 0, stall2: 0, stall3: 0, stall4: 0 })),
    sampleCount: 100,
  };
  const recent = Array.from({ length: 12 }, (_, i) => ({
    ts: new Date(2026, 4, 15, 11, i * 5, 0).toISOString().replace('Z', '+09:00'),
    total_outflow: 0,
  }));
  // now=12:00。便需要なし → demandRatio=1.0。trackTrend.actual=60 → rate=60/12=5/slot。
  const trackTrend = { k: 5, actual: 60 };
  const r = computeForecast(baseline, recent, makeArrivals([]), new Date('2026-05-15T12:00:00+09:00'), trackTrend, null);
  assert.equal(r.trendWindow.levelSource, 'track-anchored');
  // 便需要なし → 各スロット total = trackRatePerSlot = 5。均等配分で各 stall 1.25。
  assert.equal(r.slots[0].total, 5);
  assert.equal(r.slots[0].stall1, 1.25);
});

test('computeForecast: トラッカーアンカー経路 — 便需要比でスロットが変調される', () => {
  const baseline = {
    slots: Array.from({ length: 288 }, () => ({ stall1: 0, stall2: 0, stall3: 0, stall4: 0 })),
    sampleCount: 100,
  };
  const recent = Array.from({ length: 12 }, (_, i) => ({
    ts: new Date(2026, 4, 15, 11, i * 5, 0).toISOString().replace('Z', '+09:00'),
    total_outflow: 0,
  }));
  // 直近窓に便需要 120（11:05〜12:00 のどこか）→ recentPerSlot = 120/12 = 10。
  // 将来 slot0 (12:05) に便需要 20 → demandRatio = clip(20/10)=2.0。
  // trackRatePerSlot = 60/12 = 5 → slot0 total = 5 * 2.0 = 10。
  const arrivals = makeArrivals([
    { lobbyExitTime: '11:30', estimatedTaxiPax: 120 },
    { lobbyExitTime: '12:05', estimatedTaxiPax: 20 },
  ]);
  const r = computeForecast(baseline, recent, arrivals, new Date('2026-05-15T12:00:00+09:00'), { k: 5, actual: 60 }, null);
  assert.equal(r.slots[0].total, 10);
});

test('computeForecast: トラッカーアンカー経路 — latestOccupancy で乗り場別按分', () => {
  const baseline = {
    slots: Array.from({ length: 288 }, () => ({ stall1: 0, stall2: 0, stall3: 0, stall4: 0 })),
    sampleCount: 100,
  };
  const recent = Array.from({ length: 12 }, (_, i) => ({
    ts: new Date(2026, 4, 15, 11, i * 5, 0).toISOString().replace('Z', '+09:00'),
    total_outflow: 0,
  }));
  // 占有 4/2/2/0 = 計8 → 比 0.5/0.25/0.25/0。total=5 → 2.5/1.25/1.25/0。
  const r = computeForecast(baseline, recent, makeArrivals([]), new Date('2026-05-15T12:00:00+09:00'),
    { k: 5, actual: 60 }, { stall1: 4, stall2: 2, stall3: 2, stall4: 0 });
  assert.equal(r.slots[0].stall1, 2.5);
  assert.equal(r.slots[0].stall2, 1.25);
  assert.equal(r.slots[0].stall4, 0);
});

test('computeForecast: trackTrend null → 従来の net-diff 経路（後方互換）', () => {
  const slots = Array.from({ length: 288 }, () => ({ stall1: 1.0, stall2: 0, stall3: 0, stall4: 0 }));
  const baseline = { slots, sampleCount: 100 };
  const r = computeForecast(baseline, [], makeArrivals([]), new Date('2026-05-15T12:00:00+09:00'), null);
  assert.equal(r.trendWindow.levelSource, 'netdiff-fallback');
  assert.equal(r.slots[0].stall1, 1); // 1.0 * trendFactor(1) * flightFactor(1)
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `node --test tests/forecast-engine.test.mjs`
Expected: FAIL — `levelSource` が未定義、トラッカーアンカー経路が無く baseline 全0で予測0になる。

- [ ] **Step 3: computeForecast を実装**

`scripts/lib/forecast-engine.mjs` の `computeForecast`。シグネチャに `latestOccupancy = null` を追加し、`// --- 各 slot の予測 ---` のブロック（現状 154-177 行）の直前に分岐を入れる。

シグネチャ変更:
```javascript
export function computeForecast(baseline, recentHistory, arrivalsJson, now, trackTrend = null, latestOccupancy = null) {
```

`// --- flightFactor[slot_t] ---` ブロック（130-151 行）はそのまま残す（net-diff 経路が使う）。その後、`// --- 各 slot の予測 ---` の直前に以下を追加し、スロット予測ループを分岐させる。

変更前（154-177 行）:
```javascript
  // --- 各 slot の予測 ---
  const outSlots = [];
  for (let i = 0; i < FORECAST_SLOT_COUNT; i++) {
    const targetSlot = (nowSlot + 1 + i) % SLOTS_PER_DAY;
    const slotStartMin = targetSlot * 5;
    const startH = Math.floor(slotStartMin / 60) % 24;
    const startM = slotStartMin % 60;
    const endTotal = slotStartMin + 5;
    const endH = Math.floor(endTotal / 60) % 24;
    const endM = endTotal % 60;
    const fmt = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    const base = baseline.slots[targetSlot] || { stall1: null, stall2: null, stall3: null, stall4: null };
    const f = flightFactors[i];
    const slotOut = { slotStart: fmt(startH, startM), slotEnd: fmt(endH, endM), flightFactor: f };
    let total = 0;
    for (const name of ['stall1', 'stall2', 'stall3', 'stall4']) {
      const b = base[name];
      // 小数のまま保持する。整数化は書き出し時の applyThroughputScale (round(値×k)) で1回だけ行う。
      const val = (b === null || b === undefined) ? 0 : b * trendFactor * f;
      slotOut[name] = val;
      total += val;
    }
    slotOut.total = total;
    outSlots.push(slotOut);
  }
```

変更後:
```javascript
  // --- トラッカーアンカー経路の判定 ---
  // trackTrend ({k, actual}) が有効なら、予測レベルを net-diff baseline でなく
  // トラッカー実測出庫レートにアンカーする。満車で baseline=0 でも予測が出る。
  const useTrackAnchor = trackTrend !== null
    && typeof trackTrend.actual === 'number'
    && trackTrend.actual >= 0;
  const levelSource = useTrackAnchor ? 'track-anchored' : 'netdiff-fallback';

  const fmt = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

  // --- 各 slot の予測 ---
  const outSlots = [];
  let trackRatePerSlot = 0;
  let demandRatios = null;
  if (useTrackAnchor) {
    trackRatePerSlot = trackTrend.actual / TREND_WINDOW_TICKS;
    const demand = flightDemand(arrivalsJson, nowSlot);
    const recentPerSlot = demand.recentSum / TREND_WINDOW_TICKS;
    demandRatios = demand.futureSums.map(s => {
      if (recentPerSlot <= 0) return 1.0;
      return clip(s / recentPerSlot, FLIGHT_FACTOR_MIN, FLIGHT_FACTOR_MAX);
    });
  }
  for (let i = 0; i < FORECAST_SLOT_COUNT; i++) {
    const targetSlot = (nowSlot + 1 + i) % SLOTS_PER_DAY;
    const slotStartMin = targetSlot * 5;
    const startH = Math.floor(slotStartMin / 60) % 24;
    const startM = slotStartMin % 60;
    const endTotal = slotStartMin + 5;
    const endH = Math.floor(endTotal / 60) % 24;
    const endM = endTotal % 60;
    const base = baseline.slots[targetSlot] || { stall1: null, stall2: null, stall3: null, stall4: null };
    const f = flightFactors[i];
    const slotOut = { slotStart: fmt(startH, startM), slotEnd: fmt(endH, endM), flightFactor: f };
    let total = 0;
    if (useTrackAnchor) {
      // トラッカーアンカー: 実測レート × 便需要比 → 乗り場別按分。
      const slotTotal = trackRatePerSlot * demandRatios[i];
      const split = splitTotalToStalls(slotTotal, latestOccupancy);
      for (const name of ['stall1', 'stall2', 'stall3', 'stall4']) {
        slotOut[name] = split[name];
        total += split[name];
      }
    } else {
      // net-diff フォールバック経路（従来どおり）。
      for (const name of ['stall1', 'stall2', 'stall3', 'stall4']) {
        const b = base[name];
        // 小数のまま保持する。整数化は書き出し時の applyThroughputScale (round(値×k)) で1回だけ行う。
        const val = (b === null || b === undefined) ? 0 : b * trendFactor * f;
        slotOut[name] = val;
        total += val;
      }
    }
    slotOut.total = total;
    outSlots.push(slotOut);
  }
```

次に return 文の `trendWindow` に `levelSource` を追加する。

変更前:
```javascript
    trendWindow: { actual: trendActual, expected: trendExpected, ticks: Math.min(recentHistory.length, TREND_WINDOW_TICKS), source: trendSource, k: trendK },
```

変更後:
```javascript
    trendWindow: { actual: trendActual, expected: trendExpected, ticks: Math.min(recentHistory.length, TREND_WINDOW_TICKS), source: trendSource, k: trendK, levelSource },
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `node --test tests/forecast-engine.test.mjs`
Expected: PASS — トラッカーアンカー4件＋既存テスト（net-diff 経路は `trackTrend` 無し or 既存のものはそのまま）すべてパス。既存テストで `trackTrend` を渡しているもの（G-1 の track テスト）は `useTrackAnchor` 経路に入る点に注意 — もし既存の track テストが旧 net-diff 計算前提のアサーションで落ちたら、STOP してユーザーに報告する（テストを勝手に書き換えない）。

- [ ] **Step 5: コミット**

```bash
git add scripts/lib/forecast-engine.mjs tests/forecast-engine.test.mjs
git diff --cached --name-only
git commit -m "$(cat <<'EOF'
feat(forecast-engine): computeForecast にトラッカーアンカー経路を追加

trackTrend が有効なら予測レベルをトラッカー実測出庫レートにアンカーし、
便需要比で前向き変調、占有比で乗り場別按分する。満車で net-diff
baseline=0 でも非0予測が出る。trackTrend 無効時は従来の net-diff 経路。
trendWindow に levelSource を追加。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: computeEnsemble の希釈ガード

**Files:**
- Modify: `scripts/lib/ensemble-engine.mjs`（`computeEnsemble`）
- Test: `tests/ensemble-engine.test.mjs`（末尾に追加）

- [ ] **Step 1: 失敗するテストを書く**

`tests/ensemble-engine.test.mjs` 末尾に追加。`computeEnsemble` `makeForecast` `makePatternMatch` は既存。

```javascript

test('computeEnsemble: pattern-match slot が構造的0 → forecast 100% (希釈ガード)', () => {
  // forecast=4, pattern-match=0。希釈ガードが無ければ 4*0.5+0*0.5=2 だが、
  // pm 側 total=0 は「構造的に利用不可」とみなし forecast 100% → 4。
  const fc = makeForecast([[4, 0, 0, 0]]);
  const pm = makePatternMatch([[0, 0, 0, 0]]);
  const accuracy = {
    recent24h: {
      forecast:     { lead30: { mae_total: 1, n: 50 }, lead60: { mae_total: 1, n: 50 }, lead120: { mae_total: 1, n: 50 } },
      patternMatch: { lead30: { mae_total: 1, n: 50 }, lead60: { mae_total: 1, n: 50 }, lead120: { mae_total: 1, n: 50 } },
    },
  };
  const r = computeEnsemble(fc, pm, accuracy, new Date('2026-06-01T17:00:00+09:00'));
  assert.equal(r.slots[0].stall1, 4);
  assert.equal(r.slots[0].total, 4);
});

test('computeEnsemble: pattern-match slot が非0 → 従来どおり加重平均', () => {
  const fc = makeForecast([[4, 0, 0, 0]]);
  const pm = makePatternMatch([[2, 0, 0, 0]]); // total=2 で非0
  const accuracy = {
    recent24h: {
      forecast:     { lead30: { mae_total: 1, n: 50 }, lead60: { mae_total: 1, n: 50 }, lead120: { mae_total: 1, n: 50 } },
      patternMatch: { lead30: { mae_total: 1, n: 50 }, lead60: { mae_total: 1, n: 50 }, lead120: { mae_total: 1, n: 50 } },
    },
  };
  const r = computeEnsemble(fc, pm, accuracy, new Date('2026-06-01T17:00:00+09:00'));
  assert.equal(r.slots[0].stall1, 3); // 4*0.5 + 2*0.5
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `node --test tests/ensemble-engine.test.mjs`
Expected: FAIL — 1つ目のテストで `stall1` が `2`（加重平均）になり `4` と一致しない。

- [ ] **Step 3: 希釈ガードを実装**

`scripts/lib/ensemble-engine.mjs` の `computeEnsemble`、スロットの stall ループ（95-104 行付近）。

変更前:
```javascript
    const pm = pmBySlot.get(fc.slotStart) || null;
    const out = { slotStart: fc.slotStart, leadBucket: bucket };
    let total = 0;
    for (const name of ['stall1', 'stall2', 'stall3', 'stall4']) {
      let val;
      if (pm === null) {
        val = fc[name];
      } else {
        // 小数のまま保持する。整数化は書き出し時の applyThroughputScale (round(値×k)) で1回だけ行う。
        val = fc[name] * w_fc + pm[name] * w_pm;
      }
      out[name] = val;
      total += val;
    }
```

変更後:
```javascript
    const pmRaw = pmBySlot.get(fc.slotStart) || null;
    // pattern-match slot が構造的に0 (total=0) のときは「利用不可」とみなす。
    // net-diff 由来の historicalCurve は満車時0になり、トラッカーアンカー型の
    // forecast を希釈してしまうため、その slot は forecast 100% にする。
    const pm = (pmRaw !== null && (pmRaw.total || 0) > 0) ? pmRaw : null;
    const out = { slotStart: fc.slotStart, leadBucket: bucket };
    let total = 0;
    for (const name of ['stall1', 'stall2', 'stall3', 'stall4']) {
      let val;
      if (pm === null) {
        val = fc[name];
      } else {
        // 小数のまま保持する。整数化は書き出し時の applyThroughputScale (round(値×k)) で1回だけ行う。
        val = fc[name] * w_fc + pm[name] * w_pm;
      }
      out[name] = val;
      total += val;
    }
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `node --test tests/ensemble-engine.test.mjs`
Expected: PASS — 新規2件を含め全件パス。

- [ ] **Step 5: コミット**

```bash
git add scripts/lib/ensemble-engine.mjs tests/ensemble-engine.test.mjs
git diff --cached --name-only
git commit -m "$(cat <<'EOF'
feat(ensemble-engine): pattern-match 構造的0スロットの希釈ガード

net-diff 由来の historicalCurve は満車時に total=0 になる。これを
トラッカーアンカー型の forecast と加重平均すると予測が希釈されるため、
pm 側 slot total=0 のスロットは forecast 100% を採用する。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: observe-taxi-pool.mjs 配線・全回帰・実データ検証

**Files:**
- Modify: `scripts/observe-taxi-pool.mjs`（`computeForecast` 呼び出し）
- Create: `scripts/tmp-verify-tracker-forecast.mjs`（一時・コミットしない）

- [ ] **Step 1: observe-taxi-pool.mjs で latestOccupancy を渡す**

`scripts/observe-taxi-pool.mjs` の `computeForecast` 呼び出し（325 行付近）。

変更前:
```javascript
    forecastResult = computeForecast(baseline, recent, arrivalsJson, now, trackTrend);
```

変更後:
```javascript
    // 直近 tick の各乗り場占有を乗り場別按分に渡す（トラッカーアンカー経路用）。
    const lastRow = allHistory[allHistory.length - 1];
    const latestOccupancy = lastRow && lastRow.stalls ? {
      stall1: lastRow.stalls.stall1?.occupied_estimate,
      stall2: lastRow.stalls.stall2?.occupied_estimate,
      stall3: lastRow.stalls.stall3?.occupied_estimate,
      stall4: lastRow.stalls.stall4?.occupied_estimate,
    } : null;
    forecastResult = computeForecast(baseline, recent, arrivalsJson, now, trackTrend, latestOccupancy);
```

- [ ] **Step 2: 全回帰テスト**

Run: `cd 乗務地図関係 && npm test`
Expected: PASS — 全件パス。失敗が出たら停止してユーザーに報告（テストを勝手に書き換えない）。

Run: `cd 乗務地図関係 && .venv.nosync/bin/python3 -m unittest tests.test_detect_vehicles tests.test_track_vehicles`
Expected: PASS — detect 13 + track 29 = 42 件。`.venv.nosync` が無ければ `.venv` を試す。

- [ ] **Step 3: 配線をコミット**

```bash
git add scripts/observe-taxi-pool.mjs
git diff --cached --name-only
git commit -m "$(cat <<'EOF'
feat(observe): computeForecast に直近占有 latestOccupancy を渡す

トラッカーアンカー経路の乗り場別按分に使う。allHistory 末尾行の
各乗り場 occupied_estimate を渡す。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: 実データ検証スクリプトを作成**

`scripts/tmp-verify-tracker-forecast.mjs` を作成する。

```javascript
// 一時検証スクリプト: トラッカーアンカー型予測の実データ検証。実行後に削除する。
import { readFileSync } from 'node:fs';
import { computeBaseline, computeForecast } from './lib/forecast-engine.mjs';

function loadJsonl(path) {
  return readFileSync(path, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

const history = loadJsonl('data/taxi-pool-history.jsonl');
const baseline = computeBaseline(history);
const recent = history.slice(-12).map(r => {
  const st = r.stalls || {};
  let o = 0;
  for (const n of ['stall1', 'stall2', 'stall3', 'stall4']) {
    const d = st[n]?.diff_occupied_from_prev;
    if (typeof d === 'number' && d < 0) o += -d;
  }
  return { ts: r.ts, total_outflow: o };
});
const last = history[history.length - 1];
const occ = last && last.stalls ? {
  stall1: last.stalls.stall1?.occupied_estimate,
  stall2: last.stalls.stall2?.occupied_estimate,
  stall3: last.stalls.stall3?.occupied_estimate,
  stall4: last.stalls.stall4?.occupied_estimate,
} : null;

let arrivals = null;
try { arrivals = JSON.parse(readFileSync('data/arrivals.json', 'utf8')); } catch { /* optional */ }

// トラッカー実測を模した trackTrend（実値は throughput-calibration.json / observe ログ参照）。
const trackTrend = { k: 5, actual: 60 };
const r = computeForecast(baseline, recent, arrivals, new Date(), trackTrend, occ);
const nz = r.slots.filter(s => (s.total || 0) > 0).length;
console.log('levelSource:', r.trendWindow.levelSource);
console.log('占有(直近):', occ);
console.log('非0スロット:', nz, '/', r.slots.length);
console.log('slot0-2:', r.slots.slice(0, 3).map(s => s.total));
console.log(nz > 0 && r.trendWindow.levelSource === 'track-anchored'
  ? 'OK: 満車・net-diff=0 でもトラッカーアンカーで非0予測が出ている。'
  : 'NG: 予測が0のまま。実装を確認。');
```

- [ ] **Step 5: 実データ検証を実行**

Run: `cd 乗務地図関係 && node scripts/tmp-verify-tracker-forecast.mjs`
Expected: `levelSource: track-anchored`、非0スロットが 24/24 近く、`OK:` 行が表示される。`NG:` または levelSource が `netdiff-fallback` のときは停止してユーザーに報告。

- [ ] **Step 6: 検証スクリプトを削除して push**

```bash
cd 乗務地図関係
rm scripts/tmp-verify-tracker-forecast.mjs
git status --short   # tmp-verify-tracker-forecast.mjs が残っていないこと
git pull --rebase --autostash origin main
git push origin main
```

rebase で再生成系 JSON が衝突したら `git checkout --theirs <file>` → `git add` → `git rebase --continue`。`git reset --hard` は禁止。

---

## 完了条件

- Task 1〜4 のユニットテストがパス。
- `npm test` 全件 ＋ Python 42 件が回帰なしでパス。
- 実データ検証で満車・`diff=0` 条件でも `track-anchored` で非0予測が出る。
- 修正コミットが `origin/main` に反映される。

## Self-Review

- **Spec coverage:** 設計 §1（computeForecast レベル再設計）→ Task 1-3。§2（ensemble 希釈ガード）→ Task 4。§5（observe 配線）→ Task 5。テスト方針 → 各 Task の TDD ＋ Task 5 の全回帰。実データ検証 → Task 5。§3（pattern-match 自体は follow-up）→ 計画対象外で正しい。
- **Placeholder scan:** TBD/TODO なし。全ステップに実コード・実コマンド・期待出力。
- **Type consistency:** `flightDemand` は `{futureSums, recentSum}` を返し Task 3 で同名参照。`splitTotalToStalls(total, occupancy)` は `{stall1..4}` を返し Task 3 で `split[name]` 参照。`latestOccupancy` は Task 3 のシグネチャ追加と Task 5 の呼び出しで一致。`levelSource` は Task 3 で trendWindow に追加し実データ検証で参照。`computeForecast` の引数順 `(baseline, recentHistory, arrivalsJson, now, trackTrend, latestOccupancy)` は全テスト・observe 呼び出しで一致。
