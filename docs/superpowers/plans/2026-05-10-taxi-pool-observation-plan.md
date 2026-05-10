# タクシープール観測パイプライン (Phase A) 実装プラン

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ttc.taxi-inf.jp の羽田空港タクシープール画像を 15 分間隔で取得し、画像メタ + 同時刻の `estimatedTaxiPax` 予測値を `data/taxi-pool-history.jsonl` に蓄積する観測パイプラインを構築する。2 週間の蓄積データを Phase B で分析する。

**Architecture:** 既存の `update-arrivals.yml` / `update-weather.yml` と完全独立した新規 GitHub Actions ワークフローを追加。cron-job.org からの workflow_dispatch トリガで起動し、画像取得 → 解析 (jimp) → jsonl 追記 → Artifact upload → git push のフロー。画像本体は Actions Artifact (90 日) に保存、メタは jsonl で git 管理。

**Tech Stack:** ES Modules / `node:test` / `jimp@1.x` (純 JS 画像解析) / GitHub Actions / cron-job.org (外部 cron)

**設計ドキュメント:** `docs/superpowers/specs/2026-05-10-taxi-pool-observation-design.md`

**重要: 簡素化判断 (spec からの変更)**

`diff_from_prev` を spec では「pixel-wise abs diff の 1 ピクセルあたり平均 (0〜255)」と定義したが、Actions runner は毎回 fresh な環境で「前 tick の画像本体」が取れない。Artifact からの pull は API レート負荷とダウンロード時間が大きい。本プランでは **`diff_from_prev` を「前 tick の同名画像の black_ratio との差の絶対値」(0〜1.0)** に簡素化する。pixel-level 精度は失うが、「変化量シグナル」としての機能は維持される。spec の該当箇所は Task 4 の中で修正コミットを入れる。

---

## File Structure

| ファイル | 種別 | 役割 |
|---|---|---|
| `package.json` | Modify | dependencies に `jimp@^1.0.0` を追加、`package-lock.json` を生成 |
| `.gitignore` | 確認のみ | `node_modules/` が既に入っていること確認 |
| `scripts/lib/image-pool-analyzer.mjs` | Create | 画像 Buffer から `{sha256, size_bytes, black_ratio}` を返す純粋関数 |
| `scripts/observe-taxi-pool.mjs` | Create | 取得・解析・jsonl 追記・前行参照のオーケストレーション |
| `tests/image-pool-analyzer.test.mjs` | Create | analyzer のユニットテスト 5 件 |
| `.github/workflows/observe-taxi-pool.yml` | Create | workflow_dispatch + Artifact upload + 既存 race-safe push |
| `data/taxi-pool-history.jsonl` | Create | 1 行目に「初期化用 placeholder 行」、以降 cron で追記 |
| `docs/research/taxi-pool-observation.md` | Create | Phase B の分析手順メモ |
| `docs/superpowers/specs/2026-05-10-taxi-pool-observation-design.md` | Modify | `diff_from_prev` 定義の簡素化を反映 |

実装順序: **利用規約確認 → dependency → 純粋関数 (TDD) → orchestrator → workflow → docs → 動作確認 → 運用設定**。

---

## Task 0: 利用規約と robots.txt を確認 (倫理ガード)

**Files:** 変更なし (調査のみ、結果を Task 6 のメモに反映)

- [ ] **Step 0.1: robots.txt を確認**

```bash
curl -s -w "\nHTTP %{http_code}\n" "https://ttc.taxi-inf.jp/robots.txt"
```

判断:
- HTTP 200 で `User-agent: *\nDisallow: /` が返る → 取得を控えるべき。Task 1 以降は中止し、運営に問い合わせる
- HTTP 404 (存在しない) または `User-agent: *\nDisallow:` (空) → 全体公開、Task 1 以降進行
- 特定パスだけ Disallow → 対象画像 (`/Real01_line.jpg`, `/Real02.jpg`) が含まれていないか確認

