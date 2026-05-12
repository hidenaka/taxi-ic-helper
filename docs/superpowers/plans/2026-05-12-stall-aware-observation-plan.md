# 乗り場別観測 (schema v3) 実装プラン

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Real01 の右端列 + Real02 右上を 4 つの乗り場別 ROI として解析し、`schema_version: 3` で `stalls` フィールドに乗り場別 `occupied_estimate` / `diff_occupied_from_prev` を記録できる観測パイプラインに拡張する。取得頻度を 15 分 → 5 分に変更。

**Architecture:** `analyzePoolImage` の既存ロジックを使い回しながら、新規 `analyzeStalls` 純粋関数で 4 乗り場別解析を追加。observe-taxi-pool.mjs は新関数を呼んで `stalls` フィールドを含む schema_version: 3 で jsonl 追記。launchd の StartInterval を 300 秒に変更。旧 v1/v2 行は schema_version で識別。

**Tech Stack:** ES Modules / `node:test` + `node:assert/strict` / `jimp@1.x` / launchd (Mac mini)

**設計ドキュメント:** `docs/superpowers/specs/2026-05-12-stall-aware-observation-design.md`

---

## File Structure

| ファイル | 種別 | 役割 |
|---|---|---|
| `scripts/lib/stall-rois.json` | Create | 4 乗り場別 ROI 座標 |
| `scripts/lib/image-pool-analyzer.mjs` | Modify | `analyzeStalls(jimpImagesByName, stallRois, prevStalls)` を追加 |
| `scripts/observe-taxi-pool.mjs` | Modify | `analyzeStalls` を呼び、`schema_version: 3` で `stalls` を含む jsonl 追記 |
| `scripts/install-observe-launchd.sh` | Modify | `StartInterval: 900` → `300` |
| `tests/image-pool-analyzer.test.mjs` | Modify | `analyzeStalls` のテスト 4 件追加 |
| `docs/research/taxi-pool-observation.md` | Modify | スキーマ履歴 v3 + Phase B 仮説 H6-H8 を追記 |
| `scripts/calibrate-stall-rois.mjs` | Create | 実画像から各 stall ROI を crop して /tmp に出すキャリブレーション用スクリプト |

実装順序: **stall-rois.json → analyzeStalls (TDD) → orchestrator 配線 → ROI キャリブレーション → launchd 周期変更 → docs → Mac mini 反映**

---

## Task 1: `stall-rois.json` を作成

**Files:**
- Create: `scripts/lib/stall-rois.json`

- [ ] **Step 1.1: ROI 座標を含む JSON を作成**

`scripts/lib/stall-rois.json`:

```json
{
  "_meta": {
    "source": "ttc.taxi-inf.jp の Real01_line.jpg / Real02.jpg を 2026-05-12 時点で手動切り出し。ユーザー指示: 画像最右端の縦列が観測対象、Real01 で上から 8/7/8 台分が第1/2/3乗り場、Real02 右上 8 台が第4乗り場",
    "image_size": [800, 600],
    "calibration_note": "1 台あたり画像内縦約 21px (Real01 内、駐車場領域 500px / 23 台)。カメラ斜め撮影なので奥は小さく、手前は大きく見える可能性あり、実装時に微調整"
  },
  "stalls": {
    "stall1": {
      "source": "real01_line",
      "capacity": 8,
      "label": "第1乗り場 (JAL 2番ポール T1)",
      "roi": { "x": 600, "y": 80, "width": 200, "height": 170 }
    },
    "stall2": {
      "source": "real01_line",
      "capacity": 7,
      "label": "第2乗り場 (JAL 18番ポール T1)",
      "roi": { "x": 600, "y": 250, "width": 200, "height": 150 }
    },
    "stall3": {
      "source": "real01_line",
      "capacity": 8,
      "label": "第3乗り場 (ANA 3番ポール T2)",
      "roi": { "x": 600, "y": 400, "width": 200, "height": 180 }
    },
    "stall4": {
      "source": "real02",
      "capacity": 8,
      "label": "第4乗り場 (ANA 19番ポール T2)",
      "roi": { "x": 400, "y": 0, "width": 400, "height": 250 }
    }
  }
}
```

- [ ] **Step 1.2: JSON valid 確認**

