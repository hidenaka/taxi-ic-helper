# タクシープール観測パイプライン 設計 (Phase A)

- 日付: 2026-05-10
- 対象: 乗務地図関係 / 到着便ビューワー
- フェーズ: Phase A (データ蓄積・観測のみ)
- 後続フェーズ: Phase B (蓄積データの分析と係数再校正の根拠提示) → 別 spec

## 背景

到着便ビューワーは ODPT API から取得した便情報をもとに `estimatedTaxiPax` (タクシー候補数) を出しているが、実需要との乖離感がある。仮係数 (transit-share の 8〜32%) と便単位の積算では、実際の「プールから出ていくタクシーの量」と一致しない可能性がある。

東京タクシーセンターが運営する `https://ttc.taxi-inf.jp` には羽田空港の主要待機所のライブ画像 (`Real01_line.jpg` 第 1 待機所、`Real02.jpg` 第 3・4 待機所) が掲載されており、ほぼリアルタイムでプールの混雑状況が見える。これを 2 週間蓄積し、現状の予測値と実プール状態に乖離があるかを定量的に判定したい。

## ゴール

- 2 週間 (約 4,032 tick) 分の観測データを蓄積する
- 観測データには「画像本体 (Actions Artifact)」「画像メタ (jsonl)」「同時刻の `estimatedTaxiPax` 予測値」「同時刻の天候」を含む
- 後続フェーズ (Phase B) で「予測 vs 実プールの相関・タイミングずれ」を分析できる粒度のデータが揃う

## 非ゴール (明確化)

- 画像から正確なタクシー台数を OCR / ML でカウントする (Phase A は `black_ratio` で代替)
- フロント (`arrivals.html`) に観測値を表示する (Phase A は内部分析専用)
- 観測値を `estimatedTaxiPax` の補正係数として使う (Phase B/C で判断、まず観測してから設計)
- ttc.taxi-inf.jp 以外の他空港データソース
- 90 日以前の過去画像を遡って訓練データ化する

## アーキテクチャ

### 不変点

| ファイル | 状態 |
|---|---|
| 既存 `update-arrivals.yml` / `update-weather.yml` / `pages.yml` | 不変 |
| 既存フロント (`arrivals.html` / `js/*`) | 不変 |
| `estimatedTaxiPax` 推定ロジック (`pax-estimator.mjs` / `taxi-estimator.mjs`) | 不変 |
| 既存 cron-job.org Cronjob #1 (arrivals) / #2 (weather) | 不変 |

### 新規ファイル

| ファイル | 種別 | 役割 |
|---|---|---|
| `.github/workflows/observe-taxi-pool.yml` | Create | workflow_dispatch トリガで 1 tick 実行 |
| `scripts/observe-taxi-pool.mjs` | Create | 取得・解析・jsonl 追記の本体 |
| `scripts/lib/image-pool-analyzer.mjs` | Create | 画像解析の純粋関数 (jimp 依存)。テスト可能 |
| `data/taxi-pool-history.jsonl` | Create | 観測ログ。1 tick = 1 行 |
| `tests/image-pool-analyzer.test.mjs` | Create | 解析関数のユニットテスト |
| `docs/research/taxi-pool-observation.md` | Create | 2 週間後の分析手順メモ |
| `package.json` | Modify | dependencies に `jimp` を追加 |

### 起動方式

cron-job.org に **Cronjob #3** を新設:

```
Title: taxi-ic-helper: observe-taxi-pool
URL: https://api.github.com/repos/hidenaka/taxi-ic-helper/actions/workflows/observe-taxi-pool.yml/dispatches
Schedule: Every 15 minutes (既存 #1 #2 と同期)
Method: POST
Body: {"ref":"main"}
Headers: 既存と同じ 3 つ (Authorization は既存 PAT 使い回し可)
Notifications: Email on failure ON
```

これで観測パイプラインは既存システムと完全独立。観測が落ちても既存システムには影響しない (フェイルセーフ)。

## データ取得・解析シーケンス