- [ ] **Step 0.2: ttc.taxi-inf.jp トップページの利用規約・問い合わせ先を確認**

```bash
curl -s "https://ttc.taxi-inf.jp" | grep -iE "利用規約|お問い合わせ|terms|contact|copyright|©" | head -10
```

footer に PDF や別ページへのリンクがあれば WebFetch で内容確認。

- [ ] **Step 0.3: 結果を `docs/research/taxi-pool-observation.md` の冒頭にメモ**

(Task 6 で同ファイルを作るので、その時点で「利用規約確認結果」セクションを冒頭に追加。)

判断ルール:
- 明示的にクロール禁止 → Task 1 以降中止、運営にメール (個人プロジェクト、研究目的、15 分間隔、画像 2 枚のみ、結果オープンソース公開、と明記)
- 規約に明文なし → 15 分間隔・User-Agent 明記で開始、運営から指摘あれば即停止
- robots.txt や規約で頻度指示あり → それに従う

このタスクには commit はない (調査結果のみ)。次のタスクへ進む可否を判断する。

---

## Task 1: `jimp` を dependency に追加し package-lock.json を生成

**Files:**
- Modify: `package.json`
- Create: `package-lock.json`

- [ ] **Step 1.1: jimp を dependencies に追加**

`package.json` を以下に置き換える:

```json
{
  "name": "taxi-ic-helper",
  "version": "0.1.0",
  "description": "Taxi driver's IC helper: company-pay / deduction-distance judge",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test",
    "serve": "python3 -m http.server 8000"
  },
  "dependencies": {
    "jimp": "^1.6.0"
  },
  "license": "UNLICENSED"
}
```

- [ ] **Step 1.2: npm install を実行**

```bash
cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係"
npm install
```

期待: `node_modules/` 配下に `jimp` がインストールされ、`package-lock.json` が生成される。

- [ ] **Step 1.3: 全テスト実行 (回帰確認)**

```bash
npm test 2>&1 | tail -5
```

期待: 全件パス (現在 289 件)。

- [ ] **Step 1.4: コミット**

```bash
git add package.json package-lock.json
git commit -m "chore: add jimp@^1.6.0 for image analysis"
```

`node_modules/` は `.gitignore` に既に含まれているはずなのでコミットされない。確認:

```bash
git status --porcelain | grep node_modules || echo "OK: node_modules excluded"
```

---

## Task 2: `image-pool-analyzer.mjs` を TDD で実装

**Files:**
- Create: `tests/image-pool-analyzer.test.mjs`
- Create: `scripts/lib/image-pool-analyzer.mjs`

- [ ] **Step 2.1: 失敗するテストを作成**

`tests/image-pool-analyzer.test.mjs`:

```javascript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { Jimp } from 'jimp';
import { analyzePoolImage } from '../scripts/lib/image-pool-analyzer.mjs';

// 全黒の 10x10 画像を作って Buffer 化
async function blackBuffer() {
  const img = new Jimp({ width: 10, height: 10, color: 0x000000ff });
  return await img.getBuffer('image/jpeg');
}

// 全白の 10x10 画像
async function whiteBuffer() {
  const img = new Jimp({ width: 10, height: 10, color: 0xffffffff });
  return await img.getBuffer('image/jpeg');
}

test('analyzePoolImage: 全黒画像で black_ratio が 1.0 に近い', async () => {
  const buf = await blackBuffer();
  const r = await analyzePoolImage(buf, null);
  assert.ok(r.black_ratio > 0.95, `black_ratio=${r.black_ratio}`);
  assert.equal(typeof r.sha256, 'string');
  assert.equal(r.sha256.length, 64);
  assert.equal(typeof r.size_bytes, 'number');
  assert.equal(r.diff_from_prev, null, 'prev=null なら diff_from_prev も null');
});

test('analyzePoolImage: 全白画像で black_ratio が 0 に近い', async () => {
  const buf = await whiteBuffer();
  const r = await analyzePoolImage(buf, null);
  assert.ok(r.black_ratio < 0.05, `black_ratio=${r.black_ratio}`);
});

test('analyzePoolImage: prev に同じ画像を渡すと diff_from_prev が 0', async () => {
  const buf = await blackBuffer();
  const prev = await analyzePoolImage(buf, null);
  const curr = await analyzePoolImage(buf, prev);
  assert.equal(curr.diff_from_prev, 0);
});

test('analyzePoolImage: prev に異なる画像 (黒 vs 白) を渡すと diff_from_prev > 0.9', async () => {
  const black = await blackBuffer();
  const white = await whiteBuffer();
  const prev = await analyzePoolImage(black, null);
  const curr = await analyzePoolImage(white, prev);
  assert.ok(curr.diff_from_prev > 0.9, `diff_from_prev=${curr.diff_from_prev}`);
});

test('analyzePoolImage: 同じ Buffer で sha256 が deterministic', async () => {
  const buf = await blackBuffer();
  const r1 = await analyzePoolImage(buf, null);
  const r2 = await analyzePoolImage(buf, null);
  assert.equal(r1.sha256, r2.sha256);
});
```