```bash
cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係"
python3 -c "import json; d = json.load(open('scripts/lib/stall-rois.json')); print('stalls:', list(d['stalls'].keys())); print('capacities:', [d['stalls'][k]['capacity'] for k in d['stalls']])"
```

期待: `stalls: ['stall1', 'stall2', 'stall3', 'stall4']` / `capacities: [8, 7, 8, 8]`

- [ ] **Step 1.3: コミット**

```bash
git add scripts/lib/stall-rois.json
git commit -m "feat(observe): add stall ROI config for 4 taxi stands"
```

---

## Task 2: `analyzeStalls` を TDD で追加

**Files:**
- Modify: `scripts/lib/image-pool-analyzer.mjs`
- Modify: `tests/image-pool-analyzer.test.mjs`

- [ ] **Step 2.1: 失敗するテストを追加**

`tests/image-pool-analyzer.test.mjs` の末尾に以下を追加:

```javascript
// --- analyzeStalls (schema v3) ---
import { analyzeStalls } from '../scripts/lib/image-pool-analyzer.mjs';

const STALL_ROIS_FOR_TEST = {
  stalls: {
    stall1: {
      source: 'real01_line',
      capacity: 8,
      label: 'Test stall 1',
      roi: { x: 0, y: 0, width: 10, height: 10 }
    }
  }
};

test('analyzeStalls: 全黒画像 → occupied_estimate が capacity に近い', async () => {
  const buf = await blackBuffer();
  const img = await Jimp.read(buf);
  const r = await analyzeStalls({ real01_line: img }, STALL_ROIS_FOR_TEST, null);
  assert.equal(r.stall1.capacity, 8);
  assert.equal(r.stall1.occupied_estimate, 8, `occupied=${r.stall1.occupied_estimate}`);
  assert.ok(r.stall1.black_ratio > 0.95);
  assert.equal(r.stall1.diff_occupied_from_prev, null);
  assert.equal(r.stall1.source, 'real01_line');
  assert.equal(r.stall1.label, 'Test stall 1');
});

test('analyzeStalls: 全白画像 → occupied_estimate = 0', async () => {
  const buf = await whiteBuffer();
  const img = await Jimp.read(buf);
  const r = await analyzeStalls({ real01_line: img }, STALL_ROIS_FOR_TEST, null);
  assert.equal(r.stall1.occupied_estimate, 0);
  assert.ok(r.stall1.black_ratio < 0.05);
});

test('analyzeStalls: prev に同じ stalls を渡す → diff_occupied_from_prev = 0', async () => {
  const buf = await blackBuffer();
  const img = await Jimp.read(buf);
  const prev = await analyzeStalls({ real01_line: img }, STALL_ROIS_FOR_TEST, null);
  const curr = await analyzeStalls({ real01_line: img }, STALL_ROIS_FOR_TEST, prev);
  assert.equal(curr.stall1.diff_occupied_from_prev, 0);
});

test('analyzeStalls: 画像なし stall は null を返す', async () => {
  // stall4 が real02 を要求するが、real02 を渡さない場合
  const rois = {
    stalls: {
      stall4: {
        source: 'real02',
        capacity: 8,
        label: 'Test stall 4',
        roi: { x: 0, y: 0, width: 10, height: 10 }
      }
    }
  };
  const buf = await blackBuffer();
  const img = await Jimp.read(buf);
  const r = await analyzeStalls({ real01_line: img }, rois, null);
  assert.equal(r.stall4, null);
});
```

- [ ] **Step 2.2: テスト実行 → 失敗確認**

```bash
cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係"
node --test tests/image-pool-analyzer.test.mjs 2>&1 | tail -10
```

期待: 新 4 件が import エラーで失敗。

- [ ] **Step 2.3: `analyzeStalls` を `image-pool-analyzer.mjs` に追加**

`scripts/lib/image-pool-analyzer.mjs` の末尾 (export 後) に以下を追加:

