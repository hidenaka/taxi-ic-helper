# T3 前方プール 流れ計測（Phase 1: ログ収集）実装プラン

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Real108（T3 前方プール）の gate ROI 面密度を、フレーム重複排除つき 60秒 tick で `data/t3-front-flow-history.jsonl` に記録するログ収集パイプラインを構築する（予測未接続）。

**Architecture:** T1/T2 の advance-counter 純関数（`meanGrayInBox` / `brightPixelRatio` / `pickFrontSignal` / `detectReplenishments` / `binCountsByWindow`）を再利用。T3 固有の新規コードは「gate ROI パース・フレーム dedup・履歴行ビルダー」の純関数と、それを束ねる独立 tick のみ。すべて `t3-front-flow-*` プレフィックスで既存に非干渉。

**Tech Stack:** Node.js (ESM, `node --test`), Jimp v1, launchd (macOS), git (merge=union for jsonl)

**Spec:** `docs/superpowers/specs/2026-06-10-t3-front-flow-movement-shift-design.md`

---

## ファイル構成

| 区分 | パス | 責務 |
|---|---|---|
| Create | `scripts/lib/t3-front-flow.mjs` | 純関数: ROIパース / gate→box変換 / dedup判定 / JST変換 / 履歴行ビルダー / 両極性集計 |
| Create | `tests/t3-front-flow.test.mjs` | 上記純関数のテスト |
| Create | `data/t3-front-flow-rois.json` | gate ROI 定義（座標は校正で確定、未校正なら tick が skip） |
| Create | `scripts/t3-front-flow-tick.mjs` | 60秒 tick 本体（fetch + dedup + frontDensity 記録） |
| Create | `scripts/t3-front-flow-report.mjs` | オフライン両極性分析（上昇/下降エッジを 15分窓で併記） |
| Create | `scripts/annotate-t3-gate.mjs` | 校正支援: gate ROI を実画像にオーバーレイした注釈画像を出力 |
| Create | `scripts/install-t3-front-flow-launchd.sh` | launchd ジョブ `jp.taxi-ic-helper.t3-front-flow` の install/uninstall/status |
| Modify | `scripts/observe-tick-local.sh` (行100付近の `git add`) | `data/t3-front-flow-history.jsonl` を追加 |
| Modify | `.gitattributes` | `data/t3-front-flow-history.jsonl merge=union` を追加 |

実行コンテキスト: リポジトリは `/Users/nakanohideaki/repos/taxi-ic-helper`。テストは `node --test tests/<file>` で個別実行、全体は `npm test`。

---

### Task 1: 純関数 — ROI パースと gate→box 変換

**Files:**
- Create: `scripts/lib/t3-front-flow.mjs`
- Test: `tests/t3-front-flow.test.mjs`

- [ ] **Step 1: 失敗するテストを書く**

`tests/t3-front-flow.test.mjs` を新規作成:

```javascript
import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import {
  parseT3FrontFlowRois, gateToBox,
} from '../scripts/lib/t3-front-flow.mjs';

// ---- parseT3FrontFlowRois ----

const VALID_ROIS = {
  schema_version: 1,
  camera: 'Real108',
  gate: { x: 0.25, y: 0.42, width: 0.5, height: 0.2 },
  params: { nightLum: 60, lanternK: 4, lanternT: 50 },
};

test('parseT3FrontFlowRois: 正常系で camera/gate/params を返す', () => {
  const r = parseT3FrontFlowRois(VALID_ROIS);
  assert.equal(r.camera, 'Real108');
  assert.deepEqual(r.gate, { x: 0.25, y: 0.42, width: 0.5, height: 0.2 });
  assert.equal(r.params.nightLum, 60);
});

test('parseT3FrontFlowRois: schema_version 不一致は throw', () => {
  assert.throws(() => parseT3FrontFlowRois({ ...VALID_ROIS, schema_version: 2 }), /schema_version/);
});

test('parseT3FrontFlowRois: gate 欠損は throw', () => {
  const { gate, ...rest } = VALID_ROIS;
  assert.throws(() => parseT3FrontFlowRois(rest), /gate/);
});

test('parseT3FrontFlowRois: params 省略時はデフォルト(nightLum60/lanternK4/lanternT50)', () => {
  const { params, ...rest } = VALID_ROIS;
  const r = parseT3FrontFlowRois(rest);
  assert.deepEqual(r.params, { nightLum: 60, lanternK: 4, lanternT: 50 });
});

test('parseT3FrontFlowRois: 未校正(width/height が 0)は calibrated=false', () => {
  const r = parseT3FrontFlowRois({ ...VALID_ROIS, gate: { x: 0, y: 0, width: 0, height: 0 } });
  assert.equal(r.calibrated, false);
});

test('parseT3FrontFlowRois: 校正済みは calibrated=true', () => {
  assert.equal(parseT3FrontFlowRois(VALID_ROIS).calibrated, true);
});

// ---- gateToBox ----

test('gateToBox: {x,y,width,height} → {x0,x1,y0,y1}', () => {
  assert.deepEqual(
    gateToBox({ x: 0.25, y: 0.42, width: 0.5, height: 0.2 }),
    { x0: 0.25, x1: 0.75, y0: 0.42, y1: 0.62 }
  );
});

test('gateToBox: 1.0 を超える端は 1.0 にクランプ', () => {
  const b = gateToBox({ x: 0.8, y: 0.9, width: 0.5, height: 0.5 });
  assert.equal(b.x1, 1.0);
  assert.equal(b.y1, 1.0);
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `cd /Users/nakanohideaki/repos/taxi-ic-helper && node --test tests/t3-front-flow.test.mjs`
Expected: FAIL（`Cannot find module .../scripts/lib/t3-front-flow.mjs`）

- [ ] **Step 3: 最小実装を書く**

`scripts/lib/t3-front-flow.mjs` を新規作成:

```javascript
// t3-front-flow — T3 前方プール(Real108)の流れ計測 Phase 1 の純関数群。
// 画像 I/O・ネットワークに依存しない。tick 本体は scripts/t3-front-flow-tick.mjs。
// 設計: docs/superpowers/specs/2026-06-10-t3-front-flow-movement-shift-design.md

