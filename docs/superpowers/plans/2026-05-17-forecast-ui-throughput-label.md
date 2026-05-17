# 本番画面「実測校正済み」ラベル表示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 予測画面 `forecast.html` の冒頭に、出庫台数が車両追跡の実測で校正済みであることを示す1行バナーを表示する。

**Architecture:** 4出力 JSON はすでに G-5/G-6/G-8 でトップレベルに `throughputScaleK`（適用済み calibration 係数）を持つ。本タスクは表示のみ。`js/forecast-render.js` に既存 `render*` 関数と同じスタイルのバナー描画関数 `renderThroughputBanner` を新設し、`js/forecast-app.js` が ensemble の fetch 直後にそれを呼ぶ。`forecast.html` に空のバナー要素と CSS を追加する。

**Tech Stack:** バニラ ES module（ブラウザ）、CSS（ダークテーマ変数 `--accent`/`--sub`）。ビルド工程なし。新依存なし。

**前提 spec:** `docs/superpowers/specs/2026-05-17-forecast-ui-throughput-label-design.md`

**テスト方針（重要）:** `js/forecast-render.js` はブラウザ DOM 描画層で、既存 `render*` 関数も含めこのプロジェクトの自動テスト対象外（自動テストは `.mjs` の純ロジックのみ）。本変更も unit テストを追加しない。検証は `node --check`（構文）と `npm test`（既存 lib ロジックが不変・全 pass）で行う。

---

### Task 1: `renderThroughputBanner` を `js/forecast-render.js` に追加

**Files:**
- Modify: `js/forecast-render.js`（末尾に新 export 関数を追加）

- [ ] **Step 1: 関数を追加**

`js/forecast-render.js` の末尾（`renderCorrections` 関数の閉じ `}` の後、ファイル最終行）に、以下のブロックを追記する:

```javascript

// --- G-9: スループット校正バナー描画 ---

/**
 * 出力 JSON の throughputScaleK を読み、予測台数が車両追跡実測で
 * 校正済みかどうかを示す1行バナーを描画する。
 * @param {HTMLElement} el - バナー要素 (#throughput-banner)
 * @param {object} obj - throughputScaleK を持つ出力 JSON (ensemble など)
 */
export function renderThroughputBanner(el, obj) {
  if (!el || !obj) return;
  const k = Number(obj.throughputScaleK);
  if (Number.isFinite(k) && k > 1) {
    el.className = 'throughput-banner calibrated';
    el.textContent = `🚕 予測台数は車両追跡の実測で校正済み（校正係数 ×${k.toFixed(2)}）`;
  } else {
    el.className = 'throughput-banner pending';
    el.textContent = '予測台数は占有差分ベース（車両追跡の校正データ蓄積中）';
  }
}
```

判定の根拠:
- `Number(obj.throughputScaleK)` — `undefined`（旧 JSON）は `NaN`、文字列もパース。
- `Number.isFinite(k) && k > 1` — 数値かつ 1 超のときのみ「校正済み」。`NaN`・`1` 以下・未定義はすべて「蓄積中」に落ちる（spec の「それ以外」分岐）。
- `k.toFixed(2)` — `k` は `Number.isFinite` を通過済みなので `.toFixed` は安全。

- [ ] **Step 2: 構文チェック**

Run: `node --check js/forecast-render.js`
Expected: 出力なし・終了コード 0（構文エラーなし）

- [ ] **Step 3: 関数が export されていることを確認**

Run: `node --input-type=module -e "import('./js/forecast-render.js').then(m => console.log(typeof m.renderThroughputBanner))"`
Expected: `function` と表示される

- [ ] **Step 4: Commit**