```
[Cronjob #3 trigger]
  └→ observe-taxi-pool.yml (workflow_dispatch)
       └→ scripts/observe-taxi-pool.mjs

[scripts/observe-taxi-pool.mjs]
  1. 現在 JST 時刻 (T) を取得
  2. https://ttc.taxi-inf.jp/Real01_line.jpg と Real02.jpg を curl
       - User-Agent: "taxi-ic-helper observation bot (https://github.com/hidenaka/taxi-ic-helper)"
       - 取得失敗 → console.error → exit 0 (Email noise 抑制)
  3. 画像を /tmp/taxi-pool-{T}-real01.jpg / real02.jpg に保存
  4. scripts/lib/image-pool-analyzer.mjs で各画像を解析
       - sha256 ハッシュ
       - ファイルサイズ
       - black_ratio (RGB 各値が 60 未満のピクセル割合)
       - diff_from_prev (前 tick の同名画像の black_ratio との絶対差分、初回 tick は null)
  5. data/arrivals.json から stats.totalEstimatedTaxiPax と updatedAt
  6. data/weather.json から current.weatherCode と current.lightningActive
  7. data/taxi-pool-history.jsonl に 1 行 append
  8. 画像 2 枚を Actions Artifact (期限 90 日) として upload-artifact
  9. git pull --rebase 系 race-safe ロジックで commit & push (既存と同じパターン)
```

### jsonl の 1 行スキーマ

```json
{
  "ts": "2026-05-10T13:00:00+09:00",
  "tick_seq": 1234,
  "img1": {
    "name": "Real01_line",
    "size_bytes": 89647,
    "sha256": "abc1234...",
    "black_ratio": 0.6234,
    "diff_from_prev": 0.0314
  },
  "img2": {
    "name": "Real02",
    "size_bytes": 85384,
    "sha256": "def5678...",
    "black_ratio": 0.2841,
    "diff_from_prev": 0.0072
  },
  "arrivals_state": {
    "updated_at": "2026-05-10T12:55:30+09:00",
    "total_estimated_taxi_pax": 14981,
    "lag_seconds": 270
  },
  "weather": {
    "code": 1,
    "lightning_active": false
  }
}
```

各値の用途:

- `ts`: tick の起動時刻 (JST、ISO 8601、`+09:00`)。分析時の時系列軸
- `tick_seq`: 連番 (1 から開始、休止時は連続性が切れる)。抜けの検出
- `img*.sha256`: 画像同一判定 (サイトが更新を止めた検出)
- `img*.black_ratio`: 「絶対量」シグナル (プール充足度)。0.0〜1.0
- `img*.diff_from_prev`: 「変化量」シグナル (黒色比率の絶対差分)。0.0〜1.0、初回 null。pixel-wise diff ではなく black_ratio の差で簡素化したのは、Actions runner で前 tick 画像本体を取り直すコストを避けるため
- `arrivals_state.total_estimated_taxi_pax`: 同時刻の予測 (= 研究の対義語ペア)
- `arrivals_state.lag_seconds`: arrivals.json の updatedAt と現在 tick の差。15 分以内が標準
- `weather.code`: WMO weather code (Open-Meteo)。雨/雷との連動分析用
- `weather.lightning_active`: 雷活動中フラグ

### 解析関数 (`scripts/lib/image-pool-analyzer.mjs`) のインターフェース

```javascript
// jimp で読み込んだ Buffer を引数に取り、解析結果を返す純粋関数
// prev は前 tick の解析結果オブジェクト (jsonl の最終行から復元)
export async function analyzePoolImage(buffer, prev = null) {
  // → { sha256, size_bytes, black_ratio, diff_from_prev }
  // diff_from_prev = prev?.black_ratio があれば |black_ratio - prev.black_ratio|、なければ null
}
```

`prev` が null なら `diff_from_prev` も null。Actions runner で前 tick 画像本体を取り直すコストを避けるため、pixel-wise diff ではなく前 tick の black_ratio との絶対差分を採用。

純粋関数なのでテスト可能 (`tests/image-pool-analyzer.test.mjs` で固定画像でユニットテスト)。

## エラーハンドリング

| 事象 | 対応 |
|---|---|
| ttc.taxi-inf.jp 取得失敗 (HTTP 5xx / timeout) | console.error → exit 0、jsonl 追記スキップ |
| 画像が前 tick と完全同一 (hash 一致) | サイト側更新停止の可能性。jsonl は追記する (`diff_from_prev: 0` を記録、抜け穴を作らない) |
| jimp 解析エラー (画像破損) | console.error → exit 0、jsonl 追記スキップ |
| data/arrivals.json 読み込み失敗 (極稀) | `arrivals_state` を null で記録、画像メタは記録 |
| data/weather.json 読み込み失敗 | `weather` を null で記録 |
| git push reject (race) | 既存 update-*.yml と同じ「reset --hard + retry」ロジックを流用 |

