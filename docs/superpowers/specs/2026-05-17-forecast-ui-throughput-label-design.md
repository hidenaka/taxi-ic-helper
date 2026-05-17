# 本番画面に「実測校正済み」ラベル表示 設計

- 日付: 2026-05-17
- 対象: 乗務地図関係 / 予測画面 `forecast.html` に、出庫台数が車両追跡の実測で校正済みであることを示すバナーを追加する
- 前提: G-5（`stall-forecast.json`/`stall-ensemble.json` 真値化）、G-6（`forecast-accuracy.json`）、G-8（`stall-pattern-match.json`）。これらで4出力 JSON に `throughputScaleK`（適用済み校正係数）が付いている。

## 背景

forecast パイプラインの4出力 JSON は G-5/G-6/G-8 で真値化され、各 JSON のトップレベルに `throughputScaleK`（適用した calibration 係数 `k`）を持つ。calibration が `learning` に到達し `k` が 1.0 から実値（現在 ≈4.74）になった結果、本番画面 `forecast.html` の表示台数が約4.7倍に跳ねた。だが画面上にその説明がなく、見る人が混乱しうる。`forecast.html` は現在 `throughputScaleK` を一切参照していない。

本タスクで、予測台数が車両追跡の実測で校正済みであることを画面に明示する。

## 設計方針

1. **単一バナー。** per-section ラベルではなく、ページ冒頭に1つのバナーを置く。4出力 JSON はすべて同一 observe tick・同一 `k` で生成されるため、ページ先頭の1箇所の表示で全体に対して正しい（DRY）。
2. **既存パターン踏襲。** バナーの描画は `js/forecast-render.js` の既存 `render*` 関数と同じスタイル（`el`/`obj` ガード、`innerHTML` 設定）の新関数として追加し、`js/forecast-app.js` から呼ぶ。
3. **JSON 側は変更しない。** `throughputScaleK` は既に4 JSON にある。本タスクは表示のみ。

## 変更内容

### ① `forecast.html`

- `<main>` の冒頭（`<section class="ensemble-section">` の直前）に空のバナー要素を追加:
  ```html
  <div id="throughput-banner" class="throughput-banner"></div>
  ```
- `<style>` 内に `.throughput-banner` クラスを追加。既存のダークテーマ変数（`--accent`/`--sub`/`--bg`）を使う控えめな1行バナー。校正済み状態が伝わる程度に accent 寄りの色味、未校正時は sub 色（クラスの出し分けは ② の関数が行う — 下記）。
  - ベース: `.throughput-banner { font-size: 13px; padding: 8px 10px; border-radius: 6px; margin-bottom: 12px; }`
  - 校正済み: `.throughput-banner.calibrated { background: rgba(78,161,255,0.12); color: var(--accent); }`
  - 未校正: `.throughput-banner.pending { background: #16161c; color: var(--sub); }`

### ② `js/forecast-render.js` — `renderThroughputBanner(el, obj)` を新規 export

- `el` が falsy、または `obj` が falsy なら何もしない（既存 `render*` 関数と同じガード）。
- `obj.throughputScaleK` を読む。
- `throughputScaleK` が数値かつ `> 1`（校正が効いている）:
  - `el.className = 'throughput-banner calibrated'`
  - `el.textContent = '🚕 予測台数は車両追跡の実測で校正済み（校正係数 ×' + k小数2桁 + '）'`
- それ以外（`throughputScaleK` が 1 以下・非数値・未定義 = 追跡校正データ蓄積中）:
  - `el.className = 'throughput-banner pending'`
  - `el.textContent = '予測台数は占有差分ベース（車両追跡の校正データ蓄積中）'`
- `k` の小数2桁表示は `Number(throughputScaleK).toFixed(2)`。

### ③ `js/forecast-app.js`

- 関数冒頭の要素取得群に `const bannerEl = document.getElementById('throughput-banner');` を追加。
- import 文に `renderThroughputBanner` を追加。
- ensemble の `try` ブロック内、`renderEnsemble(...)` の後に `renderThroughputBanner(bannerEl, ensemble)` を呼ぶ（ensemble は最初に fetch される headline で `throughputScaleK` を持つ）。
- ensemble fetch が失敗した場合（`catch` 節）はバナーを空のままにする（既存の `catch` 節の挙動に倣い、`bannerEl` は触らない or 明示的に空文字。本設計では触らない＝空のまま）。

## エラーハンドリング

| 事象 | 対応 |
|---|---|
| `stall-ensemble.json` の fetch 失敗 | `renderThroughputBanner` を呼ばない → バナーは空 `<div>` のまま（既存 catch 節と整合） |
| `ensemble.throughputScaleK` が無い（旧 JSON） | `renderThroughputBanner` が「未校正」文言を出す |
| `bannerEl` が null（HTML 不整合） | `renderThroughputBanner` の先頭ガードで何もしない |

## テスト方針

- `js/forecast-render.js` はブラウザ DOM 描画層で、既存の `render*` 関数も含め unit テストを持たない（このプロジェクトの JS 自動テストは `.mjs` の純ロジックのみが対象）。本変更（`renderThroughputBanner`）も同方針で unit テストは追加しない。
- 検証: `node --check js/forecast-render.js` と `node --check js/forecast-app.js`（構文エラーなし）。
- 目視確認は任意（`npm run serve` で `forecast.html` を開き、バナーに校正係数が出ることを確認）。
- `npm test`（node:test、lib ロジック）は不変・全 pass を維持。

## デプロイ

`forecast.html` / `js/*.js` はリポジトリの静的ファイル（observe-tick の `git pull`/`git push` で配布、ブラウザは `data/*.json` を `no-store` で取得）。新 pip/npm 依存なし、launchd 変更なし。デプロイ後、画面読み込み時にバナーが表示される。

## スコープ外

- 4出力 JSON 側（`throughputScaleK` は G-5/G-6/G-8 で付与済み）。
- per-section の詳細ラベル、accuracy セクションの単位注記。
- `forecast-render.js` の他の描画ロジック、`pattern-match`/`accuracy`/`corrections` セクションの変更。

## 完了条件

- `forecast.html` に `throughput-banner` 要素と `.throughput-banner`（+ `.calibrated`/`.pending`）CSS がある。
- `js/forecast-render.js` に `renderThroughputBanner` が実装・export され、`js/forecast-app.js` が ensemble fetch 後に呼ぶ。
- `throughputScaleK > 1` で「校正済み（×k）」、それ以外で「校正データ蓄積中」と文言が切り替わる。
- `node --check` が両 JS で通過。`npm test` 不変・全 pass。
