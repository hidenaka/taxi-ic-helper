# terminal別 share補正 設計 (Phase D-4)

- 日付: 2026-05-16
- 対象: 乗務地図関係 / transit-share 補正の端末別 (T1/T2/T3) 分離
- 前提 spec: `2026-05-16-coefficient-online-correction-design.md` (Phase D-3、実装済)
- 関連: `2026-05-16-forecast-accuracy-tracking-design.md` (D-1), `2026-05-16-ensemble-weighting-design.md` (D-2)

## 背景

Phase D-3 で transit-share バケット率の補正 (Stage 1) を実装したが、補正係数はバケット単位・**T1/T2/T3 端末一律**だった。これは「実測 outflow が端末を区別しない」という前提によるものだった。

しかし観測設定 `scripts/lib/stall-rois.json` を確認すると、4 つの観測 stall は端末別にラベル付けされている:

| stall | ラベル | 端末 |
|---|---|---|
| stall1 | 第1乗り場 (JAL 2番ポール T1) | T1 |
| stall2 | 第2乗り場 (JAL 18番ポール T1) | T1 |
| stall3 | 第3乗り場 (ANA 3番ポール T2) | T2 |
| stall4 | 第4乗り場 (ANA 19番ポール T2) | T2 |

つまり `stall1+stall2` の outflow は T1 向け、`stall3+stall4` の outflow は T2 向けである。`buildActualMap` は既に `[stall1,stall2,stall3,stall4]` 別に実測を返すため、**回帰分解なしで T1/T2 を直接 terminal別に補正できる**。

T3 (国際線ターミナル) のタクシー乗り場は観測4 stall に含まれない (現場確認済み: T3 は別プール)。よって T3 は観測対象外であり補正できない。

### D-3 バイアスの解消

D-3 の `computeShareCorrection` は `dayRatio = Σ実測outflow ÷ Σ estimatedTaxiPax` を計算するが、分子 (Σoutflow) は T1+T2 のみ、分母 (Σ estimatedTaxiPax) は T3 便を含む全便だった。T3 便には対応する観測 outflow が無いため、D-3 の補正係数は系統的に低めに歪んでいた。D-4 の端末別分離はこのバイアスを構造的に解消する。

## 設計方針

1. **D-3 の方針を継承。** base config (`transit-share.json`) は不変、補正は `coefficient-corrections.json` の別レイヤー、決定論的ウィンドウ加重平均、fail-safe。
2. **D-3 Stage 1 を端末別に置き換える。** `computeShareCorrection` の出力をバケット単位 `{factor}` から端末別ネスト `{T1, T2, T3}` に変更する。Stage 2 (level 補正) は一切変更しない。
3. **T3 は観測外として明示する。** T3 factor は常に 1.0、`source: "unobservable"`。
4. **D-3 → D-4 の移行を安全に。** `coefficient-corrections.json` の `schemaVersion` を 2 に上げる。`buildEffectiveTransitShare` は新旧どちらの share 形状も許容し、observe-tick がファイルを再生成するまでの数分間も現行動作を保つ。

## アルゴリズム: `computeShareCorrection` の端末別化

シグネチャは D-3 から不変: `computeShareCorrection(snapshotRows, actualMap, transitShare, now)`。

直近 `SHARE_WINDOW_DAYS = 7` の完了日を対象に、直近日ほど重い線形加重平均をとる手順は D-3 と同じ。バケット別の集計を端末別に分ける:

各完了日・各バケットについて:
- **T1**: 便を `pickBucket(lobbyExitTime)` でバケット振り分け、`terminal === "T1"` の便の `Σ estimatedTaxiPax` を集計。`actualMap` から当日・当バケット時間範囲の slot の `stall1 + stall2` outflow 合計を集計。日次比率 `dayRatioT1 = Σ(stall1+stall2) ÷ Σ estimatedTaxiPax(T1便)`。
- **T2**: 同様に `terminal === "T2"` の便と `stall3 + stall4` outflow。
- **T3**: 集計しない。

バケット別・端末別 (T1/T2) に日次比率を加重平均 → `factor`。clip ∈ `[SHARE_FACTOR_MIN=0.3, SHARE_FACTOR_MAX=3.0]`。

フォールバック判定 (端末別):
- ある端末のそのバケットの寄与便数 `< SHARE_MIN_FLIGHTS = 20`、または有効日数 0 → `factor = 1.0`, `source: "fallback"`。
- それ以外 → `source: "learning"`。
- T3 は常に `factor: 1.0`, `source: "unobservable"`。

`terminal` フィールドが `T1`/`T2`/`T3` 以外または欠損の便は集計から除外する。

## スキーマ: `coefficient-corrections.json` v2

`schemaVersion` を 2 に。`share[bucketId]` を端末別ネストに変更:

```json
{
  "schemaVersion": 2,
  "generatedAt": "2026-05-16T17:05:00+09:00",
  "share": {
    "noon": {
      "T1": { "factor": 1.18, "source": "learning", "flightCount": 42, "dayCount": 6 },
      "T2": { "factor": 0.93, "source": "learning", "flightCount": 38, "dayCount": 6 },
      "T3": { "factor": 1.0,  "source": "unobservable" }
    }
  },
  "level": {
    "lead30": { "factor": 1.0, "source": "fallback", "n": 0 }
  }
}
```

