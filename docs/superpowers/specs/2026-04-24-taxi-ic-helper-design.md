# タクシー乗務 IC判定 Web アプリ — 設計ドキュメント

- **作成日**: 2026-04-24
- **ステータス**: 設計承認済み（次: 実装プラン）
- **対象ユーザー**: 1人（作成者自身、タクシー乗務員）
- **公開方式**: Public GitHub Pages（自分用、他者URL共有は原則しない）

---

## 1. 目的

乗務中、帰りの空車で首都高に戻る際に「どのICから乗れば高速代が**会社負担**になるか／この区間で**控除距離**が何km発生するか」を一目で判定するWebアプリ。実地図ではなく、首都高＋周辺高速を簡略化したSVG路線図で表示する。

### 会計の前提（運用ルール）

3つの独立した概念：

| 区分 | 単位 | 意味 |
|---|---|---|
| **会社負担** | 円 | 高速代を会社が出す。運転手の自腹ゼロ |
| **自己負担** | 円 | 高速代は運転手の自腹 |
| **控除距離** | km | 法定1日走行上限365kmに加算される距離。「首都高より外の区間」を走った距離 |

**会社負担 ⟂ 控除距離**（独立）。1ルートに両方つくこともある。

### スコープ

- **対象シーン**: 帰りの空車運転（行きは客が高速代負担なので対象外）
- **対象エリア**: 首都高起点で片道 **180km圏内**
- **1人用アプリ**: 認証は不要、URL は自己管理

---

## 2. 会社負担ルール（確定仕様）

### ルール1: 指定8入口 + それより東京外側からの戻り

指定8入口：**中台・新郷・加平・四ツ木・舞浜・錦糸町・永福・汐入**

これら **自身 + それより東京の外側にある首都高接続IC** から首都高に戻る → 首都高区間は会社負担。

### ルール2: 湾岸環八降車（羽田戻りパターン）

**アクアライン / 横浜方面** から戻って **湾岸環八IC** で降車 → 会社負担。

### ルール3: 外環道は経路依存

| パターン | 外側本線 | 外環区間 | 首都高区間 |
|---|---|---|---|
| 外環直乗り（大泉IC等から） | — | **自己負担** | 自己負担 |
| 常磐道 → 外環 → 首都高 | 会社負担 | **会社負担** | 会社負担 |
| 東北道 → 外環 → 首都高 | 会社負担 | **会社負担** | 会社負担 |
| 関越道 → 外環 → 首都高 | 会社負担 | **会社負担** | 会社負担 |

（東名 → 外環 → 首都高 のルートは実質的に存在しない）

---

## 3. 控除距離ルール（確定仕様）

### 核心

**控除距離 = 首都高より外の区間を走行した距離**

画像2（社内「有料道路控除距離表」）の各方面の表の数値 = 基準点IC（首都高との接続IC）から当該ICまでの外区間距離（km）。

### 計算式

片道控除km を `A = 入口IC`、`B = 出口IC` から算出：

| 状態 | 控除km（片道） |
|---|---|
| A=外, B=内（首都高内 or 基準点） | 表[A] |
| A=内, B=外 | 表[B] |
| A=外, B=外（同方面、同じ側） | `|表[A] − 表[B]|` |
| A=内, B=内 | 0 |
| A/B 異方面 | 0（or 警告） |

往復時は ×2。

### 基準点IC一覧

| 方面 | 基準点 |
|---|---|
| 東名方面 | 東京IC |
| 中央道方面 | 高井戸IC |
| 関越方面 | 練馬IC |
| 東北方面 | 川口JCT |
| 常磐方面 | 三郷JCT |
| 第三京浜方面 | 玉川IC |
| 京葉方面 | 篠崎 |
| 東関東方面 | 湾岸市川 |
| アクア方面 | 浮島JCT |
| 横浜横須賀 | 藤沢 / 逗子 / 横須賀 / 衣笠 |
| 神奈川方面 | 横羽線経由 / 狩場線経由 / 湾岸線経由 で分岐 |

---

## 4. アーキテクチャ

### 技術スタック

- **フロントエンド**: Vanilla JavaScript（ビルド不要、ES Modules）
- **地図**: SVG 路線図（自作、直線＋円弧で簡略化）
- **地図ライブラリ**: 不使用（Leaflet/Mapbox/MapLibre は採用せず）
- **データ**: 静的 JSON ファイル（fetch で読み込み）
- **ホスティング**: GitHub Pages（Public）
- **PWA**: v0.3 で Service Worker 追加（オフライン対応）

### ディレクトリ構成