- [ ] **Step 2.2: テスト実行 → 失敗確認**

```bash
node --test tests/image-pool-analyzer.test.mjs 2>&1 | tail -8
```

期待: `Cannot find module ../scripts/lib/image-pool-analyzer.mjs` で全件失敗。

- [ ] **Step 2.3: `scripts/lib/image-pool-analyzer.mjs` を実装**

```javascript
import { createHash } from 'node:crypto';
import { Jimp } from 'jimp';

const BLACK_THRESHOLD = 60; // RGB 各値が 60 未満なら「黒」扱い (タクシー車体近似)

/**
 * 画像 Buffer を解析してメタデータを返す純粋関数 (画像 I/O 以外は副作用なし)。
 *
 * @param {Buffer} buffer - 解析対象の画像 (JPEG/PNG)
 * @param {{black_ratio: number}|null} prev - 前 tick の解析結果 (null なら初回)
 * @returns {Promise<{sha256, size_bytes, black_ratio, diff_from_prev}>}
 */
export async function analyzePoolImage(buffer, prev = null) {
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const size_bytes = buffer.length;

  const img = await Jimp.read(buffer);
  const { width, height, data } = img.bitmap;
  const totalPixels = width * height;
  let blackCount = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (r < BLACK_THRESHOLD && g < BLACK_THRESHOLD && b < BLACK_THRESHOLD) {
      blackCount += 1;
    }
  }
  const black_ratio = Number((blackCount / totalPixels).toFixed(4));

  // 簡素化: 前 tick 画像との pixel diff ではなく、black_ratio の差で「変化量」を表現
  const diff_from_prev = (prev && typeof prev.black_ratio === 'number')
    ? Number(Math.abs(black_ratio - prev.black_ratio).toFixed(4))
    : null;

  return { sha256, size_bytes, black_ratio, diff_from_prev };
}
```

- [ ] **Step 2.4: テスト再実行 → パス確認**

```bash
node --test tests/image-pool-analyzer.test.mjs 2>&1 | tail -8
```

期待: 5 件全件パス。

- [ ] **Step 2.5: 全テストスイート実行 (回帰確認)**

```bash
npm test 2>&1 | tail -5
```

期待: 全件パス (289 + 5 = 294 件)。

- [ ] **Step 2.6: コミット**

```bash
git add scripts/lib/image-pool-analyzer.mjs tests/image-pool-analyzer.test.mjs
git commit -m "feat(observe): add image-pool-analyzer pure function with tests"
```

---

## Task 3: `observe-taxi-pool.mjs` orchestrator を実装

**Files:**
- Create: `scripts/observe-taxi-pool.mjs`

統合スクリプトでテストは省略 (純粋関数は Task 2 で網羅)。動作確認は Task 6 で実環境で行う。

- [ ] **Step 3.1: スクリプト全体を作成**

`scripts/observe-taxi-pool.mjs`:

