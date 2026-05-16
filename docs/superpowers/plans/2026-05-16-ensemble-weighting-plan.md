# アンサンブル重み自動調整 実装プラン (Phase D-2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** forecast-accuracy.json の lead time 別 MAE から重みを自動計算し、forecast と pattern-match を重み付き平均した統合予測 stall-ensemble.json を生成、forecast.html 最上部に表示する。

**Architecture:** 純関数 `computeWeights` + `computeEnsemble` を `scripts/lib/ensemble-engine.mjs` に集約。observe-tick の D-1 (accuracy 評価) の後に呼び出し、forecastResult / patternMatchResult / accuracy を入力に stall-ensemble.json を出力。fail-safe で本観測 jsonl 追記は継続。

**Tech Stack:** ES Modules / `node:test` + `node:assert/strict` / Vanilla JS / GitHub Actions (Pages) / 既存 launchd ジョブ

**設計ドキュメント:** `docs/superpowers/specs/2026-05-16-ensemble-weighting-design.md`

---

## File Structure

| ファイル | 種別 | 役割 |
|---|---|---|
| `scripts/lib/ensemble-engine.mjs` | Create | 純関数 `computeWeights(accuracy)`, `computeEnsemble(forecast, patternMatch, accuracy, now)`, `leadBucketOf(leadMinutes)` |
| `tests/ensemble-engine.test.mjs` | Create | 単体テスト 8 件 |
| `data/stall-ensemble.json` | Create (生成物) | 統合予測。git 管理 |
| `scripts/observe-taxi-pool.mjs` | Modify | D-1 ブロックの後で computeEnsemble 呼び出し |
| `scripts/observe-tick-local.sh` | Modify | git add / checkout 対象に stall-ensemble.json 追加 |
| `forecast.html` | Modify | 最上部に「統合予測」セクション |
| `js/forecast-render.js` | Modify | `renderEnsemble` 追加 |
| `js/forecast-app.js` | Modify | `stall-ensemble.json` も fetch、最初に描画 |

実装順序: **ensemble-engine (TDD) → observe-tick 統合 → observe-tick-local.sh 配線 → フロント → 最終 push**。

---

## Task 1: `ensemble-engine.mjs` の `leadBucketOf` + `computeWeights` (TDD)

**Files:**
- Create: `scripts/lib/ensemble-engine.mjs`
- Create: `tests/ensemble-engine.test.mjs`

- [ ] **Step 1.1: 失敗テスト 5 件を追加**

`tests/ensemble-engine.test.mjs` の内容:

```javascript
import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import { leadBucketOf, computeWeights } from '../scripts/lib/ensemble-engine.mjs';

test('leadBucketOf: 45 分以下 → lead30、46-105 → lead60、106 以上 → lead120', () => {
  assert.equal(leadBucketOf(5), 'lead30');
  assert.equal(leadBucketOf(45), 'lead30');
  assert.equal(leadBucketOf(46), 'lead60');
  assert.equal(leadBucketOf(105), 'lead60');
  assert.equal(leadBucketOf(106), 'lead120');
  assert.equal(leadBucketOf(120), 'lead120');
});

test('computeWeights: accuracy=null → 全 lead 50:50 fallback', () => {
  const w = computeWeights(null);
  for (const k of ['lead30', 'lead60', 'lead120']) {
    assert.equal(w[k].w_fc, 0.5);
    assert.equal(w[k].w_pm, 0.5);
    assert.equal(w[k].source, 'fallback');
  }
});

test('computeWeights: mae が片方 null → そのバケット fallback', () => {
  const accuracy = {
    recent24h: {
      forecast: { lead30: { mae_total: null, n: 50 }, lead60: { mae_total: 2, n: 50 }, lead120: { mae_total: 3, n: 50 } },
      patternMatch: { lead30: { mae_total: 2, n: 50 }, lead60: { mae_total: 2, n: 50 }, lead120: { mae_total: 3, n: 50 } },
    },
  };
  const w = computeWeights(accuracy);
  assert.equal(w.lead30.source, 'fallback');
  assert.equal(w.lead60.source, 'mae');
});

test('computeWeights: n < MIN_SAMPLE (20) → fallback', () => {
  const accuracy = {
    recent24h: {
      forecast: { lead30: { mae_total: 1, n: 10 }, lead60: { mae_total: 2, n: 50 }, lead120: { mae_total: 3, n: 50 } },
      patternMatch: { lead30: { mae_total: 2, n: 50 }, lead60: { mae_total: 2, n: 50 }, lead120: { mae_total: 3, n: 50 } },
    },
  };
  const w = computeWeights(accuracy);
  assert.equal(w.lead30.source, 'fallback'); // n_fc=10 < 20
});

test('computeWeights: 正常な MAE → 逆数加重 (MAE 小さい方の重みが大)', () => {
  const accuracy = {
    recent24h: {
      forecast:     { lead30: { mae_total: 1, n: 50 }, lead60: { mae_total: 2, n: 50 }, lead120: { mae_total: 3, n: 50 } },
      patternMatch: { lead30: { mae_total: 3, n: 50 }, lead60: { mae_total: 2, n: 50 }, lead120: { mae_total: 1, n: 50 } },
    },
  };
  const w = computeWeights(accuracy);
  // lead30: forecast MAE 小 → w_fc > w_pm
  assert.ok(w.lead30.w_fc > w.lead30.w_pm);
  // lead120: patternMatch MAE 小 → w_pm > w_fc
  assert.ok(w.lead120.w_pm > w.lead120.w_fc);
  // w_fc + w_pm = 1
  assert.ok(Math.abs(w.lead30.w_fc + w.lead30.w_pm - 1) < 1e-9);
  assert.equal(w.lead30.source, 'mae');
});
```