```javascript
const NORMALIZATION = 0.4; // ROI 満杯時の経験則 black_ratio

/**
 * 各乗り場の帯状 ROI を解析して状態を返す純粋関数。
 *
 * @param {{real01_line?: import('jimp').Jimp, real02?: import('jimp').Jimp}} jimpImagesByName
 * @param {{stalls: Object}} stallRois - stall-rois.json の中身
 * @param {Object|null} prevStalls - 前 tick の stalls オブジェクト (v3 以前の tick なら null)
 * @returns {Object} { stall1, stall2, stall3, stall4 } の各値は { source, capacity, label, occupied_estimate, black_ratio, edge_density, luminance_mean, diff_occupied_from_prev } または null
 */
export async function analyzeStalls(jimpImagesByName, stallRois, prevStalls = null) {
  const result = {};
  for (const [stallName, def] of Object.entries(stallRois.stalls)) {
    const img = jimpImagesByName[def.source];
    if (!img) {
      result[stallName] = null;
      continue;
    }
    try {
      const roiData = await analyzeROI(img, def.roi);
      const raw = roiData.black_ratio / NORMALIZATION * def.capacity;
      const occupied_estimate = Math.max(0, Math.min(def.capacity, Math.round(raw)));
      const prevOcc = prevStalls?.[stallName]?.occupied_estimate;
      const diff_occupied_from_prev = (typeof prevOcc === 'number')
        ? occupied_estimate - prevOcc
        : null;
      result[stallName] = {
        source: def.source,
        capacity: def.capacity,
        label: def.label,
        occupied_estimate,
        black_ratio: roiData.roi_black_ratio,
        edge_density: roiData.edge_density,
        luminance_mean: roiData.luminance_mean,
        diff_occupied_from_prev
      };
    } catch (e) {
      console.error(`[analyzeStalls] ${stallName} 解析失敗: ${e.message}`);
      result[stallName] = null;
    }
  }
  return result;
}
```

注意: `analyzeROI` は既存ファイル内に既にある (Task 2 v2 で実装済み)。新規追加は `analyzeStalls` と `NORMALIZATION` 定数のみ。`analyzeROI` の戻り値フィールド名は `roi_black_ratio` / `edge_density` / `luminance_mean` / `luminance_std`。これを `analyzeStalls` で `black_ratio` として再エクスポートする (stall コンテキストではフィールド名がより素直)。

- [ ] **Step 2.4: テスト再実行 → パス確認**

```bash
node --test tests/image-pool-analyzer.test.mjs 2>&1 | tail -5
```

期待: 新 4 件すべてパス。

- [ ] **Step 2.5: 全テストスイート実行 (回帰確認)**

```bash
npm test 2>&1 | tail -5
```

期待: 全件パス (306 + 4 = 310 件)。

- [ ] **Step 2.6: コミット**

```bash
git add scripts/lib/image-pool-analyzer.mjs tests/image-pool-analyzer.test.mjs
git commit -m "feat(observe): add analyzeStalls for per-stall occupancy estimation"
```

---

## Task 3: `observe-taxi-pool.mjs` で `stalls` フィールドを追加

**Files:**
- Modify: `scripts/observe-taxi-pool.mjs`

- [ ] **Step 3.1: orchestrator を schema v3 に拡張**

`scripts/observe-taxi-pool.mjs` を編集。

**変更点 1**: import 文に `analyzeStalls` と `Jimp` を追加:

```javascript
import { Jimp } from 'jimp';
import { analyzePoolImage, analyzeStalls } from './lib/image-pool-analyzer.mjs';
import { summarizeArrivalsWindow } from './lib/arrivals-window-summary.mjs';
```

**変更点 2**: 定数を追加・変更:

```javascript
const STALL_ROIS_PATH = './scripts/lib/stall-rois.json';
const SCHEMA_VERSION = 3;
```

**変更点 3**: `readStallRois()` ヘルパーを追加 (`readRoiConfig()` の直後あたり):

```javascript
function readStallRois() {
  try {
    return JSON.parse(readFileSync(STALL_ROIS_PATH, 'utf8'));
  } catch (e) {
    console.error(`[observe] stall-rois.json read failed: ${e.message}`);
    return null;
  }
}
```

**変更点 4**: `main()` 内で `analyzeStalls` を呼ぶ部分を追加。既存の `analyzePoolImage` 呼び出しの後、`arrivalsState` 取得の前あたりに以下を挿入:

```javascript
  // Stall 別解析 (schema v3)
  const stallRois = readStallRois();
  let stalls = null;
  if (stallRois) {
    try {
      const jimpImg1 = await Jimp.read(buf1);
      const jimpImg2 = await Jimp.read(buf2);
      stalls = await analyzeStalls(
        { real01_line: jimpImg1, real02: jimpImg2 },
        stallRois,
        lastTick?.stalls ?? null
      );
    } catch (e) {
      console.error(`[observe] analyzeStalls failed: ${e.message}`);
      stalls = null;
    }
  }
```