`share` は transit-share の全 8 バケット id を必ず含み、各バケットは `T1`/`T2`/`T3` を必ず含む。`level` は D-3 から不変 (`lead30`/`lead60`/`lead120`)。

## 適用: `buildEffectiveTransitShare` の端末別化

`buildEffectiveTransitShare(transitShareMaster, corrections)` (シグネチャ不変) を端末別適用に変更する。各バケット `b` の `rates` の各 terminal `term` について:

```
factor = corrections.share[b.id][term].factor   (端末別 = v2 形状)
       または corrections.share[b.id].factor     (一律 = 旧 v1 形状)
       または 1.0                                (share 無し)
b.rates[term] *= factor
```

形状の判定: `share[b.id]` が存在し `share[b.id][term]` がオブジェクトで `factor` を持てば v2 として端末別適用。`share[b.id].factor` が数値なら v1 として一律適用。いずれでもなければ 1.0。これにより D-3 (v1) のファイルが残っていても、observe-tick が次 tick で v2 に再生成するまで安全に動作する。

`maxRatio` / `reachBoost` / `delayBoost` 等は不変。マスター非破壊。

## フロント表示: `renderCorrections` の share テーブル

`forecast.html` の「係数補正状態」セクションの share テーブルを端末別表示に変更する (`js/forecast-render.js` の `renderCorrections`)。バケットを行、`T1` / `T2` / `T3` を列とし、各セルに補正係数と状態を表示。T3 セルは「観測外」と明示。`level` テーブルは D-3 から不変。`forecast.html` 本体・`forecast-app.js` は変更不要。

## ファイル構成

| ファイル | 種別 | 役割 |
|---|---|---|
| `scripts/lib/correction-engine.mjs` | Modify | `computeShareCorrection` 端末別化、`buildEffectiveTransitShare` 端末別適用、`CORRECTION_SCHEMA_VERSION` → 2 |
| `tests/correction-engine.test.mjs` | Modify | `computeShareCorrection` / `buildEffectiveTransitShare` の share 系テストを端末別に書き直し |
| `js/forecast-render.js` | Modify | `renderCorrections` の share テーブルを T1/T2/T3 別表示に |

`observe-taxi-pool.mjs` / `fetch-arrivals.mjs` / `observe-tick-local.sh` / `forecast.html` / `forecast-app.js` は変更不要 (`computeShareCorrection` と `buildEffectiveTransitShare` のシグネチャ不変、share テーブルは `renderCorrections` が生成)。

## エラーハンドリング

| 事象 | 対応 |
|---|---|
| `terminal` が T1/T2/T3 以外・欠損の便 | 集計から除外 |
| T3 便 | 常に集計除外 (観測外)。T3 factor は 1.0 固定 |
| ある端末のバケット便数 < 20 | 当該端末・当該バケットのみ fallback |
| `coefficient-corrections.json` が旧 v1 形状 (fetch-arrivals 側) | `buildEffectiveTransitShare` が `entry.factor` を一律適用 |
| `coefficient-corrections.json` 欠損・不正 | factor 全 1.0 (現行と同一動作) |
| factor が clip 範囲外・NaN | `clipFactor` で矯正 |

## テスト方針

`tests/correction-engine.test.mjs` の share 系テストを書き直す (`node:test` + `node:assert/strict`):
- `computeShareCorrection`: snapshotRows 0 件 → 全バケット全端末 fallback / T1 便と stall1+2 outflow → T1 factor 算出 / T2 便と stall3+4 outflow → T2 factor 算出 / T3 便 → factor 1.0・source "unobservable" / 端末別の便数不足で当該端末のみ fallback / 当日データ無視
- `buildEffectiveTransitShare`: v2 形状 (端末別) → rates が端末別に乗算 / 旧 v1 形状 → 一律乗算 / corrections 無し → マスターのコピー / マスター非破壊

`applyLevelCorrection` / `computeLevelCorrection` / `clipFactor` のテストは D-3 から変更なし。完了条件: `npm test` 全件パス (389 → 約389、share テストは件数を保ちつつ内容を更新)。

## スコープ外 (D-5 以降)

- **flightFactor からの T3 便除外**: T3 が別プールである以上、観測プール (T1+T2) の forecast の `flightFactor` に T3 便を含めるのは本来ノイズ。`forecast-engine.mjs` の `computeForecast` 改修となり D-4 スコープ外。別途検討する。
- `forecast-engine.mjs` / `pattern-matcher.mjs` / `accuracy-evaluator.mjs` / `ensemble-engine.mjs` / `transit-share.json` は不変
- Stage 2 (level 補正) は D-3 から不変
- stall 個別 (stall1 と stall2 を分ける等) の補正

## 完了条件

- `npm test` 全件パス (389 件、share テストは内容更新)
- `computeShareCorrection` が端末別 (T1/T2/T3) の補正係数を返す
- `buildEffectiveTransitShare` が端末別に rates を補正、旧 v1 形状も許容
- `coefficient-corrections.json` の `schemaVersion` が 2、`share[bucket]` が T1/T2/T3 ネスト
- T3 factor は常に 1.0・`source: "unobservable"`
- `forecast.html`「係数補正状態」の share テーブルが端末別表示
- スコープ外ファイル (`forecast-engine.mjs` / `pattern-matcher.mjs` / `accuracy-evaluator.mjs` / `ensemble-engine.mjs` / `transit-share.json`) は不変
- 観測 jsonl 追記との衝突なし