- [ ] **Step 1.2: テスト実行 → 失敗確認**

```bash
cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係"
node --test tests/ensemble-engine.test.mjs 2>&1 | tail -6
```

期待: `leadBucketOf is not defined` で失敗。

- [ ] **Step 1.3: `ensemble-engine.mjs` の基礎部分を実装**

`scripts/lib/ensemble-engine.mjs` の内容:

```javascript
/**
 * アンサンブル重み自動調整 (Phase D-2)。
 *
 * 設計: docs/superpowers/specs/2026-05-16-ensemble-weighting-design.md
 *
 * forecast-accuracy.json の lead time 別 MAE から重みを計算し、
 * forecast と pattern-match を重み付き平均した統合予測を作る純関数群。
 */

export const ENSEMBLE_SCHEMA_VERSION = 1;
export const MIN_SAMPLE = 20;     // lead バケットの n がこれ未満ならフォールバック
export const LAPLACE = 0.5;       // MAE 逆数のゼロ除算回避用平滑化
export const LEAD_KEYS = ['lead30', 'lead60', 'lead120'];

/**
 * lead time (分) → バケットキー。境界は中心 30/60/120 の中点。
 */
export function leadBucketOf(leadMinutes) {
  if (leadMinutes <= 45) return 'lead30';
  if (leadMinutes <= 105) return 'lead60';
  return 'lead120';
}

function fallbackWeight() {
  return { w_fc: 0.5, w_pm: 0.5, source: 'fallback' };
}

/**
 * forecast-accuracy.json の recent24h から lead time 別の重みを計算する。
 *
 * @param {Object|null} accuracy forecast-accuracy.json の中身
 * @returns {{lead30, lead60, lead120}} 各 {w_fc, w_pm, source}
 */
export function computeWeights(accuracy) {
  const out = {};
  const r24 = accuracy && accuracy.recent24h;
  for (const key of LEAD_KEYS) {
    if (!r24 || !r24.forecast || !r24.patternMatch) {
      out[key] = fallbackWeight();
      continue;
    }
    const fc = r24.forecast[key];
    const pm = r24.patternMatch[key];
    if (!fc || !pm || typeof fc.mae_total !== 'number' || typeof pm.mae_total !== 'number') {
      out[key] = fallbackWeight();
      continue;
    }
    const nFc = typeof fc.n === 'number' ? fc.n : 0;
    const nPm = typeof pm.n === 'number' ? pm.n : 0;
    if (Math.min(nFc, nPm) < MIN_SAMPLE) {
      out[key] = fallbackWeight();
      continue;
    }
    const invFc = 1 / (fc.mae_total + LAPLACE);
    const invPm = 1 / (pm.mae_total + LAPLACE);
    const sum = invFc + invPm;
    out[key] = {
      w_fc: Number((invFc / sum).toFixed(4)),
      w_pm: Number((invPm / sum).toFixed(4)),
      source: 'mae',
    };
  }
  return out;
}
```