**変更点 5**: `row` オブジェクトに `stalls` を追加し、`img2` に `analysis_disabled: true` を付ける:

```javascript
  const row = {
    schema_version: SCHEMA_VERSION,
    ts,
    tick_seq: tickSeq,
    img1: { name: 'Real01_line', ...img1 },
    img2: { name: 'Real02', ...img2, analysis_disabled: true },
    stalls,
    arrivals_state: arrivalsState,
    arrivals_window: arrivalsWindow,
    weather
  };
```

**変更点 6**: console.log に stall の出力を追加:

```javascript
  if (stalls) {
    for (const [name, s] of Object.entries(stalls)) {
      if (s) {
        console.log(`[observe] ${name}: occ=${s.occupied_estimate}/${s.capacity} diff=${s.diff_occupied_from_prev}`);
      }
    }
  }
```

- [ ] **Step 3.2: 構文チェック**

```bash
node --check scripts/observe-taxi-pool.mjs
```

期待: 何も出力されない。

- [ ] **Step 3.3: ローカル run-once 実行**

```bash
node scripts/observe-taxi-pool.mjs 2>&1 | tail -15
```

期待出力:
```
[observe] appended tick_seq=N ts=2026-05-12T... (schema_version=3)
[observe] img1 edge=0.X ...
[observe] img2 edge=0.X ...
[observe] stall1: occ=X/8 diff=N
[observe] stall2: occ=X/7 diff=N
[observe] stall3: occ=X/8 diff=N
[observe] stall4: occ=X/8 diff=N
```

- [ ] **Step 3.4: jsonl 最終行を目視確認**

```bash
tail -1 data/taxi-pool-history.jsonl | python3 -m json.tool | head -50
```

期待: `schema_version: 3` / `stalls.stall1.occupied_estimate` / `img2.analysis_disabled: true` が揃った 1 行。

- [ ] **Step 3.5: 全テスト実行**

```bash
npm test 2>&1 | tail -5
```

期待: 全件パス。

- [ ] **Step 3.6: コミット**

```bash
git add scripts/observe-taxi-pool.mjs
git commit -m "feat(observe): emit schema v3 with stalls field for per-stand tracking"
```

---

## Task 4: ROI キャリブレーションスクリプト + 目視確認

**Files:**
- Create: `scripts/calibrate-stall-rois.mjs`

- [ ] **Step 4.1: キャリブレーション用スクリプト作成**

`scripts/calibrate-stall-rois.mjs`:

```javascript
#!/usr/bin/env node
/**
 * stall-rois.json の各 ROI を実画像から crop して /tmp に保存する。
 * 生成された /tmp/stall-stall1.jpg〜stall4.jpg を目視で確認し、
 * 適切な領域が切り出せていなければ stall-rois.json を調整する。
 *
 * 使い方:
 *   node scripts/calibrate-stall-rois.mjs
 *   open /tmp/stall-stall1.jpg /tmp/stall-stall2.jpg /tmp/stall-stall3.jpg /tmp/stall-stall4.jpg
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Jimp } from 'jimp';

const REAL01_URL = 'https://ttc.taxi-inf.jp/Real01_line.jpg';
const REAL02_URL = 'https://ttc.taxi-inf.jp/Real02.jpg';

async function fetchImage(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const rois = JSON.parse(readFileSync('./scripts/lib/stall-rois.json', 'utf8'));
  console.log('Fetching latest images from ttc.taxi-inf.jp ...');
  const [buf1, buf2] = await Promise.all([fetchImage(REAL01_URL), fetchImage(REAL02_URL)]);
  writeFileSync('/tmp/ttc-real01-source.jpg', buf1);
  writeFileSync('/tmp/ttc-real02-source.jpg', buf2);
  const img1 = await Jimp.read(buf1);
  const img2 = await Jimp.read(buf2);
  const images = { real01_line: img1, real02: img2 };
  for (const [name, def] of Object.entries(rois.stalls)) {
    const src = images[def.source];
    if (!src) {
      console.error(`${name}: source ${def.source} not available`);
      continue;
    }
    const { width, height } = src.bitmap;
    const x = Math.max(0, Math.min(width, def.roi.x));
    const y = Math.max(0, Math.min(height, def.roi.y));
    const w = Math.max(0, Math.min(width - x, def.roi.width));
    const h = Math.max(0, Math.min(height - y, def.roi.height));
    const out = src.clone().crop({ x, y, w, h });
    const outPath = `/tmp/stall-${name}.jpg`;
    await out.write(outPath);
    console.log(`${name}: ${def.label} → ${outPath} (${w}x${h})`);
  }
  console.log('\n目視確認:');
  console.log('  open /tmp/stall-stall1.jpg /tmp/stall-stall2.jpg /tmp/stall-stall3.jpg /tmp/stall-stall4.jpg');
  console.log('  ソース画像:');
  console.log('  open /tmp/ttc-real01-source.jpg /tmp/ttc-real02-source.jpg');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 4.2: 構文チェック**

```bash
node --check scripts/calibrate-stall-rois.mjs
```

期待: 何も出力されない。

- [ ] **Step 4.3: 実行して /tmp に画像を出す**

```bash
cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係"
node scripts/calibrate-stall-rois.mjs
```

期待出力:
```
Fetching latest images from ttc.taxi-inf.jp ...
stall1: 第1乗り場 (JAL 2番ポール T1) → /tmp/stall-stall1.jpg (200x170)
stall2: 第2乗り場 (JAL 18番ポール T1) → /tmp/stall-stall2.jpg (200x150)
stall3: 第3乗り場 (ANA 3番ポール T2) → /tmp/stall-stall3.jpg (200x180)
stall4: 第4乗り場 (ANA 19番ポール T2) → /tmp/stall-stall4.jpg (400x250)
```

- [ ] **Step 4.4: 各 ROI 画像を Read tool で確認**

(controller: 4 つの jpg を Read tool で順に読んで内容を確認、画像内に「想定通りの台数のタクシー」が映っているかをユーザーに報告)

stall1.jpg: 第1乗り場の 8 台分の縦列が見える?
stall2.jpg: 第2乗り場の 7 台分か?
stall3.jpg: 第3乗り場の 8 台分か?
stall4.jpg: 第4乗り場の 8 台分か? (Real02 右上)

ズレていれば次の Step 4.5 で `stall-rois.json` を調整。

- [ ] **Step 4.5 (条件付き): stall-rois.json を調整**

目視確認で「stall1 の上端が高速道路の高架にかかっている」「stall2 が stall3 に食い込んでいる」など問題があれば、`stall-rois.json` の `x` / `y` / `width` / `height` を編集し、Step 4.3 を再実行。問題ない位置になるまで繰り返す。

正しく切り出せていれば次のステップへ。

- [ ] **Step 4.6: コミット (調整があれば)**

```bash
# 調整なしならスクリプト追加だけ commit
git add scripts/calibrate-stall-rois.mjs
git commit -m "feat(observe): add stall ROI calibration helper script"

# 調整があれば stall-rois.json も含める
git add scripts/calibrate-stall-rois.mjs scripts/lib/stall-rois.json
git commit -m "feat(observe): add stall ROI calibration helper and adjust coordinates"
```

---

## Task 5: launchd の StartInterval を 5 分に変更

**Files:**
- Modify: `scripts/install-observe-launchd.sh`

- [ ] **Step 5.1: install スクリプトを編集**

`scripts/install-observe-launchd.sh` の中で plist を生成している箇所を探す。`StartInterval` を含む XML を `900` (秒) から `300` (秒) に変更。

該当箇所:
```xml
  <key>StartInterval</key>
  <integer>900</integer>
```

を以下に変更:
```xml
  <key>StartInterval</key>
  <integer>300</integer>
```

- [ ] **Step 5.2: 構文確認 (bash の文法のみ)**

```bash
bash -n scripts/install-observe-launchd.sh
```

期待: 何も出力されない。

- [ ] **Step 5.3: コミット**

```bash
git add scripts/install-observe-launchd.sh
git commit -m "feat(observe): change launchd StartInterval to 300s (5 min)"
```

(注: 実際に Mac mini の launchd ジョブを更新するのは Task 7 で行う)

---

## Task 6: `docs/research/taxi-pool-observation.md` を更新

**Files:**
- Modify: `docs/research/taxi-pool-observation.md`

- [ ] **Step 6.1: スキーマ履歴セクションに v3 を追加**

`docs/research/taxi-pool-observation.md` の冒頭の「スキーマ履歴」セクションを以下に変更:

旧:
```markdown
## スキーマ履歴