```bash
git add js/forecast-render.js
git commit -m "$(cat <<'EOF'
feat: add renderThroughputBanner to forecast-render

G-9 Task 1. 出力JSONの throughputScaleK を読み、予測台数が
車両追跡実測で校正済みかを示すバナー文言を描画する関数を追加。
表示のみ・JSON側は不変。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: バナー要素と CSS を `forecast.html` に追加

**Files:**
- Modify: `forecast.html`（`<style>` 内に CSS 3行、`<main>` 冒頭に `<div>` 1個）

- [ ] **Step 1: CSS クラスを追加**

`forecast.html` の `<style>` ブロック内、`.src-fallback { color: var(--sub); }` の行（現状 65 行目）の直後に、以下の3行を追加する:

```css
    .throughput-banner { font-size: 13px; padding: 8px 10px; border-radius: 6px; margin-bottom: 12px; }
    .throughput-banner.calibrated { background: rgba(78,161,255,0.12); color: var(--accent); }
    .throughput-banner.pending { background: #16161c; color: var(--sub); }
```

追加後、その直後の行が `  </style>` であること。

- [ ] **Step 2: バナー要素を追加**

`forecast.html` の `<main>` 開始タグ（現状 73 行目 `  <main>`）の直後・`<section class="ensemble-section" id="ensemble-section">` の直前に、以下の1行を挿入する:

```html
    <div id="throughput-banner" class="throughput-banner"></div>
```

結果として該当箇所が以下の並びになること:

```html
  <main>
    <div id="throughput-banner" class="throughput-banner"></div>
    <section class="ensemble-section" id="ensemble-section">
```

注: 初期状態の空 `<div>` は `.calibrated`/`.pending` が付かないため背景色なし。Task 3 で ensemble fetch 後に `renderThroughputBanner` がクラスとテキストを設定する。ensemble fetch 失敗時は空のまま（spec のエラーハンドリング方針どおり）。

- [ ] **Step 3: 構文・要素の確認**

Run: `grep -n 'throughput-banner' forecast.html`
Expected: 4 行ヒット（CSS 3 行 + `<div>` 1 行）

- [ ] **Step 4: Commit**

```bash
git add forecast.html
git commit -m "$(cat <<'EOF'
feat: add throughput-banner element and CSS to forecast.html

G-9 Task 2. <main>冒頭に空のバナー要素、<style>に
.throughput-banner（calibrated/pending）クラスを追加。
描画は forecast-app.js が担う。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `js/forecast-app.js` でバナー描画を配線

**Files:**
- Modify: `js/forecast-app.js`（import 1 箇所、要素取得 1 行、呼び出し 1 行）

- [ ] **Step 1: import に `renderThroughputBanner` を追加**

`js/forecast-app.js` の冒頭 import 文（現状 1-5 行目）を、以下に置き換える:

```javascript
import {
  renderForecastMeta, renderForecastTable,
  renderPatternMeta, renderSimilarDays, renderHistoricalCurve,
  renderAccuracy, renderEnsemble, renderCorrections,
  renderThroughputBanner,
} from './forecast-render.js';
```

- [ ] **Step 2: バナー要素の取得を追加**

`main()` 内の要素取得群の先頭、`const ensembleMetaEl = document.getElementById('ensemble-meta');` の行（現状 8 行目）の直前に、以下の1行を追加する:

```javascript
  const bannerEl = document.getElementById('throughput-banner');
```

- [ ] **Step 3: ensemble の try ブロックでバナーを描画**

統合予測の try ブロック内、`renderEnsemble(ensembleMetaEl, ensembleTableEl, ensemble);` の行（現状 26 行目）の直後に、以下の1行を追加する:

```javascript
    renderThroughputBanner(bannerEl, ensemble);
```

結果として該当 try ブロックが以下になること:

```javascript
  // 統合予測 (Phase D-2) — メイン予測、最初に描画
  try {
    const res = await fetch('data/stall-ensemble.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ensemble = await res.json();
    renderEnsemble(ensembleMetaEl, ensembleTableEl, ensemble);
    renderThroughputBanner(bannerEl, ensemble);
  } catch (e) {
    ensembleMetaEl.textContent = `統合予測データの読み込みに失敗: ${e.message}`;
    ensembleTableEl.innerHTML = '';
  }
```

注: `catch` 節は変更しない。ensemble fetch が失敗した場合 `renderThroughputBanner` は呼ばれず、バナーは空 `<div>` のまま（spec のエラーハンドリング方針どおり）。

- [ ] **Step 4: 構文チェック**

Run: `node --check js/forecast-app.js`
Expected: 出力なし・終了コード 0（構文エラーなし）

- [ ] **Step 5: モジュール読み込みの確認**

Run: `node --check js/forecast-render.js && node --check js/forecast-app.js && echo OK`
Expected: `OK` と表示される（両 JS が構文エラーなし）

- [ ] **Step 6: 既存テストの回帰確認**

Run: `npm test`
Expected: 全 pass（現状 451 件）。本タスクは `.mjs` lib ロジックに触れないため件数・結果とも不変。

- [ ] **Step 7: Commit**

```bash
git add js/forecast-app.js
git commit -m "$(cat <<'EOF'
feat: wire renderThroughputBanner into forecast-app

G-9 Task 3. ensemble の fetch 直後にバナーを描画。ensemble は
throughputScaleK を持つ headline JSON。fetch 失敗時はバナーは空のまま。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## 完了後の確認

- `forecast.html` に `#throughput-banner` 要素と `.throughput-banner`（+ `.calibrated`/`.pending`）CSS がある。
- `js/forecast-render.js` に `renderThroughputBanner` が実装・export され、`js/forecast-app.js` が ensemble fetch 後に呼ぶ。
- `throughputScaleK > 1` で「🚕 予測台数は車両追跡の実測で校正済み（校正係数 ×k）」、それ以外で「予測台数は占有差分ベース（車両追跡の校正データ蓄積中）」と切り替わる。
- `node --check` が両 JS で通過。`npm test` 全 pass・件数不変。
- 目視確認（任意）: `npm run serve` で `forecast.html` を開き、バナーに校正係数（現在の本番 calibration は `learning`・k≈4.74）が表示されることを確認。

## デプロイ

`forecast.html` / `js/*.js` はリポジトリの静的ファイル。Mac mini の observe-tick が `git pull`/`git push` で配布する。新 pip/npm 依存なし、launchd 変更なし。3コミットを main に直 push（`git pull --rebase --autostash origin main` 後）すれば、次回の画面読み込み時にバナーが表示される。

## スコープ外

- 4出力 JSON 側（`throughputScaleK` は G-5/G-6/G-8 で付与済み）。
- per-section の詳細ラベル、accuracy セクションの単位注記。
- `forecast-render.js` の他の描画ロジック。
