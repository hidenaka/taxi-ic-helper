# 乗り場別 出庫計測 設計書

> 作成: 2026-05-19

## 目的

車両トラッカーの出庫計測を「カメラ単位の合算」から「乗り場（stall）単位の実測」へ変更する。これにより到着便ページの予測・実績の乗り場別（乗1〜乗4）の数字が、推定の按分でなく実測になる。

## 背景・問題

`stall-rois.json` には乗り場1〜4の ROI が個別に定義されている（1〜3はカメラ `real01_line`、4は `real02`）。しかし `track_vehicles.py` は ROI を `filter_to_rois`（いずれかのROI内なら通す）という**絞り込みフィルター**にしか使っておらず、`update_tracks` は `departed`（出庫数）を**カメラ単位の単一カウンタ**で数える。結果、乗り場1+2+3 は1つの数に潰れる。

下流では `forecast-engine.mjs` の `computeForecast` が、その合算値を `splitTotalToStalls` で占有比により乗り場へ**按分（推定）**している。占有が全乗り場0に見えると均等割りになり、早朝（第2ターミナル国際線で第4乗り場のみ稼働）でも乗り場1〜3に幻の台数が出る。

ROI は定義済みなので、出庫を乗り場別に数えれば按分は不要になる。

## 採用アプローチ

トラックが消失（出庫）した瞬間の**最後の中心座標が、どの乗り場 ROI に含まれるか**で乗り場別に計上する。タクシーは1つのポールに着けて発車するため「最後の位置＝出庫した乗り場」で正確。

不採用: 「在留フレーム最多の ROI」方式 — タクシーは乗り場間を移動しないため過剰な複雑さ。

## 設計

### 1. `track_vehicles.py`（中核）

- ROI に乗り場名を持たせる。`stall_rois_for_camera` の戻りを `[{stall, x, y, w, h}, ...]` に拡張（`stall` キーを追加。既存の `x/y/w/h` は不変）。
- `filter_to_rois` は従来どおり（いずれかの ROI 内の検出を通す絞り込み）。乗り場名は判定に使わない。
- `update_tracks`: トラックが `missed > max_missed` で消失する際、その最後の中心 `(x, y)` を含む乗り場 ROI を判定し、**乗り場別カウンタ**に加算する。戻り値の `departed`（整数）を `departedByStall`（`{stall1, stall2, ...}` の dict、そのカメラに属する乗り場のみ）に置き換える。
  - 最後の位置がどの ROI にも入らない場合（境界の縁など）: その出庫は計上しない（`filter_to_rois` で ROI 内の検出しかトラック化されないため、通常は最後の位置も ROI 内。fail-safe）。
- track-history 行のスキーマを **v3 → v4** に上げる。`cameras[camera]` の `departed`（整数）を `departedByStall`（dict）に置き換える。`arrived`・`detected`・`active`・`matched_dists` は不変。
- スキーマ更新に伴い `track-state.json` は既存の自己回復ロジックでリセットされる（schema マーカー）。

### 2. throughput 校正（`throughput-calibration.mjs`）

- `trackRowDeparted(row)` を**新旧スキーマ両対応**にする: v4 行（`cameras[*].departedByStall` あり）は乗り場別の値を合算、v3 行（`cameras[*].departed`）は従来どおり。返り値は従来どおり「その行の総出庫数」。
- 新たに `trackRowDepartedByStall(row)` を追加: v4 行は `{stall1, stall2, stall3, stall4}` を返す。v3 行は乗り場分離不可のため `null` を返す。
- `computeThroughputCalibration`・`sumTrackDepartedInWindow` の `k` 校正は総出庫数ベースで従来どおり（`trackRowDeparted` を使う）。

### 3. 実績（`track-actuals.mjs` `computeTrackActuals`）

- 各15分スロットを乗り場別に集計し `{slotStart, slotEnd, stall1, stall2, stall3, stall4, total}` を返す。
- v4 行は `trackRowDepartedByStall` で乗り場別に加算。v3 行（過渡期にのみ窓内に存在）は乗り場別に分離できないため `total` のみに寄与し、`stall1..4` には加算しない。
- 配信切替後〜約2時間は窓内に v3 行が混在し乗り場別合計 < total になりうる（過渡的・自然回復）。