- **v1** (2026-05-10 〜 2026-05-11、118 行): `img.black_ratio` / `img.diff_from_prev` / `arrivals_state.total_estimated_taxi_pax`
- **v2** (2026-05-11 〜): `schema_version: 2` フィールドあり。`img.roi.edge_density` / `img.roi.luminance_mean` / `arrivals_window.estimated_taxi_pax_sum` を追加。v1 フィールドは互換のため保持

詳細は `docs/superpowers/specs/2026-05-11-observation-schema-v2-design.md`。
```

新:
```markdown
## スキーマ履歴

- **v1** (2026-05-10 〜 2026-05-11、121 行): `img.black_ratio` / `img.diff_from_prev` / `arrivals_state.total_estimated_taxi_pax`
- **v2** (2026-05-11 〜 2026-05-12、数十行): `schema_version: 2` フィールドあり。`img.roi.edge_density` / `img.roi.luminance_mean` / `arrivals_window.estimated_taxi_pax_sum` を追加。v1 フィールドは互換のため保持
- **v3** (2026-05-12 〜): `schema_version: 3` フィールドあり。`stalls.stall1` 〜 `stalls.stall4` で 4 乗り場別の `occupied_estimate` / `diff_occupied_from_prev` を追加。`img2.analysis_disabled: true` で Real02 が神奈川車混在で観測対象外であることを明示。取得頻度を 15 分 → 5 分に変更。

詳細は:
- v2: `docs/superpowers/specs/2026-05-11-observation-schema-v2-design.md`
- v3: `docs/superpowers/specs/2026-05-12-stall-aware-observation-design.md`
```

- [ ] **Step 6.2: Phase B 分析手順に H6-H8 仮説と乗り場別 Python スニペットを追加**

ファイル内の `#### H5 (v2 専用): edge_density と window_taxi_pax の相関` セクションの直後に以下を追加:

```markdown
#### H6 (v3 専用): T1 / T2 別の出庫と arrivals_window の整合

stall1+stall2 (T1) の `diff_occupied_from_prev` の負値合計 = T1 出庫数推定。
stall3+stall4 (T2) も同様。

```python
v3 = df[df['schema'] == 3].copy()
v3['stall1_occ'] = v3['stalls'].apply(lambda x: get_nested(x, 'stall1', 'occupied_estimate'))
v3['stall2_occ'] = v3['stalls'].apply(lambda x: get_nested(x, 'stall2', 'occupied_estimate'))
v3['stall3_occ'] = v3['stalls'].apply(lambda x: get_nested(x, 'stall3', 'occupied_estimate'))
v3['stall4_occ'] = v3['stalls'].apply(lambda x: get_nested(x, 'stall4', 'occupied_estimate'))
v3['stall1_diff'] = v3['stalls'].apply(lambda x: get_nested(x, 'stall1', 'diff_occupied_from_prev'))
v3['stall2_diff'] = v3['stalls'].apply(lambda x: get_nested(x, 'stall2', 'diff_occupied_from_prev'))
v3['stall3_diff'] = v3['stalls'].apply(lambda x: get_nested(x, 'stall3', 'diff_occupied_from_prev'))
v3['stall4_diff'] = v3['stalls'].apply(lambda x: get_nested(x, 'stall4', 'diff_occupied_from_prev'))

# 出庫数推定 (負の diff を絶対値で合計)
v3['T1_outflow'] = (-v3[['stall1_diff', 'stall2_diff']].clip(upper=0)).sum(axis=1)
v3['T2_outflow'] = (-v3[['stall3_diff', 'stall4_diff']].clip(upper=0)).sum(axis=1)

# 1 時間バケットで集計
hourly = v3.groupby('hour').agg(
    T1_outflow=('T1_outflow', 'sum'),
    T2_outflow=('T2_outflow', 'sum'),
    window_taxi_pax_mean=('window_taxi_pax', 'mean')
)
print(hourly)
```

#### H7 (v3 専用): 「便ピーク」→「乗り場出庫」のラグ時間

`arrivals_window.estimated_taxi_pax_sum` がピークになる時刻と、stall 出庫の累積がピークになる時刻のラグを測る (5 分間隔なので 5 分粒度で観測)。

```python
# 1 日分の時系列を 5 分粒度でリサンプル
v3['ts'] = pd.to_datetime(v3['ts'])
day = v3[v3['ts'].dt.date == pd.Timestamp('2026-05-13').date()]
day_resampled = day.set_index('ts').resample('5min').first()

