# 機材不明便のフォールバック補完 設計

- 日付: 2026-05-10
- 対象: 乗務地図関係 / 到着便ビューワー (`arrivals.html`)
- 親プロジェクト: 「乗務ツールの指針チューニング」シリーズの第 1 サブプロジェクト

## 背景

ODPT API の `aircraftType` フィールドは ANA 国際線の一部便で `(MISSING)` (フィールド欠損) として返ってくる。現状 47 便がこれに該当し、便番号 NH101〜NH972 の国際線がすべて該当する (北米・欧州・アジア・中国主要路線)。

これらの便は `pax-estimator.mjs` で `seatCount: null` 扱いとなり、`estimatedPax: null` (推定降客数算出不可) になっている。結果、ヒートマップ上で「機材不明」が大量発生し、47 便ぶんのタクシー候補数推定が機能しない状態。

ODPT が `aircraftType` を返さなくても、**ANA 公式時刻表には便番号ごとの運航機材が明記されている**。一次情報を取り込めば 100% 補完可能。

## ゴール

- ANA 国際線 47 便すべてで `estimatedPax` が算出される状態にする
- 将来 ANA が新路線を開設した場合も、路線フォールバックで自動的にカバーする (= 100% 網羅率を維持)
- 国際線専用座席数 (3 クラス構成) を反映し、推定精度を一段上げる

## 非ゴール

- 国内線便の機材精度向上 (既に 100% 判明)
- JAL 便の補完 (既に 100% 判明)
- 過去 ODPT 履歴を用いた機材学習
- 季節性 (load factor / taxi share) の補正 — 別 spec で扱う
- 国際線の load factor を国際線専用値に変える (現状の `default 0.70` で運用)

## アーキテクチャ

### 不変点

| ファイル | 状態 |
|---|---|
| `arrivals.html` / `js/arrivals-app.js` / `js/arrivals-data.js` / `js/arrivals-render.js` | 不変 |
| `transformArrivals` の出力スキーマ | 不変 |
| `AIRCRAFT_CODE_ALIASES` (24 エントリ、IATA → ICAO 風キー) | 不変 |
| 国内線便の `estimatedPax` 算出ロジック | 不変 |
| `flight.aircraftCode` 出力フィールド | フロント描画の「機材不明」判定を維持するため、ODPT 元コード (null 含む) のまま透過 |

### 変更ファイル

| ファイル | 種別 | 役割 |
|---|---|---|
| `data/aircraft-seats.json` | Modify | 国際線専用 4 エントリ (B77W-INT 等) を追加 |
| `data/aircraft-by-flight-number.json` | Create | 47 便の `flightNumber → aircraftCode` 辞書 |
| `data/aircraft-by-route.json` | Create | 出発空港 → 典型機材 のフォールバック辞書 |
| `scripts/lib/pax-estimator.mjs` | Modify | フォールバックチェーン追加 (便番号 → 路線) |
| `scripts/lib/arrival-transformer.mjs` | Modify | 第 5 引数 `aircraftFallback` を `pax-estimator` に渡す配線 |
| `scripts/fetch-arrivals.mjs` | Modify | 新 master 2 ファイルを読み込み |
| `scripts/generate-mock-arrivals.mjs` | Modify | 同上 |
| `tests/pax-estimator.test.mjs` | Modify | フォールバック検証テスト追加 |

## データ構造

### `data/aircraft-by-flight-number.json` (新規)

```json
{
  "_meta": {
    "source": "ANA 公式時刻表 (anatravel.com / ana.co.jp/international)",
    "scope": "ODPT API で aircraftType=(MISSING) が返る ANA 国際線便を補完",
    "updated": "2026-05-10",
    "note": "ANA 季節ダイヤ改正 (3月末/10月末) で要見直し"
  },
  "flights": {
    "NH101": "B77W-INT",
    "NH107": "B77W-INT",
    "...": "..."
  }
}
```

47 便すべてを実装フェーズで埋める。

### `data/aircraft-by-route.json` (新規)

