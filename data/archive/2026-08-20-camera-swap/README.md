# 2026-08-20 のカメラ入れ替えで止まったデータ

ここにあるのは **過去のデータ** です。現在の画面には使いません。
振り返り・再学習の材料として参照してください。

## いつ止まったか
すべて **2026-08-20 12:25 (JST)** が最後。埋まり率だけは 11:21。

## なぜ止まったか
2026-08-20 に羽田のライブ画像が新カメラへ総入れ替えされた。
旧URL(`Real01_line.jpg` / `Real02.jpg`)は HTTP 200 を返し続けるが中身が凍結している。
`observe-taxi-pool.mjs` に「画像が前 tick とバイト同一なら二重計測しない」ガードがあり、
これが **tick 全体を中断** していたため、カメラと無関係な到着便スナップショットまで
道連れで止まった。2026-08-31 に本人へ報告し、到着便の記録はガードより前へ移して復旧済み。

## 中身
| ファイル | 何か |
|---|---|
| taxi-pool-history.jsonl | プールの観測ログ(旧カメラ画角) |
| stall-forecast.json / stall-ensemble.json / stall-pattern-match.json | 号別の予測 |
| forecast-accuracy.json / forecast-log.jsonl | 予測の当たり外れ |
| stall-actuals.json | 出庫の実績 |
| coefficient-corrections.json | 予測係数の自動補正 |
| t3-pool-fill.json | T3プールの埋まり |
| noriba-fill-history.jsonl | 全レーン埋まり率(旧カメラの区画点・学習モデル) |

## 注意
座標・区画・学習モデルはすべて **旧カメラの画角** に依存している。
新カメラでそのまま使うことはできない(作り直しが必要)。

## 関連
- 到着便の履歴は `data/arrivals-snapshots/` で 2026-08-31 から再開している
- 現在の埋まり率は「路面ベース」(`data/surface-fill-calib.json` / `scripts/lib/fill-select.mjs`)

## 大きい追記型ファイルはここに複製していない
容量が大きく、追記型なので上書きで消える心配が無い。元の場所のまま残してある。

| ファイル | 場所 | 最後の行 | 大きさ |
|---|---|---|---|
| forecast-log.jsonl | data/forecast-log.jsonl | 2026-08-20 12:25 | 127MB |
| taxi-pool-history.jsonl | data/taxi-pool-history.jsonl | 2026-08-20 12:25 | 48MB |
| noriba-fill-history.jsonl | data/noriba-fill-history.jsonl | 2026-08-20 11:21 | 1.8MB |

複製してあるのは、パイプライン再開時に**上書きされて消える**小さな状態ファイルだけ。