# クロス相関でラグを推定
from scipy.signal import correlate
window = day_resampled['window_taxi_pax'].fillna(0).values
outflow = (day_resampled['T1_outflow'] + day_resampled['T2_outflow']).fillna(0).values
xcorr = correlate(outflow, window, mode='full')
lag = xcorr.argmax() - (len(window) - 1)  # 単位: 5 分
print(f"ラグ (5 分単位): {lag}, つまり {lag * 5} 分")
```

#### H8 (v3 専用): 神奈川車混在の影響

Real02 (`img2.analysis_disabled: true`) を分析対象外とした影響を測る。stall4 (Real02 右上 8 台) と stall1-3 (Real01) の挙動が時間帯ごとに大きく違う場合、神奈川車の影響が stall4 にも漏れている可能性がある。

```python
# stall4 と stall3 の occ 相関 (両方 T2 で同じターミナル経由のはず → 高相関を期待)
corr_T2 = v3[['stall3_occ', 'stall4_occ']].corr().iloc[0, 1]
print(f"stall3 vs stall4 (T2 内) 相関: {corr_T2:.3f}")
# 期待: > 0.5 (T2 客が両方の乗り場を使うので連動)
# < 0.2 → stall4 が神奈川車に汚染されている可能性
```
```

- [ ] **Step 6.3: Phase A 検証セクションに v3 用コマンドを追加**

`### schema_version=2 への移行検証 (実装直後 24 時間)` セクションの直後に以下を追加:

```markdown

### schema_version=3 への移行検証 (実装直後 24 時間)

```bash
# 24 時間経過後に
git pull origin main
jq -r '.schema_version' data/taxi-pool-history.jsonl | sort | uniq -c
# 期待: v1=121, v2=数十, v3=200+ (5 分間隔 × 24h = 288 が理想)

# stall ごとの occupied_estimate 分布
jq -r 'select(.schema_version==3) | "\(.ts) s1=\(.stalls.stall1.occupied_estimate) s2=\(.stalls.stall2.occupied_estimate) s3=\(.stalls.stall3.occupied_estimate) s4=\(.stalls.stall4.occupied_estimate)"' data/taxi-pool-history.jsonl | head -30
# 期待: 各 stall で 0-capacity の範囲で時間帯ごとに変動

# 出庫検出 (diff が負の tick)
jq -r 'select(.schema_version==3 and .stalls.stall1.diff_occupied_from_prev < 0) | "\(.ts) stall1: \(.stalls.stall1.diff_occupied_from_prev)"' data/taxi-pool-history.jsonl | head -20
```
```

- [ ] **Step 6.4: コミット**

```bash
git add docs/research/taxi-pool-observation.md
git commit -m "docs(research): update playbook with v3 schema and stall-based hypotheses H6-H8"
```

---

## Task 7: push + Mac mini への反映 + 24h 検証

**Files:** 変更なし (運用作業)

- [ ] **Step 7.1: 全テスト最終確認**

```bash
cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係"
npm test 2>&1 | tail -5
```

期待: 全件パス (310 件以上)。

- [ ] **Step 7.2: origin の最新を取り込んで push**

```bash
git fetch origin
git pull --rebase --autostash origin main 2>&1 | tail -3
git log --oneline origin/main..HEAD
# Task 1〜6 の commit が並ぶ
git push origin main 2>&1 | tail -3
```

- [ ] **Step 7.3: Mac mini 側で git pull (ユーザー手動)**

Mac mini にログインして:

```bash
cd ~/repos/taxi-ic-helper
git pull origin main
npm install   # jimp は既にあるが念のため
```

- [ ] **Step 7.4: Mac mini で launchd を再 install (5 分間隔に変更)**

```bash
./scripts/install-observe-launchd.sh uninstall
./scripts/install-observe-launchd.sh install
./scripts/install-observe-launchd.sh status
```

期待: ジョブが再 load される。`StartInterval: 300` で動く。

- [ ] **Step 7.5: Mac mini で run-once で動作確認**

```bash
./scripts/install-observe-launchd.sh run-once 2>&1 | tail -15
```