```json
{
  "_meta": {
    "source": "ANA 国際線航続距離別の典型機材 (公式運航パターン)",
    "scope": "便番号辞書にない便のフォールバック",
    "updated": "2026-05-10",
    "note": "新路線が追加された場合の自動カバー用。便番号辞書より優先度低"
  },
  "routes": {
    "JFK": "B77W-INT",
    "LAX": "B789-INT",
    "BKK": "B789-INT",
    "HKG": "B788-INT",
    "GMP": "A321-INT",
    "...": "..."
  }
}
```

47 便で出現する 33 路線を網羅する。

### `data/aircraft-seats.json` (拡張)

既存 14 エントリは不変。国際線専用 4 エントリを追加:

```json
{
  "B77W-INT": { "name": "Boeing 777-300ER (国際線仕様)", "seats": 264 },
  "B789-INT": { "name": "Boeing 787-9 (国際線仕様)", "seats": 215 },
  "B788-INT": { "name": "Boeing 787-8 (国際線仕様)", "seats": 184 },
  "A321-INT": { "name": "Airbus A321neo (国際線仕様)", "seats": 146 }
}
```

座席数は ANA 公式機材ページの国際線 (3 クラス構成 ファースト/ビジネス/プレミアムエコノミー/エコノミー) 標準値。

## ロジック設計

### フォールバックチェーン

`estimatePax(flight, seatsMaster, factorsMaster, aircraftFallback)` の挙動:

```
1. AIRCRAFT_CODE_ALIASES[flight.aircraftCode] でエイリアス解決
2. resolvedCode が seatsMaster にヒット
   → 既存通り計算して return
3. ヒットしない場合 (= 機材不明)
   3a. aircraftFallback.byFlightNumber[flight.flightNumber] を引く
   3b. それでもヒットしなければ aircraftFallback.byRoute[flight.from] を引く
   3c. ヒットしたコードで seatsMaster を引いて estimatedPax を計算
   3d. 全部ミス → 既存通り { seatCount: null, ..., estimatedPax: null }
```

`flight.aircraftCode` フィールドは **元コード (null 含む) のまま透過**。フロント側の「機材不明」表示判定 (`f.aircraftCode === null`) は変わらない。ただし `estimatedPax` が埋まるので、便リストには「機材不明 / 約 200 人」のような表示になる。

### `transformArrivals` の signature

```javascript
// 旧
transformArrivals(odptResponse, seatsMaster, factorsMaster, taxiOpts)

// 新
transformArrivals(odptResponse, seatsMaster, factorsMaster, taxiOpts, aircraftFallback)
```

`aircraftFallback` は `{ byFlightNumber: object, byRoute: object }` の形。`null` 渡し時は従来通り (フォールバックなし、既存テストの互換性維持)。

`estimatePax` の呼び出し時に第 4 引数として `aircraftFallback` をリレーする。

### `loadFactorSource`

フォールバックでも `loadFactor` は通常通り `from` ベース (factorsMaster.routes に該当があれば route、なければ default)。`loadFactorSource` は `'route'` または `'default'` のまま。新たな値 (`'fallback'` 等) は導入しない。

## データフロー

```
[Action workflow_dispatch]
  └→ fetch-arrivals.mjs
       ├→ data/aircraft-seats.json  load
       ├→ data/load-factors.json    load
       ├→ data/aircraft-by-flight-number.json  load (新)
       ├→ data/aircraft-by-route.json          load (新)
       ├→ ODPT API (7 オペレータ並列)
       └→ transformArrivals(odptResponse, seatsMaster, factorsMaster, taxiOpts, aircraftFallback)
            └→ flights.map(item => estimatePax(flight, seatsMaster, factorsMaster, aircraftFallback))
                 ├→ 通常パス: AIRCRAFT_CODE_ALIASES → seatsMaster → 結果
                 └→ フォールバックパス: byFlightNumber → byRoute → seatsMaster → 結果
```

mock 生成 (`generate-mock-arrivals.mjs`) も同じ master を読んで transformArrivals に渡す。

## テスト計画

### 新規ユニットテスト (`tests/pax-estimator.test.mjs` に追加)