```javascript
#!/usr/bin/env node
/**
 * タクシープール観測パイプライン (Phase A) のオーケストレーター。
 * 1. ttc.taxi-inf.jp から画像 2 枚取得
 * 2. analyzePoolImage で各画像のメタデータ抽出
 * 3. data/arrivals.json と data/weather.json から同時刻の状態取得
 * 4. data/taxi-pool-history.jsonl の最終行を読み、前 tick メタを取り出して diff 計算
 * 5. 新しい 1 行を append
 * 6. /tmp に画像を保存 (workflow が Artifact upload する)
 *
 * Workflow からは git commit & push の race-safe ロジックで呼ばれる。
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { analyzePoolImage } from './lib/image-pool-analyzer.mjs';

const REAL01_URL = 'https://ttc.taxi-inf.jp/Real01_line.jpg';
const REAL02_URL = 'https://ttc.taxi-inf.jp/Real02.jpg';
const USER_AGENT = 'taxi-ic-helper observation bot (https://github.com/hidenaka/taxi-ic-helper)';
const HISTORY_PATH = './data/taxi-pool-history.jsonl';
const TIMEOUT_MS = 15000;

function jstNowIso() {
  const d = new Date();
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  return jst.toISOString().replace('Z', '+09:00').replace(/\.\d+/, '');
}

async function fetchImage(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function readLastTick() {
  if (!existsSync(HISTORY_PATH)) return null;
  const txt = readFileSync(HISTORY_PATH, 'utf8').trim();
  if (!txt) return null;
  const lines = txt.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    try {
      return JSON.parse(lines[i]);
    } catch {
      continue;
    }
  }
  return null;
}

function readArrivalsState() {
  try {
    const j = JSON.parse(readFileSync('./data/arrivals.json', 'utf8'));
    const updatedAt = j.updatedAt ?? null;
    const total = j.stats?.totalEstimatedTaxiPax ?? null;
    let lagSec = null;
    if (updatedAt) {
      lagSec = Math.floor((Date.now() - new Date(updatedAt).getTime()) / 1000);
    }
    return { updated_at: updatedAt, total_estimated_taxi_pax: total, lag_seconds: lagSec };
  } catch (e) {
    console.error(`[observe] arrivals.json read failed: ${e.message}`);
    return null;
  }
}

function readWeather() {
  try {
    const j = JSON.parse(readFileSync('./data/weather.json', 'utf8'));
    return {
      code: j.current?.weatherCode ?? null,
      lightning_active: !!j.current?.lightningActive
    };
  } catch (e) {
    console.error(`[observe] weather.json read failed: ${e.message}`);
    return null;
  }
}

async function main() {
  const ts = jstNowIso();

  let buf1, buf2;
  try {
    [buf1, buf2] = await Promise.all([
      fetchImage(REAL01_URL),
      fetchImage(REAL02_URL)
    ]);
  } catch (e) {
    console.error(`[observe] image fetch failed: ${e.message}`);
    console.error('[observe] skipping this tick (no jsonl append)');
    process.exit(0);
  }

  // /tmp に保存 (workflow が Artifact upload する)
  const tsSafe = ts.replace(/[:+]/g, '-');
  writeFileSync(`/tmp/taxi-pool-${tsSafe}-real01.jpg`, buf1);
  writeFileSync(`/tmp/taxi-pool-${tsSafe}-real02.jpg`, buf2);

  const lastTick = readLastTick();
  const prev1 = lastTick?.img1 ?? null;
  const prev2 = lastTick?.img2 ?? null;
  const tickSeq = (lastTick?.tick_seq ?? 0) + 1;

  let img1, img2;
  try {
    img1 = await analyzePoolImage(buf1, prev1);
    img2 = await analyzePoolImage(buf2, prev2);
  } catch (e) {
    console.error(`[observe] image analyze failed: ${e.message}`);
    process.exit(0);
  }

  const arrivalsState = readArrivalsState();
  const weather = readWeather();

  const row = {
    ts,
    tick_seq: tickSeq,
    img1: { name: 'Real01_line', ...img1 },
    img2: { name: 'Real02', ...img2 },
    arrivals_state: arrivalsState,
    weather
  };

  appendFileSync(HISTORY_PATH, JSON.stringify(row) + '\n', 'utf8');
  console.log(`[observe] appended tick_seq=${tickSeq} ts=${ts}`);
  console.log(`[observe] img1 black_ratio=${img1.black_ratio} diff=${img1.diff_from_prev}`);
  console.log(`[observe] img2 black_ratio=${img2.black_ratio} diff=${img2.diff_from_prev}`);
}

main().catch(e => {
  console.error(`[observe] unexpected error: ${e.message}`);
  process.exit(1);
});
```