```
taxi-ic-helper/
├── index.html
├── css/style.css
├── js/
│   ├── app.js               # 画面状態管理
│   ├── geo.js               # GPS取得・haversine・最寄IC計算
│   ├── judge.js             # 会社負担/控除距離/総距離 判定
│   ├── map-svg.js           # SVGハイライト制御・経路描画
│   └── search.js            # 手動入力候補検索
├── data/
│   ├── ics.json             # IC定義
│   ├── routes.json          # 路線図エッジ・外環経由マップ
│   ├── deduction.json       # 控除距離表（画像2）
│   ├── shutoko_distances.json  # 首都高内距離表
│   ├── gaikan_distances.json   # 外環区間距離表
│   └── company-pay.json     # 会社負担ルール
├── svg/
│   └── map.svg              # 路線図本体（インラインで index.html に埋め込み）
├── manifest.json            # PWA（v0.3）
├── sw.js                    # Service Worker（v0.3）
└── README.md                # 運用前提・免責・ルール説明
```

### データフロー

```
[GPS watchPosition] → geo.js.updateCurrent()
     → geo.js.findNearestICs(lat, lng, 5)
     → UI: 入口候補プルダウン更新
     → ユーザーが入口/出口/外側本線を選択 (or デフォルト)
     → judge.js.judgeRoute({ outerRoute, entryIc, exitIc, roundTrip })
         └ segments: [{ pay, deductionKm, distanceKm }, ...]
         └ totals: { paySummary, deductionKm..., distanceKm... }
     → DOM: バッジ + 区間内訳 + SVG経路ハイライト
```

---

## 5. データモデル

### `data/ics.json`

```json
{
  "version": 1,
  "ics": [
    {
      "id": "kahei",
      "name": "加平",
      "kana": "かへい",
      "route": "6",
      "route_name": "三郷線",
      "gps": { "lat": 35.7760, "lng": 139.8245 },
      "svg": { "x": 690, "y": 430 },
      "entry_type": "both",
      "boundary_tag": "company_pay_entry"
    }
  ]
}
```

**`boundary_tag` の値**:
- `"company_pay_entry"`: 8入口 + それより東京外側の首都高接続IC
- `"wangan_kanpachi"`: 湾岸環八IC
- `"gaikan"`: 外環道IC
- `null`: 都心側／無関係

### `data/deduction.json`

```json
{
  "directions": [
    {
      "id": "tomei",
      "name": "東名方面",
      "baseline": { "ic_id": "tokyo_ic", "ic_name": "東京IC" },
      "entries": [
        { "ic_id": "tomei_kawasaki", "name": "川崎", "km": 7.7 },
        { "ic_id": "yokohama_aoba",  "name": "横浜青葉", "km": 13.3 }
      ]
    }
  ]
}
```

### `data/shutoko_distances.json` / `gaikan_distances.json`

```json
{
  "entries": [
    { "from": "kinshicho", "to": "kasumigaseki", "km": 8.5 },
    { "from": "maihama",   "to": "kasumigaseki", "km": 15.2 }
  ]
}
```

### `data/company-pay.json`

```json
{
  "rules": [
    {
      "id": "rule_8entries_and_outer",
      "description": "指定8入口 + それより東京外側のICから首都高に戻る",
      "applies_via": "entry_boundary_tag:company_pay_entry"
    },
    {
      "id": "rule_wangan_kanpachi",
      "description": "アクア/横浜方面からの羽田戻り湾岸環八降車",
      "applies_via": "exit_id:wangan_kanpachi AND outer_route IN [aqua,tateyama,yokohama]"
    },
    {
      "id": "rule_outer_via_gaikan",
      "description": "外側本線→外環→首都高 は全区間会社負担",
      "applies_via": "outer_route IN [joban,tohoku,kanetsu] AND via:gaikan"
    }
  ]
}
```

### `data/routes.json`

```json
{
  "edges": [
    { "from": "tokyo_ic", "to": "tomei_kawasaki",
      "route": "tomei", "via": "line", "svg_path": "..." }
  ],
  "needs_gaikan_transit": {
    "tohoku":  true,
    "joban":   "optional",
    "kanetsu": "optional",
    "tomei":   false,
    "chuo":    false,
    "aqua":    false,
    "yokohama": false
  }
}
```

---

## 6. 判定ロジック

### 入力

```ts
type Input = {
  outerRoute: 'tomei' | 'chuo' | 'kanetsu' | 'tohoku' | 'joban'
            | 'keiyo' | 'tokan' | 'aqua' | 'tateyama' | 'yokohama'
            | 'gaikan_direct'   // 外環のICから直乗り
            | 'none';           // 首都高内のみ
  entryIc: IC;
  exitIc: IC;
  roundTrip: boolean;
};
```

### 出力

```ts
type Output = {
  segments: Array<{
    name: string;
    route: string;
    pay: 'company' | 'self';
    deductionKm: number;
    distanceKm: number;
  }>;
  totals: {
    paySummary: 'all_company' | 'mixed' | 'all_self';
    deductionKmOneway: number;
    deductionKmRoundtrip: number;
    distanceKmOneway: number;
    distanceKmRoundtrip: number;
  };
};
```