## テスト計画

### ユニットテスト (`tests/image-pool-analyzer.test.mjs`)

- `analyzePoolImage(blackBuffer)` → black_ratio が 1.0 に近い
- `analyzePoolImage(whiteBuffer)` → black_ratio が 0.0 に近い
- `analyzePoolImage(buffer, sameBuffer)` → diff_from_prev が 0
- `analyzePoolImage(buffer, differentBuffer)` → diff_from_prev > 0
- `analyzePoolImage(buffer, null)` → diff_from_prev が null
- sha256 が同じ画像で同じ値になる (deterministic)

### 統合テスト

実 ttc.taxi-inf.jp に 1 回アクセスして、jsonl 1 行が正しく書かれることを目視確認。Actions Artifact に画像が出ているか確認。

### 監視

`gh run list --workflow=observe-taxi-pool.yml -L 5` で 1 日 1 回ステータス確認。連続失敗が出たらサイト側の状態変化 (URL 変更等) を疑う。

## メンテナンス運用

- 1 日経過後 (96 行) に jsonl 構造を目視確認、欠落なし
- 7 日経過後 (672 行) に途中の `tick_seq` 抜けを集計、許容範囲か判断
- 14 日経過時点 (≈ 4,032 行) で観測完了、Phase B 分析セッションへ
- Phase B 完了後、`data/taxi-pool-history.jsonl` を `data/_archive/taxi-pool-history-2026-05-to-05.jsonl` に移動して新規観測を切り出す

## 利用規約・倫理確認 (実装の Step 0)

実装に着手する直前に以下を確認:

1. `https://ttc.taxi-inf.jp/robots.txt` の有無と内容
2. ttc.taxi-inf.jp の footer にある運営連絡先・利用規約 PDF
3. 必要なら東京タクシーセンターに事前メール (個人プロジェクト、研究目的、15 分間隔、画像 2 枚のみ、研究結果はオープンソースで公開)

結果次第で取得頻度を 15 分 → 30 分・60 分に伸ばす。15 分が許容されれば設計通り進める。

## リスクと対応

| リスク | 確度 | 影響 | 対応 |
|---|---|---|---|
| 利用規約でクロール禁止 | 中 | 法的問題 | Step 0 で確認、必要なら頻度緩和 or 中止 |
| サイトのレートリミット | 低 | 取得失敗 | 取得失敗は exit 0 でスキップ。Email 通知 OFF |
| Actions Artifact 90 日制限 | 低 | 古い画像消失 | 14 日以内に Phase B 着手で問題なし |
| jimp の解析時間 | 低 | Actions 実行延長 | 1 画像 5 秒前後、15 分間隔で余裕。問題出れば sharp 移行 |
| カメラアングル変更 (運営側) | 低 | black_ratio リセット | 90 日履歴を見れば変化点が分かる、期間を分けて分析 |
| ttc.taxi-inf.jp 画像更新停止 | 中 | hash 連続一致 | `diff_from_prev: 0` で記録、抜け穴なし |
| jsonl が 800 KB に膨らみ git が重い | 低 | clone・PR が遅い | Phase B 終了後 archive へ移動 |
| 画像のタイムスタンプと取得時刻のずれ | 中 | 分析時に時系列がぶれる | `lag_seconds` を記録して分析時に補正 |

## ロールバック

Phase A 中止が必要になった場合:

```bash
# 1. cron-job.org Cronjob #3 を Disable または Delete
# 2. 観測 workflow を無効化
gh workflow disable observe-taxi-pool.yml
# 3. 必要なら scripts/observe-taxi-pool.mjs 等を git rm
```

既存システム (arrivals 取得・フロント表示) には一切影響しない。

## 完了条件 (Phase A)

- [ ] `.github/workflows/observe-taxi-pool.yml` が手動 (workflow_dispatch) で起動でき、1 tick 完走する
- [ ] cron-job.org Cronjob #3 が設定され、HTTP 204 を返している
- [ ] 1 日経過後に `data/taxi-pool-history.jsonl` が ≈ 96 行ある
- [ ] Actions Artifact から 24h ぶんの画像がダウンロードできる
- [ ] `tests/image-pool-analyzer.test.mjs` が `npm test` で全件パス
- [ ] 14 日経過時点で ≈ 4,032 行・約 600 KB に達している
- [ ] `docs/research/taxi-pool-observation.md` の手順で Phase B 分析セッションが起動できる