- [ ] **Step 1.4: テスト再実行 → パス**

```bash
node --test tests/ensemble-engine.test.mjs 2>&1 | tail -6
```

期待: 5 件パス。

- [ ] **Step 1.5: commit**

```bash
git add scripts/lib/ensemble-engine.mjs tests/ensemble-engine.test.mjs
git commit -m "feat(ensemble): add leadBucketOf + computeWeights"
```

---

## Task 2: `computeEnsemble` の実装 (TDD)

**Files:**
- Modify: `scripts/lib/ensemble-engine.mjs`
- Modify: `tests/ensemble-engine.test.mjs`

- [ ] **Step 2.1: 失敗テスト 3 件を追加**

`tests/ensemble-engine.test.mjs` の末尾に追加:

```javascript
import { computeEnsemble, ENSEMBLE_SCHEMA_VERSION } from '../scripts/lib/ensemble-engine.mjs';

// forecast の slots を作る (現在 +5min 起点で 24 slot を想定、ここでは数 slot)
function makeForecast(slotStalls) {
  // slotStalls: [[s1,s2,s3,s4], ...]
  return {
    slots: slotStalls.map((v, i) => ({
      slotStart: `${String(17 + Math.floor((i + 1) / 12)).padStart(2, '0')}:${String(((i + 1) % 12) * 5).padStart(2, '0')}`,
      stall1: v[0], stall2: v[1], stall3: v[2], stall4: v[3],
      total: v[0] + v[1] + v[2] + v[3],
    })),
  };
}
function makePatternMatch(slotStalls) {
  return {
    historicalCurve: slotStalls.map((v, i) => ({
      slotStart: `${String(17 + Math.floor((i + 1) / 12)).padStart(2, '0')}:${String(((i + 1) % 12) * 5).padStart(2, '0')}`,
      stall1: v[0], stall2: v[1], stall3: v[2], stall4: v[3],
      total: v[0] + v[1] + v[2] + v[3],
    })),
  };
}

test('computeEnsemble: forecast 空 → slots 空配列', () => {
  const r = computeEnsemble({ slots: [] }, { historicalCurve: [] }, null, new Date('2026-06-01T17:00:00+09:00'));
  assert.equal(r.schemaVersion, ENSEMBLE_SCHEMA_VERSION);
  assert.deepEqual(r.slots, []);
});

test('computeEnsemble: pattern-match 空 → 各 slot forecast 100%', () => {
  const fc = makeForecast([[2, 0, 4, 1]]);
  const r = computeEnsemble(fc, { historicalCurve: [] }, null, new Date('2026-06-01T17:00:00+09:00'));
  assert.equal(r.slots[0].stall1, 2);
  assert.equal(r.slots[0].stall3, 4);
  assert.equal(r.slots[0].total, 7);
});

test('computeEnsemble: 正常入力 → 重み付き平均 + leadBucket 付与', () => {
  // forecast slot0 = +5min (lead30 バケット)
  const fc = makeForecast([[4, 0, 0, 0]]);
  const pm = makePatternMatch([[0, 0, 0, 0]]);
  // accuracy: lead30 で forecast MAE 1, pattern MAE 1 → 50:50
  const accuracy = {
    recent24h: {
      forecast:     { lead30: { mae_total: 1, n: 50 }, lead60: { mae_total: 1, n: 50 }, lead120: { mae_total: 1, n: 50 } },
      patternMatch: { lead30: { mae_total: 1, n: 50 }, lead60: { mae_total: 1, n: 50 }, lead120: { mae_total: 1, n: 50 } },
    },
  };
  const r = computeEnsemble(fc, pm, accuracy, new Date('2026-06-01T17:00:00+09:00'));
  // 50:50 → round(4*0.5 + 0*0.5) = 2
  assert.equal(r.slots[0].stall1, 2);
  assert.equal(r.slots[0].leadBucket, 'lead30');
  assert.equal(r.weights.lead30.source, 'mae');
});
```