```
- aircraftCode null + flightNumber が辞書ヒット → seatCount = 国際線仕様
- aircraftCode null + flightNumber 辞書ミス + from 路線辞書ヒット → seatCount = 路線フォールバック値
- aircraftCode null + 両方ミス → seatCount = null (既存動作維持)
- aircraftCode "(MISSING)" 文字列 → エイリアス未ヒット → フォールバック発動
- aircraftCode "B789" 判明 → 辞書を参照しない (既存動作維持、回帰テスト)
- aircraftFallback 引数なし → 全便で既存動作 (互換性確認)
```

### 既存テスト

- `tests/arrival-transformer.test.mjs`: signature 変更で `aircraftFallback` を null で渡すよう更新。既存の振る舞いは保つ。
- `npm test` 全件パス必須。

### 検証

実データで `unknownAircraft` (estimatedPax=null になる便数) を計測:
- 改修前: 46〜47 件
- 改修後: 0 件 (47 便すべてが seatCount を取得)

## エラーハンドリング

| 事象 | 対応 |
|---|---|
| 便番号辞書ファイル読み込み失敗 | warn ログ、空オブジェクトで動作続行 (既存動作にフォールバック) |
| 路線辞書ファイル読み込み失敗 | 同上 |
| 便番号辞書のキーに不正なコード (例: typo `B77W-IN`) | seatsMaster ミスでフォールバック先継続。最終的に null なら既存通り |
| ANA が新路線を開設し、いずれの辞書にもない | 路線辞書をメンテナンスする運用フロー (季節改正タイミング) |

## メンテナンス運用

- ANA 季節ダイヤ改正は年 2 回 (3 月末・10 月末)
- そのタイミングで `data/aircraft-by-flight-number.json` の `_meta.updated` を見直す
- 新便が現れたら ODPT から `(MISSING)` で来るので、既存の運用 → 「機材不明便が増えた」シグナル → 辞書更新、というサイクル
- 路線辞書はより安定 (新路線開設の頻度は低い)

## リスク

| リスク | 確度 | 影響 | 対応 |
|---|---|---|---|
| ANA が便番号は同じだが機材を変更 (B77W → B789 等) | 中 | 推定座席数が 50 席ずれる → 推定降客数 ±35 人/便 | 季節改正タイミングで見直し |
| 国際線専用座席数 (3 クラス) も実機により幅がある (例 B77W = 244〜294 席) | 中 | ±20 席 → ±15 人 | ANA 公式仕様の中央値を採用、運用で許容 |
| 路線フォールバックが粗すぎる (BKK 線が B789 と B788 混在等) | 低 | 機材不明便でのみ発動するエッジケース | 便番号辞書の精度を上げて発動回数を減らす |
| 47 便の機材調査時、ANA 公式の表記が `B77W` 形式で来ない (例 `Boeing 777-300ER`) | 低 | 調査時に手動正規化 | テストで正規化結果を担保 |

## ロールバック

実装後に問題発生時:

```bash
# 1. 新規 data ファイル 2 つを削除
git rm data/aircraft-by-flight-number.json data/aircraft-by-route.json

# 2. 既存ファイルを HEAD~ で戻す
git checkout HEAD~1 -- data/aircraft-seats.json scripts/lib/pax-estimator.mjs scripts/lib/arrival-transformer.mjs scripts/fetch-arrivals.mjs scripts/generate-mock-arrivals.mjs tests/pax-estimator.test.mjs

# 3. commit
git commit -m "revert: aircraft fallback complement"
```

47 便ぶんは再び `estimatedPax: null` に戻るが、フロント側の表示は壊れない (既存ロジックそのまま)。

## 完了条件

- 本番 URL で `arrivals.html` を開いた時、`stats.unknownAircraft` (UI 上「機材不明: N便」表示) が **mock + 実データ運用** で 0 になる (mock データに機材不明便を含めない場合)
- もしくは ANA 国内線が機材未登録の特殊ケース時のみ 1〜2 件 (実用上ゼロに近い)
- 47 便すべてで `f.estimatedPax` が非 null になる
- `npm test` 全件パス
- `data/aircraft-by-flight-number.json` の `_meta.source` に出典 URL が明記されている