- [ ] **Step 3.2: 構文チェック**

```bash
cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係"
node --check scripts/observe-taxi-pool.mjs
```

期待: 何も出力されない。

- [ ] **Step 3.3: ローカルで 1 回実行 (実 ttc にアクセス、jsonl 1 行追加されることを確認)**

```bash
node scripts/observe-taxi-pool.mjs 2>&1 | tail -5
```

期待:
```
[observe] appended tick_seq=1 ts=2026-05-10T...
[observe] img1 black_ratio=0.XX diff=null
[observe] img2 black_ratio=0.XX diff=null
```

- [ ] **Step 3.4: 生成された jsonl を目視確認**

```bash
cat data/taxi-pool-history.jsonl
```

期待: JSON が 1 行、正しいスキーマで出ている。

- [ ] **Step 3.5: もう一度実行して diff_from_prev が出ることを確認**

```bash
node scripts/observe-taxi-pool.mjs 2>&1 | tail -3
cat data/taxi-pool-history.jsonl
```

期待: 2 行目の `tick_seq=2` で `diff_from_prev` が `null` ではなく数値 (たぶん 0、または小さい値)。画像が同一の場合は 0。

- [ ] **Step 3.6: ローカル動作確認後、jsonl とテスト用画像を削除して clean state に戻す**

```bash
rm -f data/taxi-pool-history.jsonl /tmp/taxi-pool-*.jpg
```

ローカルで生成された jsonl はテスト用なので push しない。Actions で初回起動された時に空の状態から始まる。

- [ ] **Step 3.7: コミット**

```bash
git add scripts/observe-taxi-pool.mjs
git commit -m "feat(observe): add observation orchestrator for taxi pool images"
```

---

## Task 4: spec の `diff_from_prev` 定義を簡素化版に更新

**Files:**
- Modify: `docs/superpowers/specs/2026-05-10-taxi-pool-observation-design.md`

- [ ] **Step 4.1: spec の該当 5 箇所を更新**

`docs/superpowers/specs/2026-05-10-taxi-pool-observation-design.md` を Read してから、以下の文字列を順番に Edit で書き換える。

書き換え 1 (jsonl スキーマの記述):

旧:
```
  - diff_from_prev (前 tick の同名画像との pixel-wise abs diff 平均、初回 tick は null)
```

新:
```
  - diff_from_prev (前 tick の同名画像の black_ratio との差の絶対値、初回 tick は null)
```

書き換え 2 (各値の用途の記述):

旧:
```
- `img*.diff_from_prev`: 「変化量」シグナル (出入りの大きさ)。0〜255、初回 null
```

新:
```
- `img*.diff_from_prev`: 「変化量」シグナル (黒色比率の絶対差分)。0.0〜1.0、初回 null。pixel-wise diff ではなく black_ratio の差で簡素化したのは Actions runner で前 tick 画像本体を取り直すコストを避けるため
```

書き換え 3 (jsonl サンプル):

旧:
```
    "diff_from_prev": 18.42
  },
  "img2": {
    "name": "Real02",
    "size_bytes": 85384,
    "sha256": "def5678...",
    "black_ratio": 0.2841,
    "diff_from_prev": 7.13
```

