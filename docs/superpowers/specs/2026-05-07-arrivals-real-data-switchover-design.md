# 到着便ビューワー 実データ切替 設計

- 日付: 2026-05-07
- 対象: 乗務地図関係 / 到着便ビューワー (`arrivals.html`)
- 版数遷移: v0.6 (mock データ運用) → v0.7 (ODPT 実データ運用 + staleness 警告)

## 背景

`arrivals.html` 配下のデータ取得経路は `scripts/fetch-arrivals.mjs` + `scripts/lib/odpt-client.mjs` で ODPT API 接続前提に既に実装され、テスト済み。
GitHub Actions `update-arrivals.yml` も `*/5 * * * *` で動く設計。
ただし `ODPT_TOKEN` シークレット未設定だったため、Actions は早期リターンし、`scripts/generate-mock-arrivals.mjs` が生成したモック JSON を `data/arrivals.json` として配信していた。

ODPT トークンを入手したため、フロント側のデータソースを実データに切り替える。同時に「データが古い」状態をユーザーが視覚的に把握できる staleness 警告バナーを入れる。

## ゴール

- ODPT 実データを `data/arrivals.json` 経由でフロントに配信する状態にする
- ローカルで1回検証してから GitHub Secrets に登録する手順を確立する
- フロントが `updatedAt` の鮮度を判断し、古い時に警告バナーを出すようにする
- 既存の mock 生成スクリプトはオフライン開発・フィクスチャ用途として残す

## 非ゴール

- `transformArrivals` 以降のロジック改修（reachRate / taxiBucket / heatmap 閾値など）
- 上記係数の再校正は実データを 2〜3 日観測後の別タスク
- `arrivals.html` の UI レイアウト変更
- ODPT 以外のデータソース対応

## アーキテクチャ

### 不変点

| ファイル | 役割 | 改修要否 |
|---|---|---|
| `arrivals.html` | DOM 骨格 | バナー要素 1 行追加のみ |
| `js/arrivals-app.js` | データ取得 + state + 描画呼び出し | staleness 判定追加 |
| `js/arrivals-data.js` | データ整形・集計 (純粋関数) | `classifyStaleness` 純粋関数を追加 |
| `js/arrivals-render.js` | DOM 描画関数群 | staleness バナー描画関数追加 |
| `scripts/fetch-arrivals.mjs` | ODPT 取得 → 整形 → 書き出し | 不変 |
| `scripts/lib/odpt-client.mjs` | ODPT API クライアント | 不変 |
| `scripts/lib/arrival-transformer.mjs` | 整形ロジック | 不変 |
| `.github/workflows/update-arrivals.yml` | 5 分間隔 cron | 不変 (Secrets 登録のみ) |
| `scripts/generate-mock-arrivals.mjs` | モック生成 | 不変 (役割が「初期動作確認」→「オフライン用」に再定義) |

`transformArrivals` の出力スキーマは ODPT 形式入力に対して定義済みで、mock も実データも同じスキーマで出力されるため、フロントから見たデータ契約は変わらない。

### 変更ファイル

1. **`.gitignore`**: `.env` が確実に除外されていることの確認 (既存に含まれていなければ追加)
2. **`.env.example`** (新規): `ODPT_TOKEN=your-token-here` のテンプレ
3. **`README.md`**: v0.6 表記を v0.7 へ更新、「mock データ」記載を「ODPT 実データ運用、`generate-mock-arrivals.mjs` はオフライン用」に書き換え
4. **`arrivals.html`**: `<div id="stale-banner">` を `#weather-banner` の直後に追加
5. **`js/arrivals-app.js`**: `render()` 内で staleness 判定→`renderStaleBanner` 呼び出し
6. **`js/arrivals-render.js`**: `renderStaleBanner(el, updatedAtIso, nowDate)` 関数を追加 (既存 `renderWeatherBanner` と同じ作法)
7. **`tests/staleness.test.mjs`** (新規): staleness 判定純粋関数のユニットテスト

## Staleness 警告仕様

### 判定関数 (純粋関数として `arrivals-data.js` に追加)

```
classifyStaleness(updatedAtIso, now) -> { level, ageMinutes }
  ageMinutes = floor((now - updatedAt) / 60000)
  JST hour < 5 (Asia/Tokyo) なら level = 'suppressed' (表示なし)
  ageMinutes < 15        → level = 'fresh'    (表示なし)
  15 <= ageMinutes <= 60 → level = 'warn'     (黄バナー)
  ageMinutes > 60        → level = 'critical' (橙バナー)
```

境界値の取り扱いを明示: 14 分は `fresh`、15 分ちょうどは `warn`、60 分ちょうどは `warn`、61 分以上は `critical`。

判定はクライアント側時計に依存。ユーザー端末の時計が大きく狂っていなければ実用上問題ない。

### 文言

- `warn`: 「データが N 分前。更新が遅延している可能性があります。」
- `critical`: 「データが N 分前。API 停止の可能性があるため参考程度にしてください。」

### しきい値の根拠

- Actions は `*/5 * * * *` で 5 分間隔 → 1 回失敗 (= 10 分以内) は許容
- 15 分 (3 回連続失敗相当) で `warn`
- 60 分 (12 回連続失敗相当) で `critical`

### 抑制条件

JST 5:00 前は `fetch-arrivals.mjs` 側が `process.exit(0)` で早期 exit するため、`updatedAt` は前夜から固定。この時間帯は古くて当然なので、表示を抑制する。

`arrivals-app.js` の `render()` 内で `new Date()` から JST hour を判定し、5 未満なら `renderStaleBanner` をクリア状態 (`hidden = true`) で呼ぶ。

## データフロー

### 実データ運用時 (デフォルト・本番)

