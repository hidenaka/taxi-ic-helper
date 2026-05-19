# 乗り場 先頭スロット占有方式 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 乗り場別の出庫計測を、各乗り場の先頭領域のスロット占有を画像解析で数え、その時系列の減少を出庫として積算する方式に置き換える。

**Architecture:** 60秒間隔の Node スクリプトが各スロット領域を Jimp で画像解析（エッジ密度）し在/不在を判定、乗り場別の在台数を `slot-occupancy-history.jsonl` に記録。在台数の減少を出庫として集計し、既存の到着便ページ「実績/予測」が読む形へ流す。YOLOトラッカーは退役。

**Tech Stack:** Node.js ESM（`node:test`、Jimp）。校正は OpenCV(Python) の描画のみ。

設計書: `docs/superpowers/specs/2026-05-20-front-slot-occupancy-design.md`

---

## 前提知識

- リポジトリ: taxi-ic-helper。実装は worktree `乗務地図関係-wt-perspective`（branch `feat/front-slot-occupancy`）。最終Taskでコード＋校正データを揃えて `origin/main` に push。
- commit メッセージ末尾に `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`。commit 前に `git diff --cached --name-only` で観測データ・stray `* 2.*` 混入なし確認。
- テスト: `node --test`（`.mjs`、`tests/` 配下）。
- `scripts/lib/image-pool-analyzer.mjs`: 内部関数 `analyzeROI(jimpImage, roi)` が `roi`(ピクセル `{x,y,width,height}`)の領域から `{edge_density, roi_black_ratio, luminance_mean, luminance_std}` を返す（現状 export されていない）。`export` 済み関数は `analyzePoolImage`・`analyzeStalls`。
- `observe-taxi-pool.mjs`: `import { Jimp } from 'jimp'`、`fetchImage(url)` で画像 buffer 取得、`Jimp.read(buf)` で Jimp 画像化。`computeTrackActuals(trackHistory, now, windowMinutes)` は `[{slotStart,slotEnd,stall1..4,total}]` を返し observe が出庫実績/予測に使う。
- launchd: `scripts/install-track-launchd.sh` が 60秒間隔で `track_vehicles.py`（YOLO）を起動。本計画でスロット方式スクリプトへ差し替える。
- カメラ画像: `https://ttc.taxi-inf.jp/<Name>.jpg`（`Real01_line` 等）。800×600。

## ファイル構成

| ファイル | 変更 |
|---|---|
| `scripts/lib/slot-occupancy.mjs` | 新規。純関数（在/不在判定・在台数・出庫差分・中央値平滑） |
| `tests/slot-occupancy.test.mjs` | 新規 |
| `scripts/lib/image-pool-analyzer.mjs` | `analyzeROI` を export |
| `scripts/slot-occupancy-tick.mjs` | 新規。60秒tick（スロット画像解析→占有履歴） |
| `scripts/lib/slot-actuals.mjs` | 新規。占有履歴→乗り場別出庫（実績形）の純関数 |
| `tests/slot-actuals.test.mjs` | 新規 |
| `scripts/observe-taxi-pool.mjs` | 出庫実績の供給元を track→slot に切替 |
| `scripts/calibrate-slots.mjs` | 新規。スロット校正支援 |
| `scripts/lib/stall-slots.json` | 新規。スロット定義（Task 5 校正で確定） |
| `scripts/install-track-launchd.sh` | スロットtickを起動するよう差し替え（Task 5） |

---

## Task 1: slot-occupancy.mjs — 在/不在・在台数・出庫差分の純関数

**作業ディレクトリ:** taxi-ic-helper worktree

**Files:**
- Create: `scripts/lib/slot-occupancy.mjs`
- Test: `tests/slot-occupancy.test.mjs`

- [ ] **Step 1: 失敗するテストを書く**