新:
```
    "diff_from_prev": 0.0314
  },
  "img2": {
    "name": "Real02",
    "size_bytes": 85384,
    "sha256": "def5678...",
    "black_ratio": 0.2841,
    "diff_from_prev": 0.0072
```

その他、jimp で pixel diff を計算するという記述があれば、analyzer の責務として「`black_ratio` の絶対差分」に書き換える。

- [ ] **Step 4.2: コミット**

```bash
git add docs/superpowers/specs/2026-05-10-taxi-pool-observation-design.md
git commit -m "docs(spec): simplify diff_from_prev to black_ratio absolute diff"
```

---

## Task 5: `.github/workflows/observe-taxi-pool.yml` を作成

**Files:**
- Create: `.github/workflows/observe-taxi-pool.yml`

- [ ] **Step 5.1: workflow ファイル作成**

`.github/workflows/observe-taxi-pool.yml`:

```yaml
name: Observe Taxi Pool

on:
  workflow_dispatch: {}

permissions:
  contents: write

concurrency:
  group: observe-taxi-pool
  cancel-in-progress: false

jobs:
  observe:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 1

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm ci --omit=dev || npm install --omit=dev

      - name: Observe and append jsonl
        run: node scripts/observe-taxi-pool.mjs

      - name: Upload pool images as artifact
        if: success()
        uses: actions/upload-artifact@v4
        with:
          name: taxi-pool-images-${{ github.run_id }}
          path: /tmp/taxi-pool-*.jpg
          retention-days: 90
          if-no-files-found: warn

      - name: Commit if changed
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          for i in 1 2 3; do
            if [ -z "$(git status --porcelain data/taxi-pool-history.jsonl)" ]; then
              echo "No change. Skipping commit."
              exit 0
            fi
            git add data/taxi-pool-history.jsonl
            git commit -m "chore(observe): tick $(TZ=Asia/Tokyo date '+%Y-%m-%d %H:%M JST')" || true
            if git push; then
              exit 0
            fi
            echo "push failed (attempt $i): refresh and re-append"
            git rebase --abort 2>/dev/null || true
            git reset --hard origin/main 2>/dev/null || git reset --hard
            git fetch origin main
            git reset --hard origin/main
            node scripts/observe-taxi-pool.mjs
            sleep $((i * 3))
          done
          echo "push failed after 3 retries"
          exit 1
```

設計判断:

- `concurrency: cancel-in-progress: false` — 既存 workflow とは違って観測は途中キャンセルを許容しない。観測 tick は連続性が大事なので最後まで実行する
- `npm ci --omit=dev || npm install --omit=dev` — `package-lock.json` がない場合のフォールバック (Task 1 で生成済みなら ci で動く)
- `if: success()` — 画像取得失敗時 (observe-taxi-pool.mjs が exit 0 でも画像なし) は Artifact upload しない
- `if-no-files-found: warn` — /tmp にファイルが無くてもエラーにならない (observe スクリプトが取得失敗時)
- 既存の race-safe push ロジック (update-arrivals.yml と同じ) を流用

- [ ] **Step 5.2: workflow YAML lint チェック**

```bash
# yamllint があれば
which yamllint && yamllint .github/workflows/observe-taxi-pool.yml
# なければ Python で構文チェック
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/observe-taxi-pool.yml'))"
```

期待: エラーなし。

- [ ] **Step 5.3: コミット**

```bash
git add .github/workflows/observe-taxi-pool.yml
git commit -m "feat(observe): add observe-taxi-pool workflow with artifact upload"
```

---

## Task 6: `docs/research/taxi-pool-observation.md` を作成

**Files:**
- Create: `docs/research/taxi-pool-observation.md`

- [ ] **Step 6.1: 分析手順メモ作成**

```bash
mkdir -p docs/research
```

`docs/research/taxi-pool-observation.md`:

```markdown
# タクシープール観測 — Phase B 分析手順

## 前提

Phase A で `data/taxi-pool-history.jsonl` に 14 日分 (約 4032 tick) のデータが
蓄積された後に、このドキュメントの手順で分析を行う。

## 必要環境

- Python 3.10+ + pandas + matplotlib (or duckdb + plotly)
- jq (簡易集計用)

## ステップ

### 1. データ取得

```bash
git pull origin main
wc -l data/taxi-pool-history.jsonl
# 期待: 4000 行前後
```

### 2. ピボット可能な形式に変換

```python
import pandas as pd
df = pd.read_json('data/taxi-pool-history.jsonl', lines=True)
df['ts'] = pd.to_datetime(df['ts'])
df['hour'] = df['ts'].dt.hour
df['weekday'] = df['ts'].dt.weekday  # 0=月
df['black_ratio_1'] = df['img1'].apply(lambda x: x['black_ratio'])
df['black_ratio_2'] = df['img2'].apply(lambda x: x['black_ratio'])
df['diff_1'] = df['img1'].apply(lambda x: x.get('diff_from_prev'))
df['diff_2'] = df['img2'].apply(lambda x: x.get('diff_from_prev'))
df['est_taxi_pax'] = df['arrivals_state'].apply(
    lambda x: x.get('total_estimated_taxi_pax') if x else None
)
df['weather_code'] = df['weather'].apply(lambda x: x.get('code') if x else None)
```

### 3. 仮説検証

#### H1: 予測上昇と実プール減少のタイミング一致

「`est_taxi_pax` が立ち上がる時刻」と「`black_ratio` が下がり始める時刻」を
日次でプロットし、ラグの平均と分散を見る。

```python
# 1日ごとに est_taxi_pax のピーク時刻 vs black_ratio_1 の谷時刻
df['date'] = df['ts'].dt.date
peaks = df.groupby('date').agg(
    pax_peak=('est_taxi_pax', lambda s: s.idxmax()),
    pool_low=('black_ratio_1', lambda s: s.idxmin())
)
# 時刻差を計算
```

#### H2: 予測スケールと出庫量の整合

`est_taxi_pax` (人) と `diff_1` の絶対値の合計 (= 1 日の出入り総量) の比が
transit-share.json の係数 (8〜32%) と整合するかを 1 日単位で見る。

#### H3: 雨天 (weather_code 50/60 系) で予測のずれ

```python
rain_codes = [51, 53, 55, 61, 63, 65]
df['is_rainy'] = df['weather_code'].isin(rain_codes)
print(df.groupby('is_rainy')[['est_taxi_pax', 'black_ratio_1']].agg(['mean', 'std']))
```

#### H4: 深夜帯 (21:30〜) のラッシュ

`hour >= 21` でフィルタし、`black_ratio_1` の急変 (`diff_1 > 0.05`) の頻度を見る。

### 4. 出力

`docs/research/taxi-pool-analysis-2026-MM-DD.md` に分析結果を書き、グラフは
`docs/research/figures/` に png で保存。

## 観測終了後の jsonl 取扱

```bash
mv data/taxi-pool-history.jsonl data/_archive/taxi-pool-history-2026-MM-DD-to-MM-DD.jsonl
git add -A && git commit -m "chore(observe): archive Phase A jsonl, start fresh observation"
```

新規観測を続けるなら空ファイルを置く必要なし (orchestrator が自動的に作る)。

## Phase B 完了後の判断

- 予測と実プールが整合 → 既存係数を維持
- 系統的なずれ → どの係数 (load-factors / transit-share / taxiBucket) を再校正するか
  Phase C spec として起こす
```

- [ ] **Step 6.2: コミット**

```bash
git add docs/research/taxi-pool-observation.md
git commit -m "docs(research): add Phase B analysis playbook"
```

---

## Task 7: ローカルから手動 push して Cronjob #3 を設定

**Files:** 変更なし (運用作業)

- [ ] **Step 7.1: origin の最新を取り込んで push**

```bash
cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係"
git fetch origin
git pull --rebase origin main
git push origin main
```

期待: Tasks 1〜6 のコミットが remote に反映される。pages.yml が workflow_run チェーンで起動するが、本タスクには影響なし。