### 擬似コード

```js
function judgeRoute({ outerRoute, entryIc, exitIc, roundTrip }) {
  const OUTER = ['tomei','chuo','kanetsu','tohoku','joban',
                 'keiyo','tokan','aqua','tateyama','yokohama'];
  const isOuter = OUTER.includes(outerRoute);
  const viaGaikan = routesData.needsGaikanTransit(outerRoute, entryIc)
                 || outerRoute === 'gaikan_direct';

  const segs = [];

  if (isOuter) {
    const ded = lookupDeduction(entryIc);
    segs.push({
      name: routesData.label(outerRoute),
      route: outerRoute,
      pay: 'company',
      deductionKm: ded?.km ?? 0,
      distanceKm: ded?.km ?? 0
    });
  }

  if (viaGaikan) {
    segs.push({
      name: '外環道',
      route: 'gaikan',
      pay: isOuter ? 'company' : 'self',
      deductionKm: 0,
      distanceKm: lookupGaikanDistance(entryIc, exitIc) ?? 0
    });
  }

  segs.push({
    name: '首都高',
    route: 'shutoko',
    pay: computeShutokoPay({ outerRoute, entryIc, isOuter }),
    deductionKm: 0,
    distanceKm: lookupShutokoDistance(entryIc, exitIc) ?? 0
  });

  // ルール2上書き: 湾岸環八降車
  if (exitIc.id === 'wangan_kanpachi' &&
      ['aqua','tateyama','yokohama'].includes(outerRoute)) {
    last(segs).pay = 'company';
  }

  return { segments: segs, totals: aggregate(segs, roundTrip) };
}

function computeShutokoPay({ outerRoute, entryIc, isOuter }) {
  if (isOuter) return 'company';
  if (outerRoute === 'gaikan_direct') return 'self';
  return entryIc.boundary_tag === 'company_pay_entry' ? 'company' : 'self';
}
```

### 最寄IC計算

```js
function findNearestICs(currentGps, allICs, n = 5) {
  return allICs
    .map(ic => ({ ic, dist: haversine(currentGps, ic.gps) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, n);
}
```

### デフォルト出口決定

```js
function defaultExitIc(currentGps) {
  const kukou = ic('kukou_chuou');
  const wangan = ic('wangan_kanpachi');
  return haversine(currentGps, kukou.gps) < haversine(currentGps, wangan.gps)
    ? kukou : wangan;
}
```

GPS 拒否時の初期値は `wangan_kanpachi`。

---

## 7. UI 設計

### 画面レイアウト（縦スクロール、モバイル最適化）

```
┌──────────────────────────────────────────┐
│ 📍 市川市 ±12m  [再取得]  [GPSオフ]      │ ← ヘッダー（細）
├──────────────────────────────────────────┤
│ 🔀 どこから戻る？: [常磐道 ▾] [外環経由✓] │
│                                          │
│ 🚪 入口IC:  [🔍 柏IC  ▾]                 │ ← メイン操作
│       └ GPS近い順: 柏 1.8km / 流山 3.2km  │
│                                          │
│ 🏁 出口IC:  [湾岸環八 ▾] (自動)          │
│                                          │
│ 💴 🟢 全区間 会社負担                     │ ← 判定バッジ（特大 48pt+）
│ 🛣 控除: 往復 12.2km                     │
│ 📏 総距離: 往復 57.6km                   │
│                                          │
│ [区間内訳 ▾]                             │
│   ┌ 常磐道 (柏→三郷JCT)  🟢 会社 6.1km / 控除+6.1km │
│   ├ 外環 (三郷→美女木)   🟢 会社 10.2km / 控除 0 │
│   └ 首都高 (美女木→霞ヶ関) 🟢 会社 12.5km / 控除 0│
├──────────────────────────────────────────┤
│ [ SVG 路線図 (経路ハイライト) ]           │
│   経路の3セグメントを色線で強調           │
└──────────────────────────────────────────┘
```

### 表示規則

- **色**: 🟢緑=会社負担 / ⚫灰=自己負担（控除なし）/ 🔵青=自己負担（控除あり）
- **色＋絵文字＋テキスト併置**（色覚多様性対応）
- **ダークモードデフォルト**（運転席での白飛び回避）
- 判定バッジ最小 40px、タップ領域最小 44×44px
- フォントサイズ最小 16px

### 現在地取得

- `navigator.geolocation.watchPosition` で連続監視
- オプション: `enableHighAccuracy: true`, `maximumAge: 5000`, `timeout: 10000`
- `pos.coords.accuracy > 100m` のサンプルは UI 更新しない
- 精度はヘッダーに `±Xm` 表示

### 手動入力モード