- [ ] **Step 2.2: テスト実行 → 失敗確認**

```bash
node --test tests/ensemble-engine.test.mjs 2>&1 | tail -6
```

期待: `computeEnsemble is not defined` で失敗。

- [ ] **Step 2.3: `computeEnsemble` を実装**

`scripts/lib/ensemble-engine.mjs` の末尾に追加:

```javascript
function jstNowIsoString(now) {
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  return jst.toISOString().replace('Z', '+09:00').replace(/\.\d+/, '');
}

/**
 * forecast と pattern-match を重み付き平均した統合予測を作る。
 *
 * @param {{slots: Array}|null} forecast        stall-forecast.json 相当
 * @param {{historicalCurve: Array}|null} patternMatch  stall-pattern-match.json 相当
 * @param {Object|null} accuracy                forecast-accuracy.json 相当
 * @param {Date} now
 * @returns 統合予測オブジェクト
 */
export function computeEnsemble(forecast, patternMatch, accuracy, now) {
  const weights = computeWeights(accuracy);
  const fcSlots = (forecast && Array.isArray(forecast.slots)) ? forecast.slots : [];
  const pmSlots = (patternMatch && Array.isArray(patternMatch.historicalCurve))
    ? patternMatch.historicalCurve : [];
  // pattern-match を slotStart で引けるよう Map 化
  const pmBySlot = new Map();
  for (const s of pmSlots) pmBySlot.set(s.slotStart, s);

  const slots = fcSlots.map((fc, i) => {
    const leadMinutes = (i + 1) * 5;
    const bucket = leadBucketOf(leadMinutes);
    const { w_fc, w_pm } = weights[bucket];
    const pm = pmBySlot.get(fc.slotStart) || null;
    const out = { slotStart: fc.slotStart, leadBucket: bucket };
    let total = 0;
    for (const name of ['stall1', 'stall2', 'stall3', 'stall4']) {
      let val;
      if (pm === null) {
        val = fc[name];
      } else {
        val = Math.round(fc[name] * w_fc + pm[name] * w_pm);
      }
      out[name] = val;
      total += val;
    }
    out.total = total;
    return out;
  });

  return {
    schemaVersion: ENSEMBLE_SCHEMA_VERSION,
    generatedAt: jstNowIsoString(now),
    weights,
    slots,
  };
}
```

- [ ] **Step 2.4: テスト再実行 → 全件パス**

```bash
node --test tests/ensemble-engine.test.mjs 2>&1 | tail -6
```

期待: 8 件パス (Task 1 の 5 件 + Task 2 の 3 件)。

- [ ] **Step 2.5: 全テストスイート**

```bash
npm test 2>&1 | tail -6
```

期待: 363 + 8 = 371 件パス。

- [ ] **Step 2.6: commit**

```bash
git add scripts/lib/ensemble-engine.mjs tests/ensemble-engine.test.mjs
git commit -m "feat(ensemble): implement computeEnsemble (weighted average)"
```

---

## Task 3: `observe-taxi-pool.mjs` に computeEnsemble を組み込み

**Files:**
- Modify: `scripts/observe-taxi-pool.mjs`

- [ ] **Step 3.1: import 追加**

`scripts/observe-taxi-pool.mjs` の既存 import 群の最後 (`import { buildActualMap, evaluateAccuracy } from './lib/accuracy-evaluator.mjs';` の直後) に追加:

```javascript
import { computeEnsemble } from './lib/ensemble-engine.mjs';
```

- [ ] **Step 3.2: 定数追加**

既存の `const FORECAST_ACCURACY_PATH = './data/forecast-accuracy.json';` の直後に追加:

```javascript
const ENSEMBLE_OUTPUT_PATH = './data/stall-ensemble.json';
```

- [ ] **Step 3.3: Phase D-1 ブロックを accuracy 変数を保持する形に変更**

現在の Phase D-1 ブロック内で `const accuracy = evaluateAccuracy(...)` となっている。
これを外側スコープの変数にして D-2 で参照する。Phase D-1 ブロック全体を以下に置き換え:

```javascript
  // Phase D-1: 予測ログ記録 + 精度評価
  let accuracyResult = null;
  try {
    const logEntry = buildLogEntry(
      forecastResult,
      patternMatchResult ? { historicalCurve: patternMatchResult.historicalCurve } : null,
      tickSeq,
      ts
    );
    if (logEntry) {
      appendFileSync(FORECAST_LOG_PATH, JSON.stringify(logEntry) + '\n', 'utf8');
    }
    let logEntries = [];
    if (existsSync(FORECAST_LOG_PATH)) {
      const logLines = readFileSync(FORECAST_LOG_PATH, 'utf8').trim().split('\n');
      for (const line of logLines) {
        if (!line.trim()) continue;
        try { logEntries.push(JSON.parse(line)); } catch { /* skip bad line */ }
      }
    }
    const accHistoryLines = readFileSync(HISTORY_PATH, 'utf8').trim().split('\n');
    const accHistory = [];
    for (const line of accHistoryLines) {
      if (!line.trim()) continue;
      try { accHistory.push(JSON.parse(line)); } catch { /* skip bad line */ }
    }
    const actualMap = buildActualMap(accHistory);
    accuracyResult = evaluateAccuracy(logEntries, actualMap, new Date());
    writeFileSync(FORECAST_ACCURACY_PATH, JSON.stringify(accuracyResult, null, 2) + '\n', 'utf8');
    console.log(`[observe] accuracy ok: logEntries=${accuracyResult.logEntryCount} recent24h winner lead30=${accuracyResult.recent24h.winner.lead30}`);
  } catch (e) {
    console.error(`[observe] accuracy evaluation failed: ${e.message}`);
  }

  // Phase D-2: アンサンブル統合予測
  try {
    const ensemble = computeEnsemble(
      forecastResult,
      patternMatchResult ? { historicalCurve: patternMatchResult.historicalCurve } : null,
      accuracyResult,
      new Date()
    );
    writeFileSync(ENSEMBLE_OUTPUT_PATH, JSON.stringify(ensemble, null, 2) + '\n', 'utf8');
    console.log(`[observe] ensemble ok: slots=${ensemble.slots.length} lead30 weight fc=${ensemble.weights.lead30.w_fc}`);
  } catch (e) {
    console.error(`[observe] ensemble generation failed: ${e.message}`);
  }
```

- [ ] **Step 3.4: 構文チェック + 単発実行**

```bash
node --check scripts/observe-taxi-pool.mjs
node scripts/observe-taxi-pool.mjs 2>&1 | grep -E "forecast ok|pattern-match ok|accuracy ok|ensemble ok|failed"
```

期待: `[observe] ensemble ok: slots=24 lead30 weight fc=...` が出る。初期は accuracy が n 不足のため fc=0.5。

- [ ] **Step 3.5: 生成された JSON を確認**

```bash
python3 -c "
import json
d = json.load(open('data/stall-ensemble.json'))
print(f'schemaVersion: {d[\"schemaVersion\"]}')
print(f'weights: {d[\"weights\"]}')
print(f'slots: {len(d[\"slots\"])}')
print(f'first slot: {d[\"slots\"][0]}')
"
```

期待:
- `schemaVersion: 1`
- `weights` に lead30/60/120 (初期は全て source=fallback)
- `slots` 24 要素、各 slot に slotStart/stall1-4/total/leadBucket

- [ ] **Step 3.6: 全テスト (回帰確認)**

```bash
npm test 2>&1 | tail -6
```

期待: 371 件パス。

- [ ] **Step 3.7: commit**

```bash
git add scripts/observe-taxi-pool.mjs data/stall-ensemble.json
git commit -m "feat(observe): generate stall-ensemble.json each tick"
```

---

## Task 4: `observe-tick-local.sh` の配線

**Files:**
- Modify: `scripts/observe-tick-local.sh`

- [ ] **Step 4.1: pull 前の checkout 対象に stall-ensemble.json を追加**

`scripts/observe-tick-local.sh` の 2 箇所の以下の行:

```bash
git checkout HEAD -- data/stall-forecast.json data/stall-pattern-match.json data/forecast-accuracy.json 2>/dev/null || true
```

を、両方とも以下に変更:

```bash
git checkout HEAD -- data/stall-forecast.json data/stall-pattern-match.json data/forecast-accuracy.json data/stall-ensemble.json 2>/dev/null || true
```

- [ ] **Step 4.2: git add 対象に stall-ensemble.json を追加**

`scripts/observe-tick-local.sh` の以下の行:

```bash
git add data/taxi-pool-history.jsonl data/stall-forecast.json data/stall-pattern-match.json data/forecast-accuracy.json 2>/dev/null || true
```

を以下に変更:

```bash
git add data/taxi-pool-history.jsonl data/stall-forecast.json data/stall-pattern-match.json data/forecast-accuracy.json data/stall-ensemble.json 2>/dev/null || true
```

- [ ] **Step 4.3: 構文チェック**

```bash
bash -n scripts/observe-tick-local.sh
```

期待: 何も出力されない。

- [ ] **Step 4.4: commit**

```bash
git add scripts/observe-tick-local.sh
git commit -m "chore(observe): wire stall-ensemble.json into observe-tick git flow"
```

---

## Task 5: `forecast.html` に統合予測セクション追加

**Files:**
- Modify: `forecast.html`
- Modify: `js/forecast-render.js`
- Modify: `js/forecast-app.js`

- [ ] **Step 5.1: `forecast.html` にスタイル + セクション追加**

`<style>` 末尾 (既存 `.winner-pm` の後) に追加:

```css
.ensemble-section { margin-bottom: 24px; }
.ensemble-section h2 { font-size: 17px; margin: 0 0 8px 0; color: var(--accent); }
.ensemble-meta { color: var(--sub); font-size: 12px; margin-bottom: 12px; line-height: 1.5; }
.ensemble-table { border-collapse: collapse; width: 100%; }
.ensemble-table th, .ensemble-table td { padding: 6px 8px; border-bottom: 1px solid #222; text-align: right; font-variant-numeric: tabular-nums; }
.ensemble-table th { background: #16161c; color: var(--sub); font-weight: 500; font-size: 12px; }
.ensemble-table td.time { text-align: left; font-weight: 600; }
.ensemble-table tr.tier-high td { background: rgba(255, 184, 77, 0.10); }
.ensemble-table tr.tier-very-high td { background: rgba(255, 82, 82, 0.14); }
```

`<main>` の開きタグ直後 (既存の `<div id="forecast-meta">` の前) に追加:

```html
    <section class="ensemble-section" id="ensemble-section">
      <h2>統合予測 (今後 2 時間)</h2>
      <div id="ensemble-meta" class="ensemble-meta">読み込み中...</div>
      <div id="ensemble-table-wrap"></div>
    </section>
```

- [ ] **Step 5.2: `js/forecast-render.js` に `renderEnsemble` を追加**

ファイル末尾に追加:

```javascript
// --- Phase D-2: 統合予測描画 ---

const ENSEMBLE_TIER_HIGH = 8;
const ENSEMBLE_TIER_VERY_HIGH = 12;

export function renderEnsemble(metaEl, tableEl, ensemble) {
  if (!metaEl || !tableEl || !ensemble) return;
  const w = ensemble.weights || {};
  const wText = ['lead30', 'lead60', 'lead120'].map(k => {
    const e = w[k];
    if (!e) return '';
    const label = { lead30: '30分先', lead60: '60分先', lead120: '120分先' }[k];
    const pct = `fc${Math.round(e.w_fc * 100)}%/pm${Math.round(e.w_pm * 100)}%`;
    const note = e.source === 'fallback' ? ' (様子見)' : '';
    return `${label} ${pct}${note}`;
  }).filter(Boolean).join(' / ');
  const ts = (ensemble.generatedAt || '').slice(0, 16).replace('T', ' ');
  metaEl.innerHTML = `予測時刻 <strong>${ts} JST</strong><br>重み: ${wText}`;

  const slots = ensemble.slots || [];
  if (slots.length === 0) {
    tableEl.innerHTML = '<p class="ensemble-meta">統合予測なし</p>';
    return;
  }
  const rows = slots.map(s => {
    let tierClass = '';
    let mark = '';
    if (s.total >= ENSEMBLE_TIER_VERY_HIGH) { tierClass = 'tier-very-high'; mark = ' <span class="star">★★</span>'; }
    else if (s.total >= ENSEMBLE_TIER_HIGH) { tierClass = 'tier-high'; mark = ' <span class="star">★</span>'; }
    return `<tr class="${tierClass}">
      <td class="time">${s.slotStart}</td>
      <td>${s.stall1}</td>
      <td>${s.stall2}</td>
      <td>${s.stall3}</td>
      <td>${s.stall4}</td>
      <td class="total-cell">${s.total}${mark}</td>
    </tr>`;
  }).join('');
  tableEl.innerHTML = `<table class="ensemble-table">
    <thead><tr>
      <th>時刻</th><th>stall1</th><th>stall2</th><th>stall3</th><th>stall4</th><th>合計</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}