export const T3_FRONT_FLOW_SCHEMA_VERSION = 1;

const DEFAULT_PARAMS = { nightLum: 60, lanternK: 4, lanternT: 50 };

/**
 * data/t3-front-flow-rois.json のバリデーションと抽出。
 * gate の width/height が 0 のときは「未校正」(calibrated=false) を返し、tick 側で skip させる。
 * @returns {{camera:string, gate:{x,y,width,height}, params:{nightLum,lanternK,lanternT}, calibrated:boolean}}
 */
export function parseT3FrontFlowRois(json) {
  if (!json || json.schema_version !== T3_FRONT_FLOW_SCHEMA_VERSION) {
    throw new Error(`t3-front-flow-rois: schema_version=${T3_FRONT_FLOW_SCHEMA_VERSION} が必要`);
  }
  const g = json.gate;
  if (!g || typeof g.x !== 'number' || typeof g.y !== 'number' ||
      typeof g.width !== 'number' || typeof g.height !== 'number') {
    throw new Error('t3-front-flow-rois: gate {x,y,width,height} が必要');
  }
  const params = { ...DEFAULT_PARAMS, ...(json.params ?? {}) };
  const calibrated = g.width > 0 && g.height > 0;
  return { camera: json.camera ?? 'Real108', gate: { ...g }, params, calibrated };
}

/**
 * gate ROI ({x,y,width,height} 正規化) を advance-counter の box 形式 ({x0,x1,y0,y1}) へ。
 * 1.0 を超える端はクランプ。
 */