### 4. 予測（`forecast-engine.mjs` `computeForecast`）

- トラッカーアンカー経路を**乗り場別**にする。`trackTrend` を `{ perStall: {stall1, stall2, stall3, stall4}, windowSlots }` 形に変更（または乗り場別レートを直接持つ）。各乗り場の予測 = その乗り場の実測出庫レート × フライト需要比。
- `splitTotalToStalls` を**廃止**する（合計の按分は不要になった）。同関数とそのテストを削除。
- `computeForecast` の `latestOccupancy` 引数を削除（按分にしか使っていなかった）。
- net-diff フォールバック経路（`trackTrend` 無効時）は従来どおり（baseline は乗り場別なので変更不要）。
- `trendWindow.levelSource` は維持。

### 5. 配信・日報アプリ

- `observe-taxi-pool.mjs`: `trackTrend` 構築を乗り場別実測レートに変更。`sumTrackDepartedInWindow` を乗り場別に集計するヘルパーに置き換え or 拡張。`computeForecast` 呼び出しの `latestOccupancy` を除去。
- `stall-actuals.json`: スロットが乗り場別（`stall1..4, total`）になる。シードファイルも新形式に。
- 日報アプリ `tools/js/forecast-section.js`: `renderActualsTable` を乗り場別列（時間帯／乗1／乗2／乗3／乗4／計）に変更。予測表は既に乗り場別列のため、データが実測になるだけで描画は不変。

## これで解決すること

- 予測・実績の乗り場別の数字が**推定の按分でなく実測**になる。
- 早朝（第4乗り場のみ稼働）の乗り場1〜3の幻の台数が消える（ROI に車がいなければ実測0）。当初検討した「業務終了の案内検出」は不要（乗り場別計測がそれを内包する）。

## テスト方針（TDD）

- Python（`tests/test_track_vehicles.py`）: `stall_rois_for_camera` が `stall` キーを持つ ROI を返す。`update_tracks` が消失トラックの最後位置の ROI に基づき乗り場別 `departedByStall` を返す。複数乗り場をまたぐ検出群で正しく振り分ける。ROI外消失は計上しない。
- JS: `trackRowDeparted` 新旧両対応。`trackRowDepartedByStall`（v4→dict、v3→null）。`computeTrackActuals` 乗り場別集計（v3混在時の挙動含む）。`computeForecast` 乗り場別トラッカーアンカー経路、`splitTotalToStalls` 削除に伴う既存テスト整理。
- 両リポジトリで `npm test` 全件 ＋ Python テスト回帰。

## 実データ検証

修正後、実 track-history で `computeTrackActuals` を走らせ、乗り場別の出庫が観測実態（早朝は第4乗り場のみ非0、昼夜は各乗り場に分散）と整合することを確認する。

## 波及・確認事項

- 旧 track-history 行（v3）は append-only で残る。`trackRowDeparted` の両対応で `k` 校正は途切れない。`computeTrackActuals` は過渡期のみ乗り場別が一部欠ける。
- `splitTotalToStalls` 廃止: 同関数は 2026-05-18 のトラッカーアンカー予測で導入されたばかり。利用は `computeForecast` のみ。削除して問題ない。
- `arrived`（入庫）は乗り場別にしない（本件は出庫が対象。YAGNI）。
- track-history schema v4 化に伴い `track-state.json` リセット → 次 tick から v3 行が混じらない新規データが蓄積。

## スコープ外

- `arrived`（入庫）の乗り場別化。
- 乗り場をまたいで移動する車両の高度な追跡（タクシー乗り場では発生しない）。

## 成功基準

- track-history 行が v4（`departedByStall`）で出力される。
- 予測・実績ともに乗り場別が実測ベース（`splitTotalToStalls` 廃止）。
- 早朝の乗り場1〜3が実測0になる。
- 両リポジトリの `npm test` ＋ Python テストが回帰なしでパス。
- 実データ検証で乗り場別出庫が観測実態と整合。