```
GitHub Actions (cron: */5 * * * *)
  └→ scripts/fetch-arrivals.mjs
       ├→ scripts/lib/odpt-client.mjs (7 オペレータ並列 GET)
       ├→ scripts/lib/arrival-transformer.mjs (ODPT → arrivals.json スキーマ)
       └→ data/arrivals.json 上書き → git commit & push

ブラウザ
  └→ arrivals.html
       └→ js/arrivals-app.js
            ├→ fetch('./data/arrivals.json')
            ├→ classifyStaleness(updatedAt, new Date())
            └→ render*()
```

### オフライン開発時

```
node scripts/generate-mock-arrivals.mjs
  └→ data/arrivals.json 上書き
npm run serve
  └→ ブラウザで動作確認
```

mock 生成スクリプトは `transformArrivals` を経由してから書き出すため、出力スキーマは実データと完全互換。

## 切替手順 (ローカル → 本番の順序保証)

1. ローカルで `.env` 作成 (gitignore済) し、`ODPT_TOKEN=xxx` を貼る
2. `node scripts/fetch-arrivals.mjs` を実行
   - `Wrote N flights to ./data/arrivals.json` を確認
   - エラー時はトークン誤り or ネットワーク不通として切り分け
3. `npm run serve` → `http://localhost:8000/arrivals.html` を開いて目視
   - 便数が mock (48 便) より顕著に多いことを確認
   - T1 / T2 / T1+T2 / T3 タブ切替が動く
   - ヒートマップ表示が崩れない
   - reachTier / タクシー候補数 / トピックスがそれらしい値で出る
   - `updatedAt` が今しがたで、staleness バナーが表示されない
4. 任意: `data/arrivals.json` の `updatedAt` を手で 1 時間前にずらして再読込し、橙バナー (`critical`) が出ることを目視確認
5. `npm test` (既存 219 件 + 新規 staleness テスト) がグリーン
6. ローカルの実データ `data/arrivals.json` は commit せず `git restore data/arrivals.json` で mock に戻す
7. 残りの変更 (フロント / README / `.env.example` / 新規テスト) だけ commit & push
8. GitHub リポジトリ Settings → Secrets and variables → Actions に `ODPT_TOKEN` を登録
9. 次回 Actions 実行 (5 分以内) で実データが自動コミット
10. 本番 URL で目視確認、staleness バナーが出ていないことを確認

## エラーハンドリング

| 事象 | 既存挙動 | 改修後の追加挙動 |
|---|---|---|
| ODPT API 0 件取得 | `Skipping write` で過去 JSON 温存 (既存) | フロントが staleness 検知して `warn`/`critical` 表示 |
| ODPT API 5xx | `console.error` し空配列で続行 (既存) | 同上 |
| ODPT トークン誤り | 各オペレータ個別に 401 ログ → 全件失敗で 0 件 | 同上 |
| `arrivals.json` 不正 JSON | フロントの `arrivals-error` 要素にメッセージ表示 (既存) | 不変 |
| ユーザー端末の時計ずれ | 影響なし | staleness 判定が誤差を持つが運用上許容 |

## テスト計画

### 新規ユニットテスト (`tests/staleness.test.mjs`)

`classifyStaleness` 純粋関数に対して以下のケース:

- 0 分前 → `fresh`
- 14 分前 → `fresh` (境界手前)
- 15 分前 → `warn` (境界)
- 60 分前 → `warn` (境界)
- 61 分前 → `critical`
- 180 分前 → `critical`
- JST 04:30 時点で 8 時間前 → `suppressed`
- JST 06:00 時点で 8 時間前 → `critical` (抑制が外れる)

### 既存テスト

`npm test` で既存 219 件がグリーンであることを確認。フロント DOM 周りは既存テスト範囲外なので、staleness バナーの DOM 描画は手動目視で担保 (手順 4)。

### 統合検証

切替手順 3〜4 が手動統合テストの役割を兼ねる。

## リスクと対応

| リスク | 確度 | 影響 | 対応 |
|---|---|---|---|
| 実データの便数が mock の 3〜4 倍 → ヒートマップ閾値 (`DENSITY_HIGH=600` など) が大味になる | 中 | UI 視認性の劣化 | 別タスクで観測後に係数調整。今回は触らない |
| reachRate / taxiBucket の係数が実データ分布に合わない | 中 | タクシー候補数の精度劣化 | 同上、別タスクで再校正 |
| ローカル実行時に誤って実データを commit | 低 | プライバシー懸念は無いが履歴が膨らむ | 手順 6 で明示。`.env` を gitignore で守る |
| ODPT トークン漏洩 | 低 | 権限濫用 | `.env` を gitignore、`.env.example` のみコミット、Secrets で本番管理 |
| Actions 失敗が連続して `data/arrivals.json` が古いまま | 中 | 古いデータでタクシー判断 | staleness 警告で UI 側から検知 |

## ロールバック

問題発生時の戻し方 (順序):

1. GitHub Secrets から `ODPT_TOKEN` を削除 → Actions が早期 exit に戻る
2. `node scripts/generate-mock-arrivals.mjs` を実行して mock 状態の `data/arrivals.json` を再生成
3. mock 状態の `arrivals.json` を本番 (Actions が動く) リポジトリに commit & push
4. 必要なら staleness バナー追加分の 6 ファイルを `git revert`

## 完了条件

- 本番 URL で `arrivals.html` を開いた時、便数 / 各タブ / heatmap / reachTier / タクシー候補数 / トピックスが mock 時より多い実データで表示される
- `updatedAt` が直近で、staleness バナーが表示されない
- 手で `updatedAt` を古くした検証で `warn` / `critical` バナーが正しい色と文言で出る
- `npm test` が全件グリーン
- README が v0.7 表記に更新されている