- GPS 拒否/失敗時は自動で手動モード
- IC プルダウン: 路線グループで分類、部分一致サーチ付き
- SVG 路線図の IC 円を直接タップでも選択可能

---

## 8. 路線図 SVG の設計方針

### 抽象化

- 首都高都心環状（C1）= 小さい円弧
- 首都高中央環状（C2）= 大きい円弧
- 放射線（東名・中央・関越・東北・常磐・湾岸・京葉・アクア・横羽・狩場・湾岸）= 直線 or ベジエ
- 外環 = 円弧（東京の北西〜北〜東を囲む）
- IC = 円ノード、JCT = 二重円ノード
- 料金所・境界 = 色付きリング

### 座標系

- 1200 × 1200 の論理キャンバス、中心 (600, 600) を東京駅付近に
- 180km 圏内を収める縮尺、解像度は CSS で制御
- 各ノードに `id` 属性、JS で `classList` を付与してハイライト

### 作成者

- 初版は AI（僕）が実装フェーズで生成
- ノード座標は「実際のGPS座標 → 簡略化投影」または目視配置
- 首都高の形は概形で OK（正確な道路形状は不要）

---

## 9. テスト・受け入れ観点

### ゴールデンケース

| # | outerRoute | 入口 | 出口 | 期待：pay | 期待：控除km往復 |
|---|---|---|---|---|---|
| 1 | tomei | 東名川崎 | 霞ヶ関 | all_company | 15.4 |
| 2 | kanetsu | 所沢 | 霞ヶ関 | all_company | 20.8 |
| 3 | joban | 柏 | 霞ヶ関（外環なし） | all_company | 12.2 |
| 4 | joban | 柏 | 霞ヶ関（外環経由） | all_company | 12.2 |
| 5 | tohoku | 浦和 | 霞ヶ関（外環経由） | all_company | 5.4 |
| 6 | kanetsu | 所沢 | 霞ヶ関（外環経由） | all_company | 20.8 |
| 7 | gaikan_direct | 大泉 | 霞ヶ関 | 外環 self / 首都高 self | 0 |
| 8 | none | 舞浜 | 霞ヶ関 | all_company（8入口）| 0 |
| 9 | none | 葛西 | 霞ヶ関 | all_self | 0 |
| 10 | aqua | 木更津金田 | 湾岸環八 | all_company | 浮島JCT〜木更津金田の外区間km × 2（データ投入時に確定） |
| 11 | yokohama | 横浜日野 | 湾岸環八 | all_company | 藤沢〜横浜日野の外区間km × 2（データ投入時に確定） |

### エッジケース

- GPS 不許可 → 手動モードに自動フォールバック
- GPS 精度 `> 100m` → UI 更新抑制
- 対象エリア外座標 → 「対象エリア外」バッジ表示、手動継続可
- JSON ロード失敗 → 赤バナー + リロード案内
- 異方面の入口・出口 → 警告表示、控除 0

### データ妥当性検証

起動時に `ics.json` / `deduction.json` / `shutoko_distances.json` / `gaikan_distances.json` / `routes.json` の id 参照整合性をチェック。エラー時は赤バナー。

### パフォーマンス基準

- 起動から最寄IC提案: **< 3秒**
- 入口変更→判定更新: **< 200ms**
- SVG 操作: 60fps 目標

### PWA（v0.3）

- A2HS（ホーム画面追加）
- オフライン起動可能
- Service Worker による更新検知

---

## 10. 免責・運用注意（README 記載予定）

- 判定は社内ルール参考情報、最終判断は運転手自身
- 控除距離は社内「有料道路控除距離表」に基づく
- 会社負担ルールは特定1社の社内規定に基づき、他社では使用不可
- 他者への URL 共有は推奨しない
- 精度・判定ミスに起因する損害について作成者は責任を負わない

---

## 11. 版数計画

| 版 | 内容 |
|---|---|
| v0.1 | 判定ロジック完成 + 手動入力UI + 画像2の全方面JSON投入 + 首都高内距離/外環距離JSON投入 + SVG路線図（主要IC約80〜120ノード） + 区間別判定バッジ |
| v0.2 | GPS連動（watchPosition）、最寄IC自動推定、デフォルト出口自動設定、SVG上のパン/ズーム、精度表示 |
| v0.3 | PWA化（manifest + service worker）、A2HS対応、オフライン起動、ルート候補の最適化提案（控除を伸ばす代替案） |

---

## 12. 付録：指定8入口と都心側出口IC

### 会社負担の対象となる首都高入口（8入口）

中台・新郷・加平・四ツ木・舞浜・錦糸町・永福・汐入
（+ これらより東京外側の首都高接続IC全て）

### 代表的な都心側出口IC

霞ヶ関・外苑・飯倉・神田橋・箱崎・銀座・京橋・芝浦・目黒・荏原・戸越・永福・三軒茶屋・玉川・東京IC