`tests/slot-occupancy.test.mjs` を新規作成:
```javascript
import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import {
  slotOccupied, slotsForStall, countStallOccupancy, departuresBetween, medianOf3,
} from '../scripts/lib/slot-occupancy.mjs';

test('slotOccupied: エッジ密度がしきい値以上なら在', () => {
  assert.equal(slotOccupied({ edge_density: 0.20 }, 0.08), true);
  assert.equal(slotOccupied({ edge_density: 0.03 }, 0.08), false);
});

test('slotOccupied: edge_density 欠落・null は不在', () => {
  assert.equal(slotOccupied({}, 0.08), false);
  assert.equal(slotOccupied(null, 0.08), false);
});

test('slotsForStall: 指定乗り場の slots を返す', () => {
  const cfg = { stalls: { stall1: { slots: [{ id: '1-1' }, { id: '1-2' }] } } };
  assert.equal(slotsForStall(cfg, 'stall1').length, 2);
  assert.deepEqual(slotsForStall(cfg, 'stall9'), []);
});

test('countStallOccupancy: 占有スロット数を数える', () => {
  const slots = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(countStallOccupancy({ a: true, b: false, c: true }, slots), 2);
  assert.equal(countStallOccupancy({}, slots), 0);
});

test('departuresBetween: 在台数が減った分が出庫、増加は0', () => {
  assert.equal(departuresBetween(8, 6), 2);   // 2台出庫
  assert.equal(departuresBetween(3, 8), 0);   // 列移動の補充 → 0
  assert.equal(departuresBetween(5, 5), 0);
});

test('medianOf3: 3値の中央値（1tickフリッカ除去）', () => {
  assert.equal(medianOf3(8, 0, 8), 8);   // 真ん中の 0 はフリッカ
  assert.equal(medianOf3(8, 7, 7), 7);
  assert.equal(medianOf3(5, 6, 4), 5);
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `node --test tests/slot-occupancy.test.mjs`
Expected: FAIL — モジュール未作成。

- [ ] **Step 3: 実装**

`scripts/lib/slot-occupancy.mjs` を新規作成:
```javascript
// 乗り場先頭スロット占有方式の純関数群。

/** 在/不在のエッジ密度しきい値の既定。空きアスファルトは滑らか・車はエッジが多い。 */
export const DEFAULT_EDGE_THRESHOLD = 0.08;

/**
 * スロットの画像特徴から在(車あり)/不在を判定する純関数。
 * @param {{edge_density:number}|null} features analyzeROI の戻り
 * @param {number} edgeThreshold エッジ密度しきい値
 * @returns {boolean}
 */
export function slotOccupied(features, edgeThreshold = DEFAULT_EDGE_THRESHOLD) {
  if (!features || typeof features.edge_density !== 'number') return false;
  return features.edge_density >= edgeThreshold;
}

/**
 * stall-slots.json から指定乗り場の slots 配列を返す純関数。無ければ []。
 */
export function slotsForStall(slotConfig, stallName) {
  const st = (slotConfig && slotConfig.stalls || {})[stallName];
  return st && Array.isArray(st.slots) ? st.slots : [];
}

/**
 * スロット別の在/不在 dict から、指定 slots の占有数を数える純関数。
 * @param {Object} occupiedById {slotId: boolean}
 * @param {Array} slots [{id}, ...]
 * @returns {number}
 */
export function countStallOccupancy(occupiedById, slots) {
  let n = 0;
  for (const s of slots) if (occupiedById[s.id]) n += 1;
  return n;
}

/**
 * 在台数の前→現での出庫数。減った分が出庫、増加(列移動の補充)は 0。
 */
export function departuresBetween(prevCount, curCount) {
  if (typeof prevCount !== 'number' || typeof curCount !== 'number') return 0;
  return Math.max(0, prevCount - curCount);
}

/**
 * 3値の中央値。在台数の 1 tick だけのフリッカを除去する平滑用。
 */