- [ ] **Step 7.2: workflow_dispatch で手動起動して動作確認**

```bash
gh workflow run observe-taxi-pool.yml
sleep 5
RUN_ID=$(gh run list --workflow=observe-taxi-pool.yml -L 1 --json databaseId --jq '.[0].databaseId')
gh run watch $RUN_ID --exit-status 2>&1 | tail -3
```

期待: 全ステップが緑チェック、`completed success` で終わる。

- [ ] **Step 7.3: jsonl が remote に反映されたか確認**

```bash
git fetch origin
git log --oneline origin/main -3
git pull --rebase origin main
wc -l data/taxi-pool-history.jsonl
```

期待: `chore(observe): tick ...` commit があり、jsonl が 1 行ある。

- [ ] **Step 7.4: Artifact がアップロードされたか確認**

```bash
gh run view $RUN_ID
```

出力に `taxi-pool-images-{run_id}` Artifact がリストされていることを確認。手動ダウンロードする場合:

```bash
gh run download $RUN_ID --dir /tmp/observe-test-artifact
ls /tmp/observe-test-artifact/taxi-pool-images-*
```

期待: 2 枚の `.jpg` ファイル。

- [ ] **Step 7.5: cron-job.org Cronjob #3 を設定 (ユーザー作業)**

cron-job.org のダッシュボードで以下を作成:

| 項目 | 値 |
|---|---|
| Title | `taxi-ic-helper: observe-taxi-pool` |
| URL | `https://api.github.com/repos/hidenaka/taxi-ic-helper/actions/workflows/observe-taxi-pool.yml/dispatches` |
| Schedule | Every 15 minutes (既存 #1 #2 と同期) |
| Method | `POST` |
| Body | `{"ref":"main"}` |
| Headers (3 つ、#1 と同一) | Accept / Authorization / X-GitHub-Api-Version |
| Notifications | Email on failure ON |

PAT は既存の `cron-trigger-taxi-ic-helper` を使い回し可。

- [ ] **Step 7.6: 24 時間後に観測サイクルが回っていることを確認**

24h 後 (翌日同じ時刻) に以下を実行:

```bash
gh run list --workflow=observe-taxi-pool.yml -L 100 --json conclusion,event,createdAt | jq '[.[] | select(.event=="workflow_dispatch")] | length'
```

期待: 96 件前後 (15 分間隔 × 24h)。失敗があれば conclusion で確認。

```bash
git pull origin main
wc -l data/taxi-pool-history.jsonl
```

期待: 96 行前後。

---

## 検証コマンド一覧 (チートシート)

```bash
# 全テスト
npm test

# analyzer のみ
node --test tests/image-pool-analyzer.test.mjs

# ローカル 1 tick 実行 (実 ttc にアクセス)
node scripts/observe-taxi-pool.mjs

# 手動で workflow を起動
gh workflow run observe-taxi-pool.yml

# 直近の observe 実行を見る
gh run list --workflow=observe-taxi-pool.yml -L 5

# 特定の run の Artifact をダウンロード
gh run download <RUN_ID> --dir /tmp/artifact

# jsonl 行数確認
wc -l data/taxi-pool-history.jsonl

# 直近 5 tick を JSON pretty で見る
tail -5 data/taxi-pool-history.jsonl | jq .
```

---

## 完了条件 (Phase A、再掲)

- [ ] `npm test` 全件パス (294 件以上)
- [ ] `.github/workflows/observe-taxi-pool.yml` が手動 (workflow_dispatch) で 1 tick 完走
- [ ] cron-job.org Cronjob #3 が設定され、HTTP 204 を返している
- [ ] 24 時間経過後に jsonl が ≈ 96 行ある
- [ ] Actions Artifact から 24h ぶんの画像 2 枚 ×96 = 192 枚がダウンロード可能
- [ ] 14 日経過時点で ≈ 4,032 行・約 600 KB に達している
- [ ] `docs/research/taxi-pool-observation.md` の手順で Phase B 分析が起動できる状態