export function gateToBox(gate) {
  return {
    x0: gate.x,
    x1: Math.min(1.0, gate.x + gate.width),
    y0: gate.y,
    y1: Math.min(1.0, gate.y + gate.height),
  };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `node --test tests/t3-front-flow.test.mjs`
Expected: PASS（8 tests）

- [ ] **Step 5: コミット**

```bash
git add scripts/lib/t3-front-flow.mjs tests/t3-front-flow.test.mjs
git commit -m "feat(t3-flow): gate ROI パースと box 変換の純関数"
```

---

### Task 2: 純関数 — フレーム重複排除の判定

**Files:**
- Modify: `scripts/lib/t3-front-flow.mjs`（関数追加）
- Test: `tests/t3-front-flow.test.mjs`（テスト追加）

- [ ] **Step 1: 失敗するテストを追加**

`tests/t3-front-flow.test.mjs` の import に `isSameFrame` を足し、末尾に追加:

```javascript
// ---- isSameFrame (dedup) ----

test('isSameFrame: Last-Modified が同じなら true', () => {
  const prev = { last_modified: 'Tue, 09 Jun 2026 17:18:11 GMT', frame_hash: 'aaa' };
  assert.equal(isSameFrame(prev, { lastModified: 'Tue, 09 Jun 2026 17:18:11 GMT', hash: 'bbb' }), true);
});

test('isSameFrame: Last-Modified が異なれば false (hash が同じでも)', () => {
  const prev = { last_modified: 'Tue, 09 Jun 2026 17:18:11 GMT', frame_hash: 'aaa' };
  assert.equal(isSameFrame(prev, { lastModified: 'Tue, 09 Jun 2026 17:20:17 GMT', hash: 'aaa' }), false);
});

test('isSameFrame: Last-Modified が両方無ければ hash で判定', () => {
  const prev = { last_modified: null, frame_hash: 'aaa' };
  assert.equal(isSameFrame(prev, { lastModified: null, hash: 'aaa' }), true);
  assert.equal(isSameFrame(prev, { lastModified: null, hash: 'bbb' }), false);
});

test('isSameFrame: prev が無い(初回)は false', () => {
  assert.equal(isSameFrame(null, { lastModified: 'x', hash: 'y' }), false);
  assert.equal(isSameFrame(undefined, { lastModified: 'x', hash: 'y' }), false);
});

test('isSameFrame: 片方だけ Last-Modified 無しは hash フォールバック', () => {
  const prev = { last_modified: 'Tue, 09 Jun 2026 17:18:11 GMT', frame_hash: 'aaa' };
  assert.equal(isSameFrame(prev, { lastModified: null, hash: 'aaa' }), true);
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `node --test tests/t3-front-flow.test.mjs`
Expected: FAIL（`isSameFrame is not a function` 系）

- [ ] **Step 3: 実装を追加**

`scripts/lib/t3-front-flow.mjs` 末尾に追加:

```javascript
/**
 * 前回 state と今回の取得結果が「同じフレーム」かを判定する (R4: 同一フレーム連打防止)。
 * Last-Modified が両方あればそれで比較、どちらか欠けたら画像バイト列の md5 で比較。
 * @param {{last_modified?:string|null, frame_hash?:string}|null} prevState
 * @param {{lastModified:string|null, hash:string}} current
 * @returns {boolean}
 */
export function isSameFrame(prevState, current) {
  if (!prevState) return false;
  if (prevState.last_modified && current.lastModified) {
    return prevState.last_modified === current.lastModified;
  }
  return prevState.frame_hash === current.hash;
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `node --test tests/t3-front-flow.test.mjs`
Expected: PASS（13 tests）

- [ ] **Step 5: コミット**

```bash
git add scripts/lib/t3-front-flow.mjs tests/t3-front-flow.test.mjs
git commit -m "feat(t3-flow): フレーム重複排除の判定純関数 (Last-Modified 優先 + hash フォールバック)"
```

---

### Task 3: 純関数 — JST 変換と履歴行ビルダー

**Files:**
- Modify: `scripts/lib/t3-front-flow.mjs`（関数追加）
- Test: `tests/t3-front-flow.test.mjs`（テスト追加）

- [ ] **Step 1: 失敗するテストを追加**

import に `toJstIso, buildFlowRow` を足し、末尾に追加:

```javascript
// ---- toJstIso ----

test('toJstIso: Date → JST ISO 文字列 (+09:00)', () => {
  // 2026-06-09T17:18:11Z = JST 2026-06-10T02:18:11+09:00
  const d = new Date('2026-06-09T17:18:11Z');
  assert.equal(toJstIso(d), '2026-06-10T02:18:11+09:00');
});

test('toJstIso: HTTP Last-Modified 形式の文字列も受ける', () => {
  assert.equal(toJstIso(new Date('Tue, 09 Jun 2026 17:18:11 GMT')), '2026-06-10T02:18:11+09:00');
});

// ---- buildFlowRow ----

test('buildFlowRow: schema_version 1 の履歴行を組み立てる', () => {
  const row = buildFlowRow({
    frameTs: '2026-06-10T02:18:11+09:00',
    tickTs: '2026-06-10T02:19:36+09:00',
    camera: 'Real108',
    isNight: false,
    frontDensity: 84.234,
    frameHash: 'af655cd',
  });
  assert.deepEqual(row, {
    schema_version: 1,
    frame_ts: '2026-06-10T02:18:11+09:00',
    tick_ts: '2026-06-10T02:19:36+09:00',
    camera: 'Real108',
    is_night: false,
    front_density: 84.23,
    frame_hash: 'af655cd',
  });
});

test('buildFlowRow: front_density は小数2桁に丸める', () => {
  const row = buildFlowRow({
    frameTs: 'a', tickTs: 'b', camera: 'Real108',
    isNight: true, frontDensity: 12.3456, frameHash: 'h',
  });
  assert.equal(row.front_density, 12.35);
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `node --test tests/t3-front-flow.test.mjs`
Expected: FAIL

- [ ] **Step 3: 実装を追加**

`scripts/lib/t3-front-flow.mjs` 末尾に追加:

```javascript
/**
 * Date → JST ISO 文字列 (+09:00)。movement-shift-tick.mjs の jstTimestamp と同じ表現。
 */
export function toJstIso(d) {
  const z = (n) => String(n).padStart(2, '0');
  const j = new Date(d.getTime() + 9 * 3600 * 1000);
  return `${j.getUTCFullYear()}-${z(j.getUTCMonth() + 1)}-${z(j.getUTCDate())}T` +
    `${z(j.getUTCHours())}:${z(j.getUTCMinutes())}:${z(j.getUTCSeconds())}+09:00`;
}

/**
 * t3-front-flow-history.jsonl の1行を組み立てる。frame_ts はフレームの実時刻
 * (Last-Modified 由来)で、後段の計数の時刻軸に使う。front_density は小数2桁。
 */
export function buildFlowRow({ frameTs, tickTs, camera, isNight, frontDensity, frameHash }) {
  return {
    schema_version: T3_FRONT_FLOW_SCHEMA_VERSION,
    frame_ts: frameTs,
    tick_ts: tickTs,
    camera,
    is_night: isNight,
    front_density: Math.round(frontDensity * 100) / 100,
    frame_hash: frameHash,
  };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `node --test tests/t3-front-flow.test.mjs`
Expected: PASS（17 tests）

- [ ] **Step 5: コミット**

```bash
git add scripts/lib/t3-front-flow.mjs tests/t3-front-flow.test.mjs
git commit -m "feat(t3-flow): JST変換と履歴行ビルダーの純関数"
```

---

### Task 4: 純関数 — 両極性集計（report 用）

**Files:**
- Modify: `scripts/lib/t3-front-flow.mjs`（関数追加）
- Test: `tests/t3-front-flow.test.mjs`（テスト追加）

下降エッジは「値の符号反転 → `detectReplenishments`」で対称に数える（R3: 極性を決め打ちしない）。

- [ ] **Step 1: 失敗するテストを追加**

import に `summarizeBothPolarities` を足し、末尾に追加:

```javascript
// ---- summarizeBothPolarities ----

test('summarizeBothPolarities: 上昇段は rising、下降段は falling に出る', () => {
  // 60秒刻み。100→160 の立ち上がり(持続)と、160→100 の立ち下がり(持続)を1回ずつ。
  const t0 = Date.parse('2026-06-10T03:00:00+09:00') / 1000;
  const times = Array.from({ length: 12 }, (_, i) => t0 + i * 60);
  const values = [100, 100, 100, 160, 160, 160, 160, 160, 100, 100, 100, 100];
  const r = summarizeBothPolarities(values, times, {
    absThreshold: 30, persistSec: 120, debounceSec: 120, smoothK: 1, windowSec: 900,
  });
  const risingTotal = Object.values(r.rising).reduce((a, b) => a + b, 0);
  const fallingTotal = Object.values(r.falling).reduce((a, b) => a + b, 0);
  assert.equal(risingTotal, 1);
  assert.equal(fallingTotal, 1);
});

test('summarizeBothPolarities: 平坦な系列は両方 0', () => {
  const t0 = 1765000000;
  const times = Array.from({ length: 6 }, (_, i) => t0 + i * 60);
  const r = summarizeBothPolarities([100, 101, 99, 100, 100, 101], times, {
    absThreshold: 30, persistSec: 120, debounceSec: 120, smoothK: 1, windowSec: 900,
  });
  assert.deepEqual(r.rising, {});
  assert.deepEqual(r.falling, {});
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `node --test tests/t3-front-flow.test.mjs`
Expected: FAIL

- [ ] **Step 3: 実装を追加**

`scripts/lib/t3-front-flow.mjs` の先頭に import を追加し、末尾に関数を追加:

```javascript
// ファイル先頭に追加
import { detectReplenishments, binCountsByWindow } from './advance-counter.mjs';
```

```javascript
/**
 * 上昇エッジ(補充=詰め)と下降エッジ(枯渇=出庫)の両方を 15分窓などで集計する。
 * 極性は Phase 2 の実データ検証で確定するため、ここでは両方を併記する (R3)。
 * 下降は値の符号反転で detectReplenishments に対称に通す。
 * @param {number[]} values front_density 列(時系列順)
 * @param {number[]} times  epoch 秒(昇順, frame_ts 由来)
 * @param {{absThreshold:number, persistSec?:number, debounceSec?:number, smoothK?:number, windowSec?:number}} opts
 * @returns {{rising:Record<number,number>, falling:Record<number,number>}}
 */
export function summarizeBothPolarities(values, times, opts) {
  const windowSec = opts.windowSec ?? 900;
  const detectOpts = {
    absThreshold: opts.absThreshold,
    persistSec: opts.persistSec ?? 120,
    debounceSec: opts.debounceSec ?? 120,
    smoothK: opts.smoothK ?? 3,
  };
  const rising = detectReplenishments(values, times, detectOpts);
  const falling = detectReplenishments(values.map((v) => -v), times, detectOpts);
  return {
    rising: binCountsByWindow(rising.eventTimes, windowSec),
    falling: binCountsByWindow(falling.eventTimes, windowSec),
  };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `node --test tests/t3-front-flow.test.mjs`
Expected: PASS（19 tests）

- [ ] **Step 5: 既存テストの回帰がないことを確認**

Run: `npm test 2>&1 | tail -5`
Expected: 全 pass（fail 0）

- [ ] **Step 6: コミット**

```bash
git add scripts/lib/t3-front-flow.mjs tests/t3-front-flow.test.mjs
git commit -m "feat(t3-flow): 両極性(上昇/下降)エッジ集計の純関数"
```

---

### Task 5: gate ROI テンプレートと tick 本体

**Files:**
- Create: `data/t3-front-flow-rois.json`
- Create: `scripts/t3-front-flow-tick.mjs`

- [ ] **Step 1: ROI テンプレートを作成**

`data/t3-front-flow-rois.json`（座標プレースホルダー = 未校正。tick は skip する）:

```json
{
  "_meta": {
    "image_size": [1024, 576],
    "note": "T3 前方(Real108) 流れ計測用 gate ROI。出口直前の細い帯。座標は校正(annotate-t3-gate.mjs)で確定。width/height が 0 の間は tick が skip する"
  },
  "schema_version": 1,
  "camera": "Real108",
  "gate": { "x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0 },
  "params": { "nightLum": 60, "lanternK": 4, "lanternT": 50 }
}
```

- [ ] **Step 2: tick 本体を作成**

`scripts/t3-front-flow-tick.mjs`:

```javascript
#!/usr/bin/env node
// t3-front-flow-tick — T3 前方プール(Real108)の gate ROI 面密度を記録する 60秒 tick。
//
// 設計: docs/superpowers/specs/2026-06-10-t3-front-flow-movement-shift-design.md (Phase 1)
// - ttc の Real108 を直接 fetch し、Last-Modified/ETag(無ければ md5)で前回と同じフレームなら skip
//   (実更新は約1〜2分。60秒 tick の同一フレーム連打を防ぐ = R4)
// - 計数の時刻軸に使う frame_ts はフレームの実時刻(Last-Modified)を記録する
// - 予測には未接続。data/t3-front-flow-history.jsonl への追記専用。git は触らない
//   (commit/push は5分の observe ループが担う = movement-shift と同じ構造)
// - 失敗しても exit 0 (本流の tick を止めない)

import { Jimp } from 'jimp';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { meanGrayInBox, brightPixelRatio, pickFrontSignal } from './lib/advance-counter.mjs';
import {
  parseT3FrontFlowRois, gateToBox, isSameFrame, toJstIso, buildFlowRow,
} from './lib/t3-front-flow.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROIS_PATH = join(ROOT, 'data/t3-front-flow-rois.json');
const STATE_PATH = join(ROOT, 'data/t3-front-flow-state.json');
const HISTORY_PATH = join(ROOT, 'data/t3-front-flow-history.jsonl');
const TIMEOUT_MS = 15000;

async function main() {
  const cfg = parseT3FrontFlowRois(JSON.parse(readFileSync(ROIS_PATH, 'utf8')));
  if (!cfg.calibrated) {
    console.log('[t3-front-flow] gate ROI 未校正のため skip');
    return;
  }

  const res = await fetch(`https://ttc.taxi-inf.jp/${cfg.camera}.jpg`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const lastModified = res.headers.get('last-modified');
  const buffer = Buffer.from(await res.arrayBuffer());
  const hash = createHash('md5').update(buffer).digest('hex');

  const prevState = existsSync(STATE_PATH)
    ? JSON.parse(readFileSync(STATE_PATH, 'utf8'))
    : null;
  if (isSameFrame(prevState, { lastModified, hash })) {
    console.log(`[t3-front-flow] 同一フレーム skip (${lastModified ?? hash.slice(0, 7)})`);
    return;
  }

  const img = await Jimp.read(buffer);
  const box = gateToBox(cfg.gate);
  const { nightLum, lanternK, lanternT } = cfg.params;
  const mean = meanGrayInBox(img, box, 3);
  const isNight = mean < nightLum;
  const ratio = isNight ? brightPixelRatio(img, box, lanternT, 3) : 0;
  const frontDensity = pickFrontSignal(mean, ratio, { nightLum, lanternK });

  const frameTs = lastModified ? toJstIso(new Date(lastModified)) : toJstIso(new Date());
  const tickTs = toJstIso(new Date());
  const row = buildFlowRow({
    frameTs, tickTs, camera: cfg.camera, isNight, frontDensity, frameHash: hash,
  });

  appendFileSync(HISTORY_PATH, JSON.stringify(row) + '\n');
  writeFileSync(STATE_PATH, JSON.stringify({
    last_modified: lastModified, frame_hash: hash, frame_ts: frameTs,
  }));
  console.log(`[t3-front-flow] ${frameTs} density=${row.front_density} night=${isNight}`);
}

main().catch((e) => {
  console.warn(`[t3-front-flow] skip: ${e.message}`);
  process.exit(0);
});
```

- [ ] **Step 3: 未校正 skip の動作確認（手動実行）**

Run: `cd /Users/nakanohideaki/repos/taxi-ic-helper && node scripts/t3-front-flow-tick.mjs`
Expected: `[t3-front-flow] gate ROI 未校正のため skip` と表示、exit 0、`data/t3-front-flow-history.jsonl` は作られない

- [ ] **Step 4: 仮校正値で実フェッチの動作確認（手動実行）**

一時的に `data/t3-front-flow-rois.json` の gate を `{ "x": 0.1, "y": 0.4, "width": 0.8, "height": 0.3 }` にして:

Run: `node scripts/t3-front-flow-tick.mjs && node scripts/t3-front-flow-tick.mjs`
Expected:
- 1回目: `[t3-front-flow] 2026-...+09:00 density=NN.NN night=false` → history に1行追記
- 2回目（直後）: `[t3-front-flow] 同一フレーム skip (...)` → 追記されない

確認後、gate を `{ "x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0 }` に戻し、検証で書かれた `data/t3-front-flow-history.jsonl` と `data/t3-front-flow-state.json` を削除する:

```bash
rm -f data/t3-front-flow-history.jsonl data/t3-front-flow-state.json
```

- [ ] **Step 5: コミット**

```bash
git add data/t3-front-flow-rois.json scripts/t3-front-flow-tick.mjs
git commit -m "feat(t3-flow): 60秒 tick 本体 (Last-Modified dedup + gate frontDensity 記録)"
```

---

### Task 6: オフライン両極性レポート

**Files:**
- Create: `scripts/t3-front-flow-report.mjs`

- [ ] **Step 1: レポートスクリプトを作成**

`scripts/t3-front-flow-report.mjs`:

```javascript
#!/usr/bin/env node
// t3-front-flow-report — t3-front-flow-history.jsonl を読み、上昇/下降の両極性で
// 15分窓のイベント数を併記する Phase 2 検証用オフラインレポート。
// 極性・閾値は未確定のため、複数の absThreshold を並べて感度も見せる。
// CLI: node scripts/t3-front-flow-report.mjs [--window 900] [--thresholds 10,20,30]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { summarizeBothPolarities, toJstIso } from './lib/t3-front-flow.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HISTORY_PATH = join(ROOT, 'data/t3-front-flow-history.jsonl');
const REPORT_PATH = join(ROOT, 'data/t3-front-flow-report.json');

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

function main() {
  if (!existsSync(HISTORY_PATH)) {
    console.log('[t3-flow-report] history なし。tick 稼働後に実行する');
    return;
  }
  const rows = readFileSync(HISTORY_PATH, 'utf8').trim().split('\n')
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => a.frame_ts.localeCompare(b.frame_ts));
  if (rows.length < 10) {
    console.log(`[t3-flow-report] データ不足 (${rows.length} 行)。もう少し溜めてから`);
    return;
  }
  const values = rows.map((r) => r.front_density);
  const times = rows.map((r) => Date.parse(r.frame_ts) / 1000);
  const windowSec = Number(arg('window', '900'));
  const thresholds = arg('thresholds', '10,20,30').split(',').map(Number);

  const byThreshold = {};
  for (const th of thresholds) {
    const { rising, falling } = summarizeBothPolarities(values, times, {
      absThreshold: th, windowSec,
    });
    const toList = (binned) => Object.entries(binned)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([start, count]) => ({
        windowStart: toJstIso(new Date(Number(start) * 1000)),
        count,
      }));
    byThreshold[th] = { rising: toList(rising), falling: toList(falling) };
  }

  const report = {
    schemaVersion: 1,
    generatedAt: toJstIso(new Date()),
    rowCount: rows.length,
    span: { from: rows[0].frame_ts, to: rows[rows.length - 1].frame_ts },
    windowSec,
    byThreshold,
  };
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  for (const th of thresholds) {
    const r = byThreshold[th];
    const sum = (l) => l.reduce((a, b) => a + b.count, 0);
    console.log(`[t3-flow-report] th=${th}: rising=${sum(r.rising)} falling=${sum(r.falling)}`);
  }
  console.log(`[t3-flow-report] -> ${REPORT_PATH}`);
}

main();
```

- [ ] **Step 2: データ不足時の動作確認（手動実行）**

Run: `node scripts/t3-front-flow-report.mjs`
Expected: `[t3-flow-report] history なし。tick 稼働後に実行する`、exit 0

- [ ] **Step 3: 既存テストの回帰がないことを確認**

Run: `npm test 2>&1 | tail -5`
Expected: 全 pass

- [ ] **Step 4: コミット**

```bash
git add scripts/t3-front-flow-report.mjs
git commit -m "feat(t3-flow): 両極性オフラインレポート (Phase 2 感度分析用)"
```

---

### Task 7: 校正支援 — gate ROI 注釈画像

**Files:**
- Create: `scripts/annotate-t3-gate.mjs`

- [ ] **Step 1: 注釈スクリプトを作成**

`scripts/annotate-t3-gate.mjs`:

```javascript
#!/usr/bin/env node
// annotate-t3-gate — Real108 の実画像に gate ROI の枠を描いた注釈画像を出力する校正支援。
// 使い方:
//   node scripts/annotate-t3-gate.mjs                 # ttc から現在画像を取得して注釈
//   node scripts/annotate-t3-gate.mjs path/to/img.jpg # 既存サンプル(snapshot-t3-cameras.mjs 出力)に注釈
// 出力: data/calibration/t3/gate-annotated.jpg
// 枠が「出口直前の細い帯」に重なるまで data/t3-front-flow-rois.json の gate を編集→再実行。

import { Jimp } from 'jimp';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseT3FrontFlowRois, gateToBox } from './lib/t3-front-flow.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROIS_PATH = join(ROOT, 'data/t3-front-flow-rois.json');
const OUT_PATH = join(ROOT, 'data/calibration/t3/gate-annotated.jpg');
const RED = { r: 255, g: 40, b: 40 };
const THICK = 3;

function drawRect(img, box) {
  const { width: w, height: h, data } = img.bitmap;
  const px0 = Math.round(box.x0 * (w - 1));
  const px1 = Math.round(box.x1 * (w - 1));
  const py0 = Math.round(box.y0 * (h - 1));
  const py1 = Math.round(box.y1 * (h - 1));
  const put = (x, y) => {
    if (x < 0 || x >= w || y < 0 || y >= h) return;
    const i = (y * w + x) * 4;
    data[i] = RED.r; data[i + 1] = RED.g; data[i + 2] = RED.b;
  };
  for (let t = 0; t < THICK; t++) {
    for (let x = px0; x <= px1; x++) { put(x, py0 + t); put(x, py1 - t); }
    for (let y = py0; y <= py1; y++) { put(px0 + t, y); put(px1 - t, y); }
  }
}

async function main() {
  const cfg = parseT3FrontFlowRois(JSON.parse(readFileSync(ROIS_PATH, 'utf8')));
  const src = process.argv[2];
  let img;
  if (src) {
    img = await Jimp.read(src);
  } else {
    const res = await fetch(`https://ttc.taxi-inf.jp/${cfg.camera}.jpg`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    img = await Jimp.read(Buffer.from(await res.arrayBuffer()));
  }
  if (!cfg.calibrated) {
    console.log('[annotate-t3-gate] gate が未校正 (width/height=0)。仮の値を入れてから再実行');
  } else {
    drawRect(img, gateToBox(cfg.gate));
  }
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, await img.getBuffer('image/jpeg'));
  console.log(`[annotate-t3-gate] -> ${OUT_PATH} (gate=${JSON.stringify(cfg.gate)})`);
}

main().catch((e) => { console.error(`[annotate-t3-gate] ${e.message}`); process.exit(1); });
```

- [ ] **Step 2: 動作確認（未校正メッセージ）**

Run: `node scripts/annotate-t3-gate.mjs`
Expected: `[annotate-t3-gate] gate が未校正...` と出つつ、元画像がそのまま `data/calibration/t3/gate-annotated.jpg` に保存される

- [ ] **Step 3: コミット**

```bash
git add scripts/annotate-t3-gate.mjs
git commit -m "feat(t3-flow): gate ROI 校正用の注釈画像スクリプト"
```

---

### Task 8: 配線 — observe-tick-local.sh と .gitattributes

**Files:**
- Modify: `scripts/observe-tick-local.sh`（行100付近の `git add` リスト）
- Modify: `.gitattributes`

- [ ] **Step 1: .gitattributes に merge=union を追加**

`.gitattributes` 末尾に追加:

```
data/t3-front-flow-history.jsonl merge=union
```

- [ ] **Step 2: observe-tick-local.sh の git add に追加**

行100付近の `git add data/taxi-pool-history.jsonl ...` の列挙に `data/t3-front-flow-history.jsonl` を追加する。変更前後（既存行は1行が長いので、`data/advance-forecast.json` の直後に挿入する形）:

変更前（該当部分のみ）:
```
... data/movement-shift-history.jsonl data/advance-forecast.json 2>/dev/null || true
```

変更後:
```
... data/movement-shift-history.jsonl data/advance-forecast.json data/t3-front-flow-history.jsonl 2>/dev/null || true
```

※ `data/t3-front-flow-state.json` と `data/t3-front-flow-report.json` は再生成系のため git add しない（state はローカル専用、report は手動実行の検証用）。

- [ ] **Step 3: シェル構文チェック**

Run: `bash -n scripts/observe-tick-local.sh && echo OK`
Expected: `OK`

- [ ] **Step 4: コミット**

```bash
git add .gitattributes scripts/observe-tick-local.sh
git commit -m "chore(t3-flow): t3-front-flow-history.jsonl の git 配線 (merge=union + observe loop で commit)"
```

---

### Task 9: launchd ジョブ

**Files:**
- Create: `scripts/install-t3-front-flow-launchd.sh`

- [ ] **Step 1: インストールスクリプトを作成**

`scripts/install-t3-front-flow-launchd.sh`（`install-movement-shift-launchd.sh` と同構造）:

```bash
#!/bin/bash
# launchd ジョブ jp.taxi-ic-helper.t3-front-flow を install / uninstall する。
# 60 秒間隔 (StartInterval 60) で node scripts/t3-front-flow-tick.mjs を呼ぶ。
# Real108 の実更新は約1〜2分のため、tick 側が Last-Modified/md5 で同一フレームを skip する。
# data/t3-front-flow-history.jsonl への追記専用で git は触らない
# (commit/push は5分の observe ループが担う = movement-shift と同じ構造)。
#
# 使い方:
#   ./scripts/install-t3-front-flow-launchd.sh install
#   ./scripts/install-t3-front-flow-launchd.sh uninstall
#   ./scripts/install-t3-front-flow-launchd.sh status

set -e

LABEL="jp.taxi-ic-helper.t3-front-flow"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$LABEL.plist"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$REPO/.local"
NODE="$(command -v node || echo /opt/homebrew/bin/node)"
TICK_SCRIPT="$REPO/scripts/t3-front-flow-tick.mjs"

case "${1:-help}" in
  install)
    mkdir -p "$PLIST_DIR" "$LOG_DIR"
    cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$TICK_SCRIPT</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$REPO</string>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/t3-front-flow-stdout.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/t3-front-flow-stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