```

- [ ] **Step 5.3: `js/forecast-app.js` に ensemble fetch + render を追加**

`js/forecast-app.js` 全体を以下に置き換え:

```javascript
import {
  renderForecastMeta, renderForecastTable,
  renderPatternMeta, renderSimilarDays, renderHistoricalCurve,
  renderAccuracy, renderEnsemble,
} from './forecast-render.js';

async function main() {
  const ensembleMetaEl = document.getElementById('ensemble-meta');
  const ensembleTableEl = document.getElementById('ensemble-table-wrap');
  const metaEl = document.getElementById('forecast-meta');
  const tableEl = document.getElementById('forecast-table-wrap');
  const patternMetaEl = document.getElementById('pattern-meta');
  const similarDaysEl = document.getElementById('similar-days');
  const curveEl = document.getElementById('historical-curve-wrap');
  const accuracyMetaEl = document.getElementById('accuracy-meta');
  const accuracyTableEl = document.getElementById('accuracy-table-wrap');

  // 統合予測 (Phase D-2) — メイン予測、最初に描画
  try {
    const res = await fetch('data/stall-ensemble.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ensemble = await res.json();
    renderEnsemble(ensembleMetaEl, ensembleTableEl, ensemble);
  } catch (e) {
    ensembleMetaEl.textContent = `統合予測データの読み込みに失敗: ${e.message}`;
    ensembleTableEl.innerHTML = '';
  }

  // 短期予測 (Phase C-1)
  try {
    const res = await fetch('data/stall-forecast.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const forecast = await res.json();
    renderForecastMeta(metaEl, forecast);
    renderForecastTable(tableEl, forecast);
  } catch (e) {
    metaEl.textContent = `予測データの読み込みに失敗: ${e.message}`;
    tableEl.innerHTML = '';
  }

  // パターンマッチング (Phase C-2)
  try {
    const res = await fetch('data/stall-pattern-match.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const patternMatch = await res.json();
    renderPatternMeta(patternMetaEl, patternMatch);
    renderSimilarDays(similarDaysEl, patternMatch);
    renderHistoricalCurve(curveEl, patternMatch);
  } catch (e) {
    patternMetaEl.textContent = `パターンマッチングデータの読み込みに失敗: ${e.message}`;
    similarDaysEl.innerHTML = '';
    curveEl.innerHTML = '';
  }

  // 予測精度 (Phase D-1)
  try {
    const res = await fetch('data/forecast-accuracy.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const accuracy = await res.json();
    renderAccuracy(accuracyMetaEl, accuracyTableEl, accuracy);
  } catch (e) {
    accuracyMetaEl.textContent = `精度データの読み込みに失敗: ${e.message}`;
    accuracyTableEl.innerHTML = '';
  }
}

main();
```

- [ ] **Step 5.4: 既存セクションの見出しを「内訳」と分かる文言に調整**

`forecast.html` の既存 forecast セクションの見出しを更新する。
`<div id="forecast-meta" class="forecast-meta">読み込み中...</div>` の直前に小見出しを追加:

```html
    <h2 style="font-size:15px;margin:24px 0 8px;color:var(--sub);">内訳: 短期予測 (ルールベース)</h2>
```

- [ ] **Step 5.5: 構文チェック**

```bash
node --check js/forecast-render.js
node --check js/forecast-app.js
```

期待: 両方とも何も出力されない。

- [ ] **Step 5.6: 全テスト (回帰なし確認)**

```bash
npm test 2>&1 | tail -6
```

期待: 371 件パス。

- [ ] **Step 5.7: commit**

```bash
git add forecast.html js/forecast-render.js js/forecast-app.js
git commit -m "feat(ensemble): add 統合予測 section to forecast.html"
```

---

## Task 6: 最終整合 + push

- [ ] **Step 6.1: scope check (触ったファイル一覧)**

```bash
cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係"
git log origin/main..HEAD --name-only --pretty=format:'%h %s'
```

期待: 触ったのは以下のみ:
- `scripts/lib/ensemble-engine.mjs`
- `tests/ensemble-engine.test.mjs`
- `scripts/observe-taxi-pool.mjs`
- `scripts/observe-tick-local.sh`
- `data/stall-ensemble.json`
- `forecast.html`
- `js/forecast-render.js`
- `js/forecast-app.js`

`forecast-engine.mjs` / `pattern-matcher.mjs` / `accuracy-evaluator.mjs` / `transit-share.json` は含まれないこと。

- [ ] **Step 6.2: 全テスト最終パス**

```bash
npm test 2>&1 | tail -6
```

期待: 371 件パス。

- [ ] **Step 6.3: git pull --rebase --autostash で観測 push との衝突回避**

```bash
git pull --rebase --autostash origin main 2>&1 | tail -5
```

- [ ] **Step 6.4: push (3 回までリトライ)**

```bash
for i in 1 2 3; do
  if git push origin main; then
    echo "[push ok attempt $i]"
    break
  fi
  echo "[retry $i]"
  git pull --rebase --autostash origin main
  sleep 2
done
```

- [ ] **Step 6.5: autostash 残骸の掃除**

```bash
git reset --hard HEAD 2>&1 | tail -1
git stash list | head -1
# autostash が残っていれば drop (forecast/accuracy/ensemble は observe-tick が再生成するため捨ててよい)
if git stash list | head -1 | grep -q autostash; then
  git stash drop stash@{0} 2>&1 | head -1
fi
```

- [ ] **Step 6.6: 本番反映確認 (GitHub Pages 自動デプロイ後 80-90 秒)**

```bash
sleep 90
echo "=== stall-ensemble.json ==="
curl -sf https://hidenaka.github.io/taxi-ic-helper/data/stall-ensemble.json | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
print(f'schemaVersion: {d[\"schemaVersion\"]}')
print(f'weights: {d[\"weights\"]}')
print(f'slots: {len(d[\"slots\"])}')
"
echo "=== forecast.html ==="
curl -sf https://hidenaka.github.io/taxi-ic-helper/forecast.html | grep -E "ensemble-section|統合予測" | head -3
```

期待: stall-ensemble.json が取得でき、forecast.html に「統合予測」「ensemble-section」がある。

- [ ] **Step 6.7: 完了報告**

最終状態を要約。Mac mini 側は次 tick で git pull → 新ロジック取り込み。

---

## 検証コマンド一覧 (チートシート)

```bash
# 個別テスト
node --test tests/ensemble-engine.test.mjs

# 全テスト
npm test

# observe-tick 単発実行 (forecast + pattern-match + accuracy + ensemble 生成)
node scripts/observe-taxi-pool.mjs

# 生成 JSON
python3 -c "import json; print(json.dumps(json.load(open('data/stall-ensemble.json')), indent=2, ensure_ascii=False)[:1200])"

# 本番
open https://hidenaka.github.io/taxi-ic-helper/forecast.html
```

---

## 完了条件 (再掲)

- [ ] `npm test` 全件パス (363 → 371 件)
- [ ] `scripts/lib/ensemble-engine.mjs` 純関数として実装
- [ ] observe-tick で `data/stall-ensemble.json` が 5 分毎に更新される
- [ ] `forecast.html` 最上部に「統合予測」セクションが表示される
- [ ] `observe-tick-local.sh` の git add / checkout 対象に stall-ensemble.json 追加
- [ ] スコープ外ファイル (forecast-engine.mjs / pattern-matcher.mjs / accuracy-evaluator.mjs / transit-share.json) は触っていない
- [ ] 観測 jsonl 追記との衝突なし