期待:
```
[observe] appended tick_seq=N ts=... (schema_version=3)
[observe] img1 edge=0.X ...
[observe] img2 edge=0.X ...
[observe] stall1: occ=X/8 diff=N
[observe] stall2: occ=X/7 diff=N
[observe] stall3: occ=X/8 diff=N
[observe] stall4: occ=X/8 diff=N
[observe-tick] push ok (attempt 1)
```

- [ ] **Step 7.6: MacBook 側で git pull して観測継続を確認**

```bash
# MacBook 側 (1 時間後など適宜)
cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係"
git pull origin main
tail -1 data/taxi-pool-history.jsonl | jq '{schema: .schema_version, tick: .tick_seq, ts, stall1_occ: .stalls.stall1.occupied_estimate, stall1_diff: .stalls.stall1.diff_occupied_from_prev}'
```

期待: schema=3 / stall1_occ=数値 / stall1_diff=null or 数値

- [ ] **Step 7.7: 24 時間経過後の値域検証**

```bash
git pull origin main

# v3 行数
jq -r '.schema_version' data/taxi-pool-history.jsonl | sort | uniq -c

# 各 stall の occ 値域 (時間帯依存があるか)
python3 << 'EOF'
import json
v3 = []
with open('data/taxi-pool-history.jsonl') as f:
    for line in f:
        try:
            d = json.loads(line)
            if d.get('schema_version') == 3 and d.get('stalls'):
                v3.append(d)
        except: pass
print(f"v3 行数: {len(v3)}")
for stall in ['stall1', 'stall2', 'stall3', 'stall4']:
    occs = [r['stalls'][stall]['occupied_estimate'] for r in v3 if r['stalls'].get(stall)]
    if occs:
        print(f"{stall}: min={min(occs)}, max={max(occs)}, mean={sum(occs)/len(occs):.1f}, n={len(occs)}")
EOF
```

期待:
- v3 行数 >= 200 (5 分間隔 × 24h = 288 が理想、Mac mini 稼働率で 200 前後)
- 各 stall で min/max が分離している (例: min=0, max=8) → 時間帯依存で動く
- 全 tick で同じ値ばかりなら NORMALIZATION 値を Phase B で再校正

両方を満たせば Phase B 分析セッションへ進む準備が整う。

---

## 検証コマンド一覧 (チートシート)

```bash
# 全テスト
npm test

# 個別テスト
node --test tests/image-pool-analyzer.test.mjs

# 構文チェック
node --check scripts/lib/image-pool-analyzer.mjs
node --check scripts/observe-taxi-pool.mjs
node --check scripts/calibrate-stall-rois.mjs

# JSON valid
python3 -c "import json; json.load(open('scripts/lib/stall-rois.json'))"

# ROI 切り出し (キャリブレーション)
node scripts/calibrate-stall-rois.mjs
open /tmp/stall-stall1.jpg /tmp/stall-stall2.jpg /tmp/stall-stall3.jpg /tmp/stall-stall4.jpg

# 1 tick 実行
node scripts/observe-taxi-pool.mjs

# 最新 jsonl 1 行を pretty
tail -1 data/taxi-pool-history.jsonl | jq .

# schema_version の分布
jq -r '.schema_version // 1' data/taxi-pool-history.jsonl | sort | uniq -c

# launchd ジョブ状態 (Mac mini で)
./scripts/install-observe-launchd.sh status
```

---

## 完了条件 (再掲)

- [ ] `npm test` 全件パス (現在 306 + 4 = 310 件以上)
- [ ] `scripts/lib/stall-rois.json` が valid JSON
- [ ] `scripts/calibrate-stall-rois.mjs` で生成された stall ROI 画像 (`/tmp/stall-stall1.jpg`〜`/tmp/stall-stall4.jpg`) を目視確認、ズレていなければ OK
- [ ] Mac mini で launchd が `StartInterval: 300` で再 load された
- [ ] Mac mini で run-once が成功し、schema_version=3 の jsonl 行が出る
- [ ] 24 時間後に v3 行が 200 件以上、各 stall の `occupied_estimate` が時間帯依存に変動する
- [ ] `docs/research/taxi-pool-observation.md` が v3 スキーマと H6-H8 仮説を含む

## Phase B への引き継ぎ

Phase A v3 検証が満たされたら、Phase B 分析セッションで `docs/research/taxi-pool-observation.md` の H6-H8 を Python で検証し、係数校正案を Phase C spec として起こす。