EOF
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    launchctl load "$PLIST_PATH"
    echo "[install] loaded: $LABEL (every 60s)"
    ;;
  uninstall)
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    rm -f "$PLIST_PATH"
    echo "[uninstall] removed: $LABEL"
    ;;
  status)
    launchctl list | grep "$LABEL" || echo "not loaded"
    ;;
  *)
    echo "usage: $0 {install|uninstall|status}"
    exit 1
    ;;
esac
```

- [ ] **Step 2: 実行権限と構文チェック**

Run: `chmod +x scripts/install-t3-front-flow-launchd.sh && bash -n scripts/install-t3-front-flow-launchd.sh && echo OK`
Expected: `OK`

- [ ] **Step 3: インストールして状態確認**

Run: `./scripts/install-t3-front-flow-launchd.sh install && ./scripts/install-t3-front-flow-launchd.sh status`
Expected: `[install] loaded: jp.taxi-ic-helper.t3-front-flow (every 60s)` と、status に行が出る

※ ROI 未校正のため、ロード直後から各 tick は「未校正 skip」で空回りする（無害・正常）。

- [ ] **Step 4: コミット**

```bash
git add scripts/install-t3-front-flow-launchd.sh
git commit -m "chore(t3-flow): launchd ジョブ jp.taxi-ic-helper.t3-front-flow (60s)"
```

---

### Task 10: 校正 — gate ROI の実値確定（ユーザー目視を含む）

**Files:**
- Modify: `data/t3-front-flow-rois.json`（gate に実座標を記入）

- [ ] **Step 1: サンプル画像を取得**

Run: `node scripts/snapshot-t3-cameras.mjs`
Expected: `data/calibration/t3/<ts>/Real108.jpg` 等が保存される

- [ ] **Step 2: Real108 を見て gate の初期値を決め、注釈画像を出す**

Real108 の実画像を開き、「出口直前の細い帯」（前方プールの乗り場側の端、車列が出ていく境界）を覆う細い矩形を目分量で決めて `data/t3-front-flow-rois.json` の gate に記入。例（実画像に合わせて調整）:

```json
"gate": { "x": 0.30, "y": 0.50, "width": 0.45, "height": 0.12 }
```

Run: `node scripts/annotate-t3-gate.mjs data/calibration/t3/<ts>/Real108.jpg && open data/calibration/t3/gate-annotated.jpg`
Expected: 赤枠つき画像が開く

- [ ] **Step 3: ユーザー目視確認（ブロッキング）**

ユーザーに注釈画像を見せ、「赤枠が出口直前の帯に重なっているか」を確認してもらう。ズレていれば gate を編集して Step 2 を繰り返す。**ユーザー OK が出るまで次に進まない。**

- [ ] **Step 4: 実フレームで密度が出ることを確認**

Run: `node scripts/t3-front-flow-tick.mjs`
Expected: `[t3-front-flow] <frame_ts> density=NN.NN night=...` が出て、`data/t3-front-flow-history.jsonl` に1行追記される

- [ ] **Step 5: dedup が効くことを確認**

Run: `node scripts/t3-front-flow-tick.mjs`（直後にもう一度）
Expected: `[t3-front-flow] 同一フレーム skip (...)`（history の行数が増えない）

- [ ] **Step 6: コミット**

```bash
git add data/t3-front-flow-rois.json
git commit -m "feat(t3-flow): gate ROI 校正値 (Real108 出口直前の帯)"
```

---

### Task 11: 統合確認と完了

- [ ] **Step 1: 全テスト回帰確認**

Run: `npm test 2>&1 | tail -5`
Expected: 全 pass（fail 0）

- [ ] **Step 2: launchd 経由の自動追記を確認**

2〜3分待ってから:

Run: `tail -3 data/t3-front-flow-history.jsonl && wc -l < data/t3-front-flow-history.jsonl`
Expected: `frame_ts` が約1〜2分刻みの行が増えている（60秒ぴったりではなく、フレーム実更新に従う）

- [ ] **Step 3: frame_ts のユニーク性確認（成功基準3）**

Run: `node -e "const l=require('fs').readFileSync('data/t3-front-flow-history.jsonl','utf8').trim().split('\n').map(JSON.parse); const ts=l.map(r=>r.frame_ts); console.log('rows:',ts.length,'unique:',new Set(ts).size)"`
Expected: `rows: N unique: N`（重複なし）

- [ ] **Step 4: push**

```bash
git push
```

- [ ] **Step 5: 24時間後の確認（別セッション・Phase 2 入口）**

24h 稼働後に `node scripts/t3-front-flow-report.mjs` を実行し、rising/falling の感度分析を開始する（Phase 2 spec へ）。

---

## セルフレビュー記録

- **Spec coverage:** gate ROI 定義(Task 5/10)・60秒 tick + dedup + frame_ts(Task 5)・両極性レポート(Task 4/6)・launchd(Task 9)・git 配線(Task 8)・校正(Task 7/10)・成功基準1〜5(Task 10/11) — 全節カバー。
- **Placeholder scan:** なし（rois.json の 0.0 は spec で定義された「未校正センチネル」で、tick が明示的に skip する仕様）。
- **Type consistency:** `parseT3FrontFlowRois` の戻り値（camera/gate/params/calibrated）を Task 5/7 で同名使用。`isSameFrame(prevState, {lastModified, hash})` / state ファイルのキー（last_modified/frame_hash）を Task 2/5 で一致確認済み。`summarizeBothPolarities` の opts は Task 4 定義と Task 6 呼び出しで一致。