export function medianOf3(a, b, c) {
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `node --test tests/slot-occupancy.test.mjs`
Expected: PASS — 6件。

- [ ] **Step 5: コミット**

```bash
git add scripts/lib/slot-occupancy.mjs tests/slot-occupancy.test.mjs
git diff --cached --name-only
git commit -m "$(cat <<'EOF'
feat(slot): 先頭スロット占有の純関数（在/不在・在台数・出庫差分）

slotOccupied/slotsForStall/countStallOccupancy/departuresBetween/medianOf3。
在台数の減少を出庫、増加は列移動として 0。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: 占有履歴 tick — analyzeROI export・slot-occupancy-tick.mjs

**作業ディレクトリ:** taxi-ic-helper worktree

**Files:**
- Modify: `scripts/lib/image-pool-analyzer.mjs`
- Create: `scripts/slot-occupancy-tick.mjs`

`slot-occupancy-tick.mjs` はファイル I/O・ネットワークを伴うため `node --check` ＋スモークで担保。

- [ ] **Step 1: analyzeROI を export する**

`scripts/lib/image-pool-analyzer.mjs` の `async function analyzeROI(jimpImage, roi) {` を
`export async function analyzeROI(jimpImage, roi) {` に変更する（他は変更しない）。

Run: `node --test tests/image-pool-analyzer.test.mjs`
Expected: PASS — 既存テスト回帰なし（export 追加のみ）。

- [ ] **Step 2: slot-occupancy-tick.mjs を作成**

`scripts/slot-occupancy-tick.mjs` を新規作成:
```javascript
#!/usr/bin/env node
// 60秒tick: 各乗り場のスロット領域を画像解析し在/不在を判定、
// 乗り場別の在台数を data/slot-occupancy-history.jsonl に追記する。
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { Jimp } from 'jimp';
import { analyzeROI } from './lib/image-pool-analyzer.mjs';
import { slotOccupied, slotsForStall, countStallOccupancy, DEFAULT_EDGE_THRESHOLD }
  from './lib/slot-occupancy.mjs';

const TTC_BASE = 'https://ttc.taxi-inf.jp';
const SLOTS_PATH = './scripts/lib/stall-slots.json';
const OUTPUT_PATH = './data/slot-occupancy-history.jsonl';
const STALLS = ['stall1', 'stall2', 'stall3', 'stall4'];

function jstNowIso() {
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  return jst.toISOString().replace('Z', '+09:00').replace(/\.\d+/, '');
}

async function fetchJimp(name) {
  const res = await fetch(`${TTC_BASE}/${name}.jpg`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Jimp.read(Buffer.from(await res.arrayBuffer()));
}

// スロット {cx,cy,r}(正規化) → analyzeROI 用ピクセル roi
function slotRoi(slot, w, h) {
  return {
    x: Math.round((slot.cx - slot.r) * w),
    y: Math.round((slot.cy - slot.r) * h),
    width: Math.round(slot.r * 2 * w),
    height: Math.round(slot.r * 2 * h),
  };
}

async function main() {
  if (!existsSync(SLOTS_PATH)) {
    console.error('[slot] stall-slots.json なし、skip');
    return;
  }
  const cfg = JSON.parse(readFileSync(SLOTS_PATH, 'utf8'));
  const threshold = (cfg._meta && cfg._meta.edge_threshold) || DEFAULT_EDGE_THRESHOLD;
  // 必要なカメラを集める
  const cameras = {};
  for (const name of STALLS) {
    const src = cfg.stalls?.[name]?.source;
    if (src && !cameras[src]) cameras[src] = null;
  }
  try {
    for (const cam of Object.keys(cameras)) {
      // source 名 'real01_line' → 画像名 'Real01_line'
      const imgName = cam.split('_').map((p, i) =>
        i === 0 ? p[0].toUpperCase() + p.slice(1) : p).join('_');
      cameras[cam] = await fetchJimp(imgName);
    }
  } catch (e) {
    console.error(`[slot] image fetch failed, skip tick: ${e.message}`);
    return;
  }
  const row = { schema_version: 1, ts: jstNowIso(), stalls: {} };
  for (const name of STALLS) {
    const st = cfg.stalls?.[name];
    if (!st) continue;
    const img = cameras[st.source];
    if (!img) continue;
    const { width, height } = img.bitmap;
    const occupiedById = {};
    for (const slot of slotsForStall(cfg, name)) {
      const feat = await analyzeROI(img, slotRoi(slot, width, height));
      occupiedById[slot.id] = slotOccupied(feat, threshold);
    }
    row.stalls[name] = {
      occ: countStallOccupancy(occupiedById, slotsForStall(cfg, name)),
      slots: occupiedById,
    };
  }
  appendFileSync(OUTPUT_PATH, JSON.stringify(row) + '\n', 'utf8');
  const summary = STALLS.map(n => `${n}=${row.stalls[n]?.occ ?? '-'}`).join(' ');
  console.log(`[slot] ok: ${summary}`);
}

main();
```

- [ ] **Step 3: 構文チェック**

Run: `node --check scripts/slot-occupancy-tick.mjs`
Expected: エラーなし。

- [ ] **Step 4: スモークテスト**

`stall-slots.json` が無い状態で実行し、graceful skip すること:
Run: `node scripts/slot-occupancy-tick.mjs`
Expected: `[slot] stall-slots.json なし、skip` と出て正常終了（Task 5 で校正データを入れる）。

- [ ] **Step 5: コミット**

```bash
git add scripts/lib/image-pool-analyzer.mjs scripts/slot-occupancy-tick.mjs
git diff --cached --name-only
git commit -m "$(cat <<'EOF'
feat(slot): 60秒tickのスロット占有計測スクリプト

各乗り場のスロット領域を analyzeROI で画像解析し在/不在判定、
乗り場別の在台数を slot-occupancy-history.jsonl に記録。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: slot-actuals.mjs — 占有履歴→乗り場別出庫・observe 配線

**作業ディレクトリ:** taxi-ic-helper worktree

**Files:**
- Create: `scripts/lib/slot-actuals.mjs`
- Test: `tests/slot-actuals.test.mjs`
- Modify: `scripts/observe-taxi-pool.mjs`

- [ ] **Step 1: 失敗するテストを書く**

`tests/slot-actuals.test.mjs` を新規作成:
```javascript
import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import { computeSlotActuals } from '../scripts/lib/slot-actuals.mjs';

// 占有履歴行
function row(ts, occ) {
  return { schema_version: 1, ts, stalls: {
    stall1: { occ: occ[0] }, stall2: { occ: occ[1] },
    stall3: { occ: occ[2] }, stall4: { occ: occ[3] } } };
}

test('computeSlotActuals: 在台数の減少を15分スロットの出庫に集計', () => {
  const now = new Date('2026-05-19T19:00:00+09:00');
  // 18:00-18:15 に stall1 が 8→8→7→7→6（中央値平滑後 8,7,7→… 計2台減）
  const history = [
    row('2026-05-19T18:02:00+09:00', [8, 0, 0, 0]),
    row('2026-05-19T18:05:00+09:00', [8, 0, 0, 0]),
    row('2026-05-19T18:08:00+09:00', [7, 0, 0, 0]),
    row('2026-05-19T18:11:00+09:00', [7, 0, 0, 0]),
    row('2026-05-19T18:14:00+09:00', [6, 0, 0, 0]),
  ];
  const r = computeSlotActuals(history, now);
  assert.equal(r.length, 1);
  assert.equal(r[0].slotStart, '18:00');
  assert.equal(r[0].stall1, 2);   // 8→6 で 2台出庫
  assert.equal(r[0].total, 2);
});

test('computeSlotActuals: 在台数の増加（列移動の補充）は出庫に数えない', () => {
  const now = new Date('2026-05-19T19:00:00+09:00');
  const history = [
    row('2026-05-19T18:02:00+09:00', [2, 0, 0, 0]),
    row('2026-05-19T18:05:00+09:00', [2, 0, 0, 0]),
    row('2026-05-19T18:08:00+09:00', [8, 0, 0, 0]),  // 列移動の補充
    row('2026-05-19T18:11:00+09:00', [8, 0, 0, 0]),
  ];
  const r = computeSlotActuals(history, now);
  assert.equal(r.length === 0 || r[0].stall1 === 0, true);
});

test('computeSlotActuals: 空・窓外のみ → 空配列', () => {
  const now = new Date('2026-05-19T19:00:00+09:00');
  assert.deepEqual(computeSlotActuals([], now), []);
  assert.deepEqual(computeSlotActuals(undefined, now), []);
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `node --test tests/slot-actuals.test.mjs`
Expected: FAIL — モジュール未作成。

- [ ] **Step 3: 実装**

`scripts/lib/slot-actuals.mjs` を新規作成。在台数列を中央値平滑し、隣接 tick の減少を
出庫として 15分スロットに集計する。出力形は `computeTrackActuals` と同じ
`[{slotStart,slotEnd,stall1..4,total}]`（下流の到着便ページがそのまま読める）。
```javascript
// スロット占有履歴 → 乗り場別出庫（15分スロット・実績形）。
import { departuresBetween, medianOf3 } from './slot-occupancy.mjs';

const SLOT_MS = 15 * 60 * 1000;
const STALLS = ['stall1', 'stall2', 'stall3', 'stall4'];

function fmtJst(ms) {
  const jst = new Date(ms + 9 * 3600 * 1000);
  return `${String(jst.getUTCHours()).padStart(2, '0')}:${String(jst.getUTCMinutes()).padStart(2, '0')}`;
}

/**
 * 占有履歴から乗り場別出庫を15分スロットで集計する。
 * @param {Array} occHistory slot-occupancy-history.jsonl の行配列（時刻昇順想定）
 * @param {Date} now 現在時刻
 * @param {number} [windowMinutes] 遡る分数（既定120）
 * @returns {Array<{slotStart,slotEnd,stall1,stall2,stall3,stall4,total}>}
 */
export function computeSlotActuals(occHistory, now, windowMinutes = 120) {
  const rows = (occHistory || [])
    .map(r => ({ tsMs: new Date(r.ts).getTime(), stalls: r.stalls || {} }))
    .filter(r => !Number.isNaN(r.tsMs))
    .sort((a, b) => a.tsMs - b.tsMs);
  if (rows.length < 2) return [];
  const endMs = now.getTime();
  const startMs = endMs - windowMinutes * 60 * 1000;
  // 乗り場ごとに在台数列を中央値平滑（1tickフリッカ除去）
  const smooth = {};
  for (const name of STALLS) {
    const raw = rows.map(r => (typeof r.stalls[name]?.occ === 'number' ? r.stalls[name].occ : 0));
    smooth[name] = raw.map((v, i) =>
      (i === 0 || i === raw.length - 1) ? v : medianOf3(raw[i - 1], v, raw[i + 1]));
  }
  const bins = new Map(); // binStartMs → {stall1..4, total}
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].tsMs < startMs || rows[i].tsMs > endMs) continue;
    const binStart = Math.floor(rows[i].tsMs / SLOT_MS) * SLOT_MS;
    let bin = bins.get(binStart);
    if (!bin) { bin = { stall1: 0, stall2: 0, stall3: 0, stall4: 0, total: 0 }; bins.set(binStart, bin); }
    for (const name of STALLS) {
      const dep = departuresBetween(smooth[name][i - 1], smooth[name][i]);
      bin[name] += dep;
      bin.total += dep;
    }
  }
  return [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([ms, bin]) => ({
    slotStart: fmtJst(ms), slotEnd: fmtJst(ms + SLOT_MS),
    stall1: bin.stall1, stall2: bin.stall2, stall3: bin.stall3, stall4: bin.stall4, total: bin.total,
  }));
}
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `node --test tests/slot-actuals.test.mjs`
Expected: PASS — 3件。

- [ ] **Step 5: observe-taxi-pool.mjs を配線**

`scripts/observe-taxi-pool.mjs` の出庫実績の供給元を track-history から
slot-occupancy-history に切り替える。`grep -n "computeTrackActuals\|trackHistory\|TRACK_HISTORY" scripts/observe-taxi-pool.mjs` で箇所を特定。

(a) import を追加: `import { computeSlotActuals } from './lib/slot-actuals.mjs';`

(b) `trackHistory` を読んでいる箇所の隣で、`data/slot-occupancy-history.jsonl` を
読み込む（無ければ `[]`）:
```javascript
    const slotHistory = [];
    if (existsSync('./data/slot-occupancy-history.jsonl')) {
      for (const line of readFileSync('./data/slot-occupancy-history.jsonl', 'utf8').trim().split('\n')) {
        if (!line.trim()) continue;
        try { slotHistory.push(JSON.parse(line)); } catch { /* skip */ }
      }
    }
```

(c) 出庫実績 `computeTrackActuals(trackHistory, ...)` を呼んでいる箇所を
`computeSlotActuals(slotHistory, ...)` に置き換える（戻り値の形は同一なので
`stall-actuals.json` 書き出し・下流は不変）。`trackTrend`（予測のトラッカーアンカー）も
slot ベースの出庫から作るよう、`computeSlotActuals(slotHistory, now, 60)` の窓集計で
`trackTrend.perStall` を構成する（現行 `computeTrackActuals` を使っている同ロジックを
`computeSlotActuals` に差し替え）。

具体差し替えは現行コードに合わせる。`computeTrackActuals` の呼び出し2箇所
（実績書き出し・trackTrend構築）を `computeSlotActuals` に替え、引数の履歴を
`slotHistory` にする。`trackHistory` 関連の読み込みが他で使われていなければ削除する。

- [ ] **Step 6: 構文チェックと全回帰**

Run: `node --check scripts/observe-taxi-pool.mjs`
Run: `npm test`
Expected: PASS — 全件。失敗したら停止して報告。

- [ ] **Step 7: コミット**

```bash
git add scripts/lib/slot-actuals.mjs tests/slot-actuals.test.mjs scripts/observe-taxi-pool.mjs
git diff --cached --name-only
git commit -m "$(cat <<'EOF'
feat(slot): 占有履歴→乗り場別出庫 computeSlotActuals・observe を配線

在台数列を中央値平滑し減少を出庫として15分集計。observe の出庫実績の
供給元を track-history から slot-occupancy-history に切替。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: 校正支援スクリプト calibrate-slots.mjs

**作業ディレクトリ:** taxi-ic-helper worktree

**Files:**
- Create: `scripts/calibrate-slots.mjs`

視覚・手動の校正支援。自動テスト対象外（`node --check` ＋スモークで担保）。

- [ ] **Step 1: スクリプトを作成**

`scripts/calibrate-slots.mjs` を新規作成。`/tmp/slots-input.json`（乗り場ごとの
スロット中心点リスト＋半径）を読み、現在フレームにスロット円を重ねた確認画像
`/tmp/slots-overlay-<camera>.png` を出力。`--write` で `scripts/lib/stall-slots.json` を
書き出す。
```javascript
#!/usr/bin/env node
// スロット校正支援。/tmp/slots-input.json を読み、確認画像を出力。--write で stall-slots.json。
//
// /tmp/slots-input.json の形:
// { "edge_threshold": 0.08,
//   "stalls": { "stall1": {"source":"real01_line","slots":[[cx,cy,r],...]}, ... } }
import { readFileSync, writeFileSync } from 'node:fs';
import { Jimp } from 'jimp';

const TTC_BASE = 'https://ttc.taxi-inf.jp';
const SLOTS_PATH = './scripts/lib/stall-slots.json';
const INPUT_PATH = '/tmp/slots-input.json';
const LABELS = {
  stall1: '第1乗り場 (JAL 2番ポール T1)', stall2: '第2乗り場 (JAL 18番ポール T1)',
  stall3: '第3乗り場 (ANA 3番ポール T2)', stall4: '第4乗り場 (ANA 19番ポール T2)',
};
const RGBA = { stall1: 0xe22233ff, stall2: 0xddcc00ff, stall3: 0x22cc33ff, stall4: 0x2288eeff };

async function fetchJimp(imgName) {
  const res = await fetch(`${TTC_BASE}/${imgName}.jpg`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Jimp.read(Buffer.from(await res.arrayBuffer()));
}
function imageNameOf(source) {
  return source.split('_').map((p, i) => i === 0 ? p[0].toUpperCase() + p.slice(1) : p).join('_');
}

async function main() {
  const inp = JSON.parse(readFileSync(INPUT_PATH, 'utf8'));
  // カメラごとに確認画像を出力
  const bySource = {};
  for (const [name, st] of Object.entries(inp.stalls)) {
    (bySource[st.source] ||= []).push([name, st.slots]);
  }
  for (const [source, entries] of Object.entries(bySource)) {
    const img = await fetchJimp(imageNameOf(source));
    const { width: w, height: h } = img.bitmap;
    const big = img.clone().resize({ w: w * 2, h: h * 2 });
    for (const [name, slots] of entries) {
      const col = RGBA[name] || 0xffffffff;
      for (const [cx, cy, r] of slots) {
        // 円を点で描く（簡易）
        const px = cx * w * 2, py = cy * h * 2, rr = r * w * 2;
        for (let a = 0; a < 360; a += 6) {
          const x = Math.round(px + rr * Math.cos(a * Math.PI / 180));
          const y = Math.round(py + rr * Math.sin(a * Math.PI / 180));
          if (x >= 0 && y >= 0 && x < w * 2 && y < h * 2) big.setPixelColor(col, x, y);
        }
      }
    }
    await big.write(`/tmp/slots-overlay-${source}.png`);
    console.log(`[calibrate] /tmp/slots-overlay-${source}.png`);
  }
  if (process.argv.includes('--write')) {
    const out = { _meta: { image_size: [800, 600], edge_threshold: inp.edge_threshold ?? 0.08,
      note: 'スロット中心は0-1正規化座標' }, schema_version: 1, stalls: {} };
    for (const [name, st] of Object.entries(inp.stalls)) {
      out.stalls[name] = {
        source: st.source, label: LABELS[name] || name,
        slots: st.slots.map(([cx, cy, r], i) => ({ id: `${name}-${i + 1}`, cx, cy, r })),
      };
    }
    writeFileSync(SLOTS_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8');
    console.log(`[calibrate] wrote ${SLOTS_PATH}`);
  }
}
main();
```

- [ ] **Step 2: 構文チェック**

Run: `node --check scripts/calibrate-slots.mjs`
Expected: エラーなし。

- [ ] **Step 3: スモークテスト**

`/tmp/slots-input.json` に仮の1乗り場（slots 2個）を書いて実行し、確認画像が出ること:
```bash
cat > /tmp/slots-input.json <<'JSON'
{ "edge_threshold": 0.08,
  "stalls": { "stall1": { "source": "real01_line", "slots": [[0.6,0.2,0.03],[0.65,0.22,0.03]] } } }
JSON
node scripts/calibrate-slots.mjs
```
Expected: `/tmp/slots-overlay-real01_line.png` が生成される。ネットワーク不可なら
その旨を報告（構文チェックが通れば最低限可）。

- [ ] **Step 4: コミット**

```bash
git add scripts/calibrate-slots.mjs
git diff --cached --name-only
git commit -m "$(cat <<'EOF'
feat(slot): スロット校正支援スクリプト calibrate-slots.mjs

現在フレームにスロット円を重ねた確認画像を出力。--write で stall-slots.json。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: 実校正・launchd差し替え・検証・本番反映（対話タスク — 制御セッションが実施）

**このタスクはサブエージェントに渡さない。** カメラ画像を見てスロットを定義するのは
ユーザーとの対話が必要なため、制御セッションが実施する。

- [ ] **Step 1: スロットを定義**

ユーザーと一緒に、各乗り場の先頭領域のスロット中心点を決める（容量: 乗1=8/乗2=7/
乗3=8/乗4=不均一）。クリック式ピッカー等で各スロットの `[cx,cy,r]` を集め
`/tmp/slots-input.json` に入れ、`calibrate-slots.mjs` で確認画像を生成 → ユーザー確認 →
合うまで調整。

- [ ] **Step 2: 在/不在しきい値を調整**

現在フレーム（できれば昼・夜の両方）で各スロットの `analyzeROI` のエッジ密度を実測し、
空きスロットと在スロットを分けるしきい値を決める。`/tmp/slots-input.json` の
`edge_threshold` に設定。

- [ ] **Step 3: stall-slots.json を書き出す**

```bash
node scripts/calibrate-slots.mjs --write
```
`npm test` が引き続き全件パスすること（テストは独自データなので影響しないが確認）。

- [ ] **Step 4: 実データ検証**

`slot-occupancy-tick.mjs` を手動で数回実行して `slot-occupancy-history.jsonl` に
数行ためる → `computeSlotActuals` を通し、乗り場別の在台数・出庫が観測実態と整合するか
確認する。結果をユーザーに報告。ずれるなら Step 1-2 に戻る。

- [ ] **Step 5: launchd をスロット方式へ差し替え**

`scripts/install-track-launchd.sh` を、`track_vehicles.py`（YOLO）の代わりに
`node scripts/slot-occupancy-tick.mjs` を 60秒間隔で起動するよう書き換える
（`PYTHON`/`TRACK_SCRIPT` を node 起動に。plist の `ProgramArguments` を node＋スクリプトに）。
旧 `track_vehicles.py` は当面残置（撤去は別途）。

- [ ] **Step 6: コミットして push**

```bash
git add scripts/lib/stall-slots.json scripts/install-track-launchd.sh
git diff --cached --name-only
git commit -m "$(cat <<'EOF'
feat(slot): stall-slots.json 校正・launchd をスロットtickへ差し替え

ユーザー校正で各乗り場の先頭スロットを定義。60秒tickを YOLO トラッカー
から slot-occupancy-tick へ差し替え。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git pull --rebase --autostash origin main
git push origin feat/front-slot-occupancy:main
```

- [ ] **Step 7: 完了報告**

push 後の SHA を報告。Mac mini で launchd を再インストール（`install-track-launchd.sh`
再実行）する必要があること、観測スクリプトが次 tick からスロット方式になることを伝える。

---

## 完了条件

- 60秒tickで各乗り場のスロット占有が計測され `slot-occupancy-history.jsonl` に記録される。
- `computeSlotActuals` が在台数の減少を出庫として15分集計、到着便ページの実績/予測へ流れる。
- `slot-occupancy.mjs`・`slot-actuals.mjs` の単体テストがパス。`npm test` 全件回帰なし。
- 実データ検証で乗り場別出庫が観測実態と整合。
- taxi-ic-helper main 反映、launchd がスロットtick起動。

## Self-Review

- **Spec coverage:** 設計§1(スロット定義/stall-slots.json)→Task 4・Task 5。§2(在/不在判定)
  →Task 1 `slotOccupied`・Task 2。§3(出庫カウント)→Task 1 `departuresBetween`/`medianOf3`・
  Task 3 `computeSlotActuals`。§4(出力)→Task 3。§5(校正)→Task 4・Task 5。データフロー→
  Task 2(tick)→Task 3(集計)。テスト方針→Task 1・3 の TDD。
- **Placeholder scan:** TBD/TODO なし。純関数タスク（1・3）は実コード全文。tick/校正/observe
  配線は具体コードまたは具体的な差し替え指示。校正の実座標・しきい値は Task 5（対話）で確定。
- **Type consistency:** `slotOccupied(features,threshold)`/`countStallOccupancy(occById,slots)`/
  `departuresBetween(prev,cur)`/`medianOf3` は Task 1 定義、Task 2(tick)・Task 3 が使用。
  `stall-slots.json` の `stalls.<name>.slots[*]={id,cx,cy,r}` は Task 4 が書き Task 2 が読む。
  `computeSlotActuals` の戻り `[{slotStart,slotEnd,stall1..4,total}]` は `computeTrackActuals`
  と同形（observe 下流不変）。占有履歴行 `{schema_version,ts,stalls:{<name>:{occ,slots}}}` は
  Task 2 が書き Task 3 が読む。
