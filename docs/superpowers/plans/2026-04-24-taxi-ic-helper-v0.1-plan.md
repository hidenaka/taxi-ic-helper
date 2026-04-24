# タクシー乗務 IC判定 Web アプリ v0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 手動入力で「入口IC／出口IC／外側本線」を選ぶと、会社負担／自己負担の区間別判定と控除距離・総走行距離が一目でわかるVanilla JS + SVGの単一ページアプリ v0.1 を完成させる（GPS連動は v0.2、PWA化は v0.3 で別プラン）。

**Architecture:** 静的ファイルのみで動作（index.html + CSS + ES Modules JS + JSON データ + インラインSVG）。ビルドステップなし、GitHub Pages に直置き。データは `data/*.json` に分離、判定ロジックは純関数で `judge.js` に集約。テストは Node.js 組み込み `node:test` モジュールで実行、外部テストランナー不要。

**Tech Stack:** Vanilla JavaScript (ES2022, ES Modules), HTML5, CSS3, SVG, node:test (dev only), GitHub Pages.

---

## ファイル構造

```
taxi-ic-helper/
├── index.html                       # 単一ページ、SVG をインライン埋め込み
├── css/
│   └── style.css                    # ダークモードベース、フォント・配色定義
├── js/
│   ├── app.js                       # エントリポイント、状態管理、DOM配線
│   ├── judge.js                     # 判定ロジック（pure function 群）
│   ├── map-svg.js                   # SVGノードのハイライト操作
│   ├── data-loader.js               # JSON の fetch とスキーマ検証
│   └── util.js                      # haversine 等の共通関数
├── data/
│   ├── ics.json                     # IC定義（GPS, SVG座標, boundary_tag）
│   ├── deduction.json               # 画像2の控除距離表（全方面）
│   ├── shutoko_distances.json       # 首都高内 IC↔IC 距離
│   ├── gaikan_distances.json        # 外環 JCT↔JCT 距離
│   ├── routes.json                  # 路線定義・needs_gaikan_transit マップ
│   └── company-pay.json             # 会社負担ルール（宣言的に記述）
├── svg/
│   └── map.svg                      # 参照用（index.html インライン化後は不要、ソース保持）
├── tests/
│   ├── judge.test.js                # 判定ロジックのゴールデンケース
│   ├── data-integrity.test.js       # JSON id 参照整合性
│   ├── util.test.js                 # haversine 等
│   └── helpers.js                   # テストユーティリティ（JSONロード等）
├── package.json                     # dev only: test スクリプトのみ
├── .nojekyll                        # GitHub Pages で Jekyll バイパス
└── README.md                        # 運用前提・免責・ルール要約
```

**責務分割**
- `judge.js`: 入出力が明確な純関数のみ。副作用なし、DOM触らない
- `app.js`: DOM/状態/UI配線のみ。ビジネスロジックを持たない
- `map-svg.js`: SVG 要素への class 付与/剥がしのみ。計算は `judge.js`
- `data-loader.js`: JSON fetch + 参照整合性検証。ロード後は `app.js` に流す

---

## Task 1: プロジェクト雛形と package.json

**Files:**
- Create: `package.json`
- Create: `.nojekyll`
- Create: `.gitignore`（追記）

- [ ] **Step 1: `package.json` を作成**

```json
{
  "name": "taxi-ic-helper",
  "version": "0.1.0",
  "description": "Taxi driver's IC helper: company-pay / deduction-distance judge",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test tests/",
    "serve": "python3 -m http.server 8000"
  },
  "license": "UNLICENSED"
}
```

- [ ] **Step 2: `.nojekyll` を空ファイルで作成**

```bash
touch .nojekyll
```

- [ ] **Step 3: `.gitignore` に追記**

既存 .gitignore の末尾に以下を追加（docs プロジェクトとの衝突なし）：
```
# taxi-ic-helper runtime
taxi-ic-helper/node_modules/
```

- [ ] **Step 4: コミット**

```bash
git add package.json .nojekyll .gitignore
git commit -m "feat: scaffold taxi-ic-helper package structure"
```

---

## Task 2: README 骨格

**Files:**
- Create: `README.md`

- [ ] **Step 1: README を書く**

```markdown
# タクシー乗務 IC判定 Web アプリ

帰りの空車で首都高に戻る際、どのICから乗れば**会社負担**になるか／**控除距離**が何km発生するかを一目で判定する個人用ツール。

## 運用前提（重要）

- 判定は社内ルールに基づく**参考情報**。最終判断は運転手自身。
- 会社負担ルールは**特定1社の社内規定**に基づく。他社では利用不可。
- 控除距離は社内「有料道路控除距離表」に基づく。
- 他者への URL 共有は推奨しない。

## 免責

精度・判定ミス等に起因する損害について、作成者は責任を負わない。

## ローカルで動かす

```bash
npm run serve
# → http://localhost:8000/
```

## テスト

```bash
npm test
```

## ディレクトリ

- `index.html` — エントリポイント
- `js/judge.js` — 判定ロジック
- `data/*.json` — IC・距離・ルール定義
- `tests/` — `node:test` ベースのユニットテスト
- `docs/superpowers/specs/` — 設計ドキュメント
```

- [ ] **Step 2: コミット**

```bash
git add README.md
git commit -m "docs: add README with operational notes and disclaimers"
```

---

## Task 3: `util.js` と haversine（TDD）

**Files:**
- Create: `tests/util.test.js`
- Create: `js/util.js`

- [ ] **Step 1: 失敗するテストを書く**

`tests/util.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert';
import { haversineKm } from '../js/util.js';

test('haversineKm: 東京駅 → 新宿駅 は約 6km', () => {
  const tokyo = { lat: 35.6812, lng: 139.7671 };
  const shinjuku = { lat: 35.6896, lng: 139.7006 };
  const d = haversineKm(tokyo, shinjuku);
  assert.ok(d > 5.5 && d < 6.5, `expected ~6km, got ${d}`);
});

test('haversineKm: 同一点は 0km', () => {
  const p = { lat: 35.0, lng: 139.0 };
  assert.strictEqual(haversineKm(p, p), 0);
});
```

- [ ] **Step 2: テストを走らせて失敗を確認**

```bash
npm test
```

Expected: FAIL（`js/util.js` が存在しない）

- [ ] **Step 3: 最小実装**

`js/util.js`:
```js
const EARTH_RADIUS_KM = 6371;

export function haversineKm(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2
          + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}
```

- [ ] **Step 4: テストを走らせて成功を確認**

```bash
npm test
```

Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add tests/util.test.js js/util.js
git commit -m "feat(util): add haversineKm with tests"
```

---

## Task 4: `ics.json` 最小版と スキーマテスト

**Files:**
- Create: `data/ics.json`
- Create: `tests/helpers.js`
- Create: `tests/data-integrity.test.js`

- [ ] **Step 1: テストヘルパーを作る**

`tests/helpers.js`:
```js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadJson(relPath) {
  return JSON.parse(readFileSync(join(root, relPath), 'utf8'));
}
```

- [ ] **Step 2: データ整合性の失敗テストを書く**

`tests/data-integrity.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert';
import { loadJson } from './helpers.js';

test('ics.json: すべてのICに id / name / gps が揃っている', () => {
  const { ics } = loadJson('data/ics.json');
  assert.ok(Array.isArray(ics) && ics.length > 0, 'ics must be a non-empty array');
  for (const ic of ics) {
    assert.ok(ic.id, `missing id: ${JSON.stringify(ic)}`);
    assert.ok(ic.name, `missing name: ${ic.id}`);
    assert.ok(ic.gps && typeof ic.gps.lat === 'number' && typeof ic.gps.lng === 'number',
              `missing gps: ${ic.id}`);
  }
});

test('ics.json: id は一意', () => {
  const { ics } = loadJson('data/ics.json');
  const ids = ics.map(x => x.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'duplicate ids found');
});
```

- [ ] **Step 3: テストを走らせて失敗を確認**

```bash
npm test
```

Expected: FAIL（`data/ics.json` が存在しない）

- [ ] **Step 4: `data/ics.json` の最小版（都心代表＋8入口）を作る**

`data/ics.json`:
```json
{
  "version": 1,
  "generated_at": "2026-04-24",
  "ics": [
    { "id": "kasumigaseki", "name": "霞ヶ関", "route": "C1", "route_name": "都心環状線",
      "gps": { "lat": 35.6730, "lng": 139.7495 }, "svg": { "x": 600, "y": 600 },
      "entry_type": "both", "boundary_tag": null },
    { "id": "tokyo_ic", "name": "東京IC", "route": "tomei", "route_name": "東名高速",
      "gps": { "lat": 35.6089, "lng": 139.6374 }, "svg": { "x": 500, "y": 700 },
      "entry_type": "both", "boundary_tag": null },
    { "id": "nakadai", "name": "中台", "route": "5", "route_name": "池袋線",
      "gps": { "lat": 35.7687, "lng": 139.6820 }, "svg": { "x": 500, "y": 380 },
      "entry_type": "both", "boundary_tag": "company_pay_entry" },
    { "id": "shingo", "name": "新郷", "route": "S1", "route_name": "川口線",
      "gps": { "lat": 35.7925, "lng": 139.7693 }, "svg": { "x": 620, "y": 340 },
      "entry_type": "both", "boundary_tag": "company_pay_entry" },
    { "id": "kahei", "name": "加平", "route": "6", "route_name": "三郷線",
      "gps": { "lat": 35.7760, "lng": 139.8245 }, "svg": { "x": 690, "y": 430 },
      "entry_type": "both", "boundary_tag": "company_pay_entry" },
    { "id": "yotsugi", "name": "四ツ木", "route": "6", "route_name": "向島線",
      "gps": { "lat": 35.7455, "lng": 139.8395 }, "svg": { "x": 700, "y": 500 },
      "entry_type": "both", "boundary_tag": "company_pay_entry" },
    { "id": "maihama", "name": "舞浜", "route": "B", "route_name": "湾岸線",
      "gps": { "lat": 35.6340, "lng": 139.8821 }, "svg": { "x": 760, "y": 650 },
      "entry_type": "both", "boundary_tag": "company_pay_entry" },
    { "id": "kinshicho", "name": "錦糸町", "route": "7", "route_name": "小松川線",
      "gps": { "lat": 35.6972, "lng": 139.8135 }, "svg": { "x": 680, "y": 560 },
      "entry_type": "both", "boundary_tag": "company_pay_entry" },
    { "id": "eifuku", "name": "永福", "route": "4", "route_name": "新宿線",
      "gps": { "lat": 35.6700, "lng": 139.6492 }, "svg": { "x": 490, "y": 610 },
      "entry_type": "both", "boundary_tag": "company_pay_entry" },
    { "id": "shioiri", "name": "汐入", "route": "K1", "route_name": "横羽線",
      "gps": { "lat": 35.5310, "lng": 139.6881 }, "svg": { "x": 530, "y": 900 },
      "entry_type": "both", "boundary_tag": "company_pay_entry" },
    { "id": "wangan_kanpachi", "name": "湾岸環八", "route": "B", "route_name": "湾岸線",
      "gps": { "lat": 35.5876, "lng": 139.7320 }, "svg": { "x": 570, "y": 800 },
      "entry_type": "both", "boundary_tag": "wangan_kanpachi" },
    { "id": "kukou_chuou", "name": "空港中央", "route": "B", "route_name": "湾岸線",
      "gps": { "lat": 35.5497, "lng": 139.7842 }, "svg": { "x": 630, "y": 870 },
      "entry_type": "both", "boundary_tag": null }
  ]
}
```

- [ ] **Step 5: テスト成功確認**

```bash
npm test
```

Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add data/ics.json tests/helpers.js tests/data-integrity.test.js
git commit -m "feat(data): add minimal ics.json with 8-entry ICs and integrity tests"
```

---

## Task 5: `deduction.json` 東名方面 + lookup テスト

**Files:**
- Create: `data/deduction.json`
- Create: `tests/judge.test.js`
- Create: `js/judge.js`

- [ ] **Step 1: 東名方面のデータと基準点IC（東京IC）を `ics.json` に既追加済であることを確認**

`data/ics.json` に `tokyo_ic` が既にある（Task 4 で追加済）。

- [ ] **Step 2: `data/deduction.json` を作成**

```json
{
  "version": 1,
  "source": "社内 有料道路控除距離表",
  "directions": [
    {
      "id": "tomei",
      "name": "東名方面",
      "baseline": { "ic_id": "tokyo_ic", "ic_name": "東京IC" },
      "entries": [
        { "ic_id": "tomei_kawasaki", "name": "川崎",    "km": 7.7 },
        { "ic_id": "yokohama_aoba", "name": "横浜青葉", "km": 13.3 },
        { "ic_id": "yokohama_machida", "name": "横浜町田", "km": 19.7 },
        { "ic_id": "ebina", "name": "海老名", "km": 26.5 },
        { "ic_id": "atsugi", "name": "厚木", "km": 35.0 },
        { "ic_id": "hadano_nakai", "name": "秦野中井", "km": 50.1 },
        { "ic_id": "oi_matsuda", "name": "大井松田", "km": 57.6 },
        { "ic_id": "gotemba", "name": "御殿場", "km": 83.7 }
      ]
    }
  ]
}
```

- [ ] **Step 3: 対応する東名方面の IC を `ics.json` に追記**

`data/ics.json` の `ics` 配列末尾（`]` の直前）に追加：
```json
    ,{ "id": "tomei_kawasaki", "name": "東名川崎", "route": "tomei", "route_name": "東名高速",
       "gps": { "lat": 35.5676, "lng": 139.6194 }, "svg": { "x": 480, "y": 770 },
       "entry_type": "both", "boundary_tag": "company_pay_entry" },
    { "id": "yokohama_aoba", "name": "横浜青葉", "route": "tomei", "route_name": "東名高速",
       "gps": { "lat": 35.5333, "lng": 139.4950 }, "svg": { "x": 360, "y": 820 },
       "entry_type": "both", "boundary_tag": "company_pay_entry" }
```

（残りの東名IC 6件も同様のパターンで追加。GPS座標は Google Maps で実測、svg座標は後で調整する想定。簡略化のため、Step 3 内で1件1行ずつ追加し、最終的に `tomei_kawasaki` / `yokohama_aoba` / `yokohama_machida` / `ebina` / `atsugi` / `hadano_nakai` / `oi_matsuda` / `gotemba` の8件すべてを `ics.json` に記載する。すべて `boundary_tag: "company_pay_entry"` で 8入口より外側扱い。）

- [ ] **Step 4: 判定テストを書く**

`tests/judge.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert';
import { loadJson } from './helpers.js';
import { lookupDeduction } from '../js/judge.js';

test('lookupDeduction: 東名川崎 は 7.7km', () => {
  const deduction = loadJson('data/deduction.json');
  const entry = lookupDeduction(deduction, 'tomei_kawasaki');
  assert.strictEqual(entry?.km, 7.7);
  assert.strictEqual(entry?.direction, 'tomei');
});

test('lookupDeduction: 基準点自体（東京IC）は null', () => {
  const deduction = loadJson('data/deduction.json');
  const entry = lookupDeduction(deduction, 'tokyo_ic');
  assert.strictEqual(entry, null);
});

test('lookupDeduction: 存在しないICは null', () => {
  const deduction = loadJson('data/deduction.json');
  assert.strictEqual(lookupDeduction(deduction, 'no_such_ic'), null);
});
```

- [ ] **Step 5: テストを走らせて失敗を確認**

```bash
npm test
```

Expected: FAIL（`js/judge.js` に `lookupDeduction` がない）

- [ ] **Step 6: `js/judge.js` を作成**

```js
export function lookupDeduction(deductionData, icId) {
  for (const dir of deductionData.directions) {
    if (dir.baseline.ic_id === icId) return null;
    const entry = dir.entries.find(e => e.ic_id === icId);
    if (entry) {
      return { direction: dir.id, name: entry.name, km: entry.km };
    }
  }
  return null;
}
```

- [ ] **Step 7: テスト成功確認**

```bash
npm test
```

- [ ] **Step 8: コミット**

```bash
git add data/deduction.json data/ics.json tests/judge.test.js js/judge.js
git commit -m "feat(judge): lookupDeduction + tomei direction data"
```

---

## Task 6: `deduction.json` に残り全方面を追加

**Files:**
- Modify: `data/deduction.json`
- Modify: `data/ics.json`（各方面の IC 追加）

- [ ] **Step 1: 中央道方面を追加**

`data/deduction.json` の `directions` 配列に追加：
```json
{
  "id": "chuo",
  "name": "中央道方面",
  "baseline": { "ic_id": "takaido", "ic_name": "高井戸IC" },
  "entries": [
    { "ic_id": "chofu",          "name": "調布",         "km": 7.7 },
    { "ic_id": "kokuryo_fuchu",  "name": "国立府中",     "km": 14.0 },
    { "ic_id": "hachioji",       "name": "八王子",       "km": 25.6 },
    { "ic_id": "hachioji_jct",   "name": "八王子JCT",    "km": 26.2 },
    { "ic_id": "sagamiko",       "name": "相模湖",       "km": 45.6 },
    { "ic_id": "uenohara",       "name": "上野原",       "km": 50.3 },
    { "ic_id": "otsuki",         "name": "大月",         "km": 70.9 },
    { "ic_id": "kawaguchiko",    "name": "河口湖",       "km": 93.4 },
    { "ic_id": "katsunuma",      "name": "勝沼",         "km": 93.0 },
    { "ic_id": "ichinomiya",     "name": "一宮御坂",     "km": 99.8 },
    { "ic_id": "sutama",         "name": "須玉",         "km": 140.8 },
    { "ic_id": "fujiyoshida",    "name": "富士吉田",     "km": 103.1 }
  ]
}
```

基準点 `takaido` を `ics.json` に追加し、各エントリ IC も追加。

- [ ] **Step 2: 関越方面を追加（基準点 練馬IC）**

```json
{
  "id": "kanetsu",
  "name": "関越方面",
  "baseline": { "ic_id": "nerima", "ic_name": "練馬IC" },
  "entries": [
    { "ic_id": "wakoh_kita",    "name": "和光北",       "km": 3.0 },
    { "ic_id": "wakoh",         "name": "和光",         "km": 5.1 },
    { "ic_id": "shinkura",      "name": "新倉",         "km": 5.1 },
    { "ic_id": "niiza",         "name": "新座",         "km": 9.4 },
    { "ic_id": "tokorozawa",    "name": "所沢",         "km": 10.4 },
    { "ic_id": "kawagoe",       "name": "川越",         "km": 17.1 },
    { "ic_id": "tsurugashima",  "name": "鶴ヶ島",       "km": 21.2 },
    { "ic_id": "higashi_matsuyama", "name": "東松山",   "km": 29.7 },
    { "ic_id": "ranzan_ogawa",  "name": "嵐山小川",     "km": 37.3 },
    { "ic_id": "hanazono",      "name": "花園",         "km": 47.0 },
    { "ic_id": "honjo_kodama",  "name": "本庄児玉",     "km": 55.2 },
    { "ic_id": "fujioka",       "name": "藤岡",         "km": 63.9 }
  ]
}
```

対応 IC を `ics.json` に追加。

- [ ] **Step 3: 東北方面（基準点 川口JCT）**

```json
{
  "id": "tohoku",
  "name": "東北方面",
  "baseline": { "ic_id": "kawaguchi_jct", "ic_name": "川口JCT" },
  "entries": [
    { "ic_id": "urawa",       "name": "浦和",       "km": 2.7 },
    { "ic_id": "iwatsuki",    "name": "岩槻",       "km": 11.5 },
    { "ic_id": "hasuda",      "name": "蓮田",       "km": 16.5 },
    { "ic_id": "kuki",        "name": "久喜",       "km": 22.8 },
    { "ic_id": "kazo",        "name": "加須",       "km": 29.2 },
    { "ic_id": "hanyuu",      "name": "羽生",       "km": 37.3 },
    { "ic_id": "tatebayashi", "name": "館林",       "km": 43.7 },
    { "ic_id": "sano_fujioka","name": "佐野藤岡",   "km": 56.4 }
  ]
}
```

- [ ] **Step 4: 常磐方面（基準点 三郷JCT）**

```json
{
  "id": "joban",
  "name": "常磐方面",
  "baseline": { "ic_id": "misato_jct", "ic_name": "三郷JCT" },
  "entries": [
    { "ic_id": "kashiwa",      "name": "柏",          "km": 6.1 },
    { "ic_id": "yawara",       "name": "谷和原",      "km": 10.8 },
    { "ic_id": "tanibe_jct",   "name": "谷田部JCT",   "km": 23.7 },
    { "ic_id": "tsukuba",      "name": "つくば",      "km": 30.4 },
    { "ic_id": "tsuchiura",    "name": "土浦",        "km": 38.7 },
    { "ic_id": "chiyoda_ishioka", "name": "千代田石岡", "km": 46.8 },
    { "ic_id": "iwama",        "name": "岩間",        "km": 54.7 }
  ]
}
```

- [ ] **Step 5: 神奈川・横横・京葉・東関東・アクア・館山の方面を追加**

画像2 と 1枚目の路線図を参照し、以下をまとめて追加（紙面の都合で要点のみ、entries は社内資料から書き起こし）：

- `sanketan_keihin` (第三京浜方面, 基準点 玉川IC): 京浜川崎 2.5 / 都筑 8.1 / 港北 11.1 / ...
- `yokoyoko` (横横方面, 基準点 釜利谷JCT or 藤沢): 21.2 / ...
- `keiyo` (京葉方面, 基準点 篠崎): 市川 ... 千葉北 ...
- `tokan` (東関東方面, 基準点 湾岸市川): 3.0 / ...
- `aqua` (アクア方面, 基準点 浮島JCT): 木更津金田 15.1 / 袖ヶ浦 21.4 / 木更津JCT 29.3 / ...
- `tateyama` (館山方面, 基準点 木更津JCT経由): 富浦 / 館山 ...

**⚠️ このステップは社内資料（画像2）の精読が必要。各方面のエントリ数は6〜15件。実装者は画像2を見ながらJSONを埋める。**

- [ ] **Step 6: 対応する全IC を `ics.json` に追加**

各方面の entries に対応する IC を `ics.json` に1件ずつ追加。GPS座標は Google Maps で実測、svg座標は暫定値（後で SVG 路線図作成時に調整）。boundary_tag は：

- 基準点IC（東京IC, 高井戸, 練馬, 川口JCT, 三郷JCT, 玉川, 篠崎, 湾岸市川, 浮島JCT, 藤沢）: `null`
- 各方面のエントリIC（外側）: `"company_pay_entry"`

- [ ] **Step 7: テスト追加とテスト実行**

`tests/judge.test.js` に方面ごとのチェックを追加：
```js
test('lookupDeduction: 所沢 は kanetsu / 10.4km', () => {
  const deduction = loadJson('data/deduction.json');
  const e = lookupDeduction(deduction, 'tokorozawa');
  assert.strictEqual(e?.direction, 'kanetsu');
  assert.strictEqual(e?.km, 10.4);
});

test('lookupDeduction: 柏 は joban / 6.1km', () => {
  const deduction = loadJson('data/deduction.json');
  const e = lookupDeduction(deduction, 'kashiwa');
  assert.strictEqual(e?.direction, 'joban');
  assert.strictEqual(e?.km, 6.1);
});

test('lookupDeduction: 木更津金田 は aqua / 15.1km', () => {
  const deduction = loadJson('data/deduction.json');
  const e = lookupDeduction(deduction, 'kisarazu_kaneda');
  assert.strictEqual(e?.direction, 'aqua');
  assert.strictEqual(e?.km, 15.1);
});
```

```bash
npm test
```

Expected: PASS

- [ ] **Step 8: コミット**

```bash
git add data/deduction.json data/ics.json tests/judge.test.js
git commit -m "feat(data): add all 9 directions to deduction.json + matching ICs"
```

---

## Task 7: `ics.json` の ID 参照整合性テストを強化

**Files:**
- Modify: `tests/data-integrity.test.js`

- [ ] **Step 1: `deduction.json` の全 IC 参照が `ics.json` に存在することを検証するテストを追加**

`tests/data-integrity.test.js` に追加：
```js
test('deduction.json: 全 ic_id が ics.json に存在する', () => {
  const { ics } = loadJson('data/ics.json');
  const { directions } = loadJson('data/deduction.json');
  const icIds = new Set(ics.map(x => x.id));

  for (const dir of directions) {
    assert.ok(icIds.has(dir.baseline.ic_id),
      `baseline not found in ics.json: ${dir.id} / ${dir.baseline.ic_id}`);
    for (const entry of dir.entries) {
      assert.ok(icIds.has(entry.ic_id),
        `entry not found in ics.json: ${dir.id} / ${entry.ic_id}`);
    }
  }
});
```

- [ ] **Step 2: テスト実行、PASS を確認**

```bash
npm test
```

Expected: PASS（Task 6 で全 IC を追加済み）

- [ ] **Step 3: コミット**

```bash
git add tests/data-integrity.test.js
git commit -m "test(data): assert ics.json covers all deduction.json ic_ids"
```

---

## Task 8: `shutoko_distances.json`（首都高内距離表）

**Files:**
- Create: `data/shutoko_distances.json`
- Modify: `tests/data-integrity.test.js`

- [ ] **Step 1: 主要な首都高内の距離データを JSON に書き出す**

`data/shutoko_distances.json`:
```json
{
  "version": 1,
  "source": "首都高主要入口 → 代表都心出口の距離",
  "note": "片道実走距離。往復時は ×2。",
  "entries": [
    { "from": "nakadai",    "to": "kasumigaseki", "km": 14.2 },
    { "from": "shingo",     "to": "kasumigaseki", "km": 16.8 },
    { "from": "kahei",      "to": "kasumigaseki", "km": 12.4 },
    { "from": "yotsugi",    "to": "kasumigaseki", "km": 9.5 },
    { "from": "maihama",    "to": "kasumigaseki", "km": 15.2 },
    { "from": "kinshicho",  "to": "kasumigaseki", "km": 8.5 },
    { "from": "eifuku",     "to": "kasumigaseki", "km": 10.1 },
    { "from": "shioiri",    "to": "kasumigaseki", "km": 22.3 },
    { "from": "wangan_kanpachi", "to": "kasumigaseki", "km": 22.1 },
    { "from": "kukou_chuou",     "to": "kasumigaseki", "km": 18.0 },
    { "from": "tokyo_ic",   "to": "kasumigaseki", "km": 10.4 }
  ]
}
```

**⚠️ 数値は暫定。実装者は NEXCO / 首都高 公式の距離表で検算し、必要に応じて修正。**

- [ ] **Step 2: 参照整合性テストを追加**

`tests/data-integrity.test.js`:
```js
test('shutoko_distances.json: 全 from/to が ics.json に存在', () => {
  const { ics } = loadJson('data/ics.json');
  const { entries } = loadJson('data/shutoko_distances.json');
  const icIds = new Set(ics.map(x => x.id));
  for (const e of entries) {
    assert.ok(icIds.has(e.from), `from not in ics.json: ${e.from}`);
    assert.ok(icIds.has(e.to), `to not in ics.json: ${e.to}`);
    assert.ok(typeof e.km === 'number' && e.km > 0, `invalid km: ${e.from}→${e.to}`);
  }
});
```

- [ ] **Step 3: テスト実行・PASS確認**

```bash
npm test
```

- [ ] **Step 4: コミット**

```bash
git add data/shutoko_distances.json tests/data-integrity.test.js
git commit -m "feat(data): add shutoko_distances.json (intra-shutoko distances)"
```

---

## Task 9: `gaikan_distances.json`（外環 JCT 間距離）

**Files:**
- Create: `data/gaikan_distances.json`
- Modify: `tests/data-integrity.test.js`

- [ ] **Step 1: 外環の JCT 間距離 JSON を作成**

`data/gaikan_distances.json`:
```json
{
  "version": 1,
  "source": "外環自動車道 JCT 間距離",
  "entries": [
    { "from": "misato_jct",    "to": "bijogi_jct", "km": 25.3 },
    { "from": "bijogi_jct",    "to": "oizumi_jct", "km": 7.8 },
    { "from": "kawaguchi_jct", "to": "bijogi_jct", "km": 12.1 },
    { "from": "misato_jct",    "to": "kawaguchi_jct", "km": 14.0 }
  ]
}
```

※ `bijogi_jct` / `oizumi_jct` を `ics.json` に追加（外環本線 JCT）。`boundary_tag: "gaikan"`。

- [ ] **Step 2: 外環の直乗り IC を `ics.json` に追加**

大泉・和光・戸田東・戸田西・川口西・草加・八潮・三郷西 を追加、すべて `boundary_tag: "gaikan"`。

- [ ] **Step 3: 整合性テスト追加・実行**

```js
test('gaikan_distances.json: 全 from/to が ics.json に存在', () => {
  // 同パターン
});
```

- [ ] **Step 4: コミット**

```bash
git add data/gaikan_distances.json data/ics.json tests/data-integrity.test.js
git commit -m "feat(data): add gaikan_distances.json and gaikan ICs"
```

---

## Task 10: `routes.json`（needs_gaikan_transit マップ）

**Files:**
- Create: `data/routes.json`

- [ ] **Step 1: routes.json を作成**

```json
{
  "version": 1,
  "labels": {
    "tomei":    "東名",
    "chuo":     "中央道",
    "kanetsu":  "関越道",
    "tohoku":   "東北道",
    "joban":    "常磐道",
    "keiyo":    "京葉道",
    "tokan":    "東関東道",
    "aqua":     "アクアライン",
    "tateyama": "館山道",
    "yokohama": "横浜方面",
    "gaikan_direct": "外環直乗り",
    "none":     "首都高内のみ"
  },
  "needs_gaikan_transit": {
    "tomei":    false,
    "chuo":     false,
    "kanetsu":  "optional",
    "tohoku":   true,
    "joban":    "optional",
    "keiyo":    false,
    "tokan":    false,
    "aqua":     false,
    "tateyama": false,
    "yokohama": false
  },
  "edges": []
}
```

`edges` は SVG 路線描画のために Task 16 で埋める。

- [ ] **Step 2: ルートラベルテストを追加**

`tests/judge.test.js` に：
```js
test('routes.json: needs_gaikan_transit に全 outerRoute キーがある', () => {
  const r = loadJson('data/routes.json');
  const expected = ['tomei','chuo','kanetsu','tohoku','joban','keiyo','tokan','aqua','tateyama','yokohama'];
  for (const key of expected) {
    assert.ok(key in r.needs_gaikan_transit, `missing: ${key}`);
  }
});
```

- [ ] **Step 3: テスト実行、コミット**

```bash
npm test
git add data/routes.json tests/judge.test.js
git commit -m "feat(data): add routes.json with labels and gaikan transit map"
```

---

## Task 11: `company-pay.json`（会社負担ルール宣言）

**Files:**
- Create: `data/company-pay.json`

- [ ] **Step 1: ルール宣言を作成**

```json
{
  "version": 1,
  "rules": [
    {
      "id": "rule_8entries_and_outer",
      "description": "指定8入口 + それより東京外側の首都高接続ICから首都高に戻る",
      "applies_via": "entry_boundary_tag:company_pay_entry"
    },
    {
      "id": "rule_wangan_kanpachi",
      "description": "アクア/館山/横浜方面から戻って湾岸環八IC降車",
      "applies_via": "exit_id:wangan_kanpachi AND outer_route_in:[aqua,tateyama,yokohama]"
    },
    {
      "id": "rule_outer_via_gaikan",
      "description": "常磐/東北/関越道から外環経由で首都高に戻る場合、全区間会社負担",
      "applies_via": "outer_route_in:[joban,tohoku,kanetsu] AND via_gaikan:true"
    }
  ]
}
```

- [ ] **Step 2: コミット**

```bash
git add data/company-pay.json
git commit -m "feat(data): declarative company-pay rules"
```

---

## Task 12: `calcOneWayDeduction` 4パターンをTDDで実装

**Files:**
- Modify: `js/judge.js`
- Modify: `tests/judge.test.js`

- [ ] **Step 1: 4パターンの失敗テストを書く**

`tests/judge.test.js`:
```js
import { calcOneWayDeduction } from '../js/judge.js';

test('calcOneWayDeduction: A=外, B=内 → 表[A]', () => {
  const ded = loadJson('data/deduction.json');
  const ics = loadJson('data/ics.json').ics;
  const A = ics.find(x => x.id === 'tomei_kawasaki');
  const B = ics.find(x => x.id === 'kasumigaseki');
  assert.strictEqual(calcOneWayDeduction(A, B, ded), 7.7);
});

test('calcOneWayDeduction: A=内, B=外 → 表[B]（対称）', () => {
  const ded = loadJson('data/deduction.json');
  const ics = loadJson('data/ics.json').ics;
  const A = ics.find(x => x.id === 'kasumigaseki');
  const B = ics.find(x => x.id === 'tomei_kawasaki');
  assert.strictEqual(calcOneWayDeduction(A, B, ded), 7.7);
});

test('calcOneWayDeduction: A=外/B=外 同方面 → |表[A]-表[B]|', () => {
  const ded = loadJson('data/deduction.json');
  const ics = loadJson('data/ics.json').ics;
  const A = ics.find(x => x.id === 'atsugi');      // 35.0
  const B = ics.find(x => x.id === 'tomei_kawasaki'); // 7.7
  assert.strictEqual(calcOneWayDeduction(A, B, ded), 27.3);
});

test('calcOneWayDeduction: A=内/B=内 → 0', () => {
  const ded = loadJson('data/deduction.json');
  const ics = loadJson('data/ics.json').ics;
  const A = ics.find(x => x.id === 'kasumigaseki');
  const B = ics.find(x => x.id === 'tokyo_ic'); // 基準点は「内」扱い
  assert.strictEqual(calcOneWayDeduction(A, B, ded), 0);
});

test('calcOneWayDeduction: 異方面 → 0', () => {
  const ded = loadJson('data/deduction.json');
  const ics = loadJson('data/ics.json').ics;
  const A = ics.find(x => x.id === 'tomei_kawasaki');
  const B = ics.find(x => x.id === 'tokorozawa');
  assert.strictEqual(calcOneWayDeduction(A, B, ded), 0);
});
```

- [ ] **Step 2: テスト実行、失敗確認**

- [ ] **Step 3: 実装**

`js/judge.js` に追加：
```js
export function calcOneWayDeduction(icA, icB, deductionData) {
  const eA = lookupDeduction(deductionData, icA.id);
  const eB = lookupDeduction(deductionData, icB.id);
  if (!eA && !eB) return 0;
  if (eA && !eB) return eA.km;
  if (!eA && eB) return eB.km;
  if (eA.direction !== eB.direction) return 0;
  return Math.abs(eA.km - eB.km);
}
```

- [ ] **Step 4: テスト実行、PASS 確認**

- [ ] **Step 5: コミット**

```bash
git add js/judge.js tests/judge.test.js
git commit -m "feat(judge): calcOneWayDeduction with 4-pattern logic"
```

---

## Task 13: `judgeDeduction`（往復対応）

**Files:**
- Modify: `js/judge.js`
- Modify: `tests/judge.test.js`

- [ ] **Step 1: 失敗テスト**

```js
import { judgeDeduction } from '../js/judge.js';

test('judgeDeduction: 東名川崎⇔霞ヶ関 往復 = 15.4km', () => {
  const ded = loadJson('data/deduction.json');
  const ics = loadJson('data/ics.json').ics;
  const A = ics.find(x => x.id === 'tomei_kawasaki');
  const B = ics.find(x => x.id === 'kasumigaseki');
  assert.strictEqual(judgeDeduction(A, B, ded, true), 15.4);
});

test('judgeDeduction: 片道指定 = 7.7km', () => {
  const ded = loadJson('data/deduction.json');
  const ics = loadJson('data/ics.json').ics;
  const A = ics.find(x => x.id === 'tomei_kawasaki');
  const B = ics.find(x => x.id === 'kasumigaseki');
  assert.strictEqual(judgeDeduction(A, B, ded, false), 7.7);
});
```

- [ ] **Step 2: 実装**

```js
export function judgeDeduction(icA, icB, deductionData, roundTrip) {
  const oneWay = calcOneWayDeduction(icA, icB, deductionData);
  return roundTrip ? oneWay * 2 : oneWay;
}
```

- [ ] **Step 3: テスト PASS 確認、コミット**

```bash
npm test
git add js/judge.js tests/judge.test.js
git commit -m "feat(judge): judgeDeduction round-trip wrapper"
```

---

## Task 14: `computeShutokoPay`（首都高区間の負担判定）

**Files:**
- Modify: `js/judge.js`
- Modify: `tests/judge.test.js`

- [ ] **Step 1: 失敗テスト**

```js
import { computeShutokoPay } from '../js/judge.js';

test('computeShutokoPay: 外側本線経由 → company', () => {
  const ics = loadJson('data/ics.json').ics;
  const entry = ics.find(x => x.id === 'tomei_kawasaki');
  const r = computeShutokoPay({ outerRoute: 'tomei', entryIc: entry, isOuter: true });
  assert.strictEqual(r, 'company');
});

test('computeShutokoPay: 外環直乗り → self', () => {
  const ics = loadJson('data/ics.json').ics;
  const entry = ics.find(x => x.id === 'oizumi');
  const r = computeShutokoPay({ outerRoute: 'gaikan_direct', entryIc: entry, isOuter: false });
  assert.strictEqual(r, 'self');
});

test('computeShutokoPay: 8入口 → company', () => {
  const ics = loadJson('data/ics.json').ics;
  const entry = ics.find(x => x.id === 'maihama');
  const r = computeShutokoPay({ outerRoute: 'none', entryIc: entry, isOuter: false });
  assert.strictEqual(r, 'company');
});

test('computeShutokoPay: 都心側IC → self', () => {
  const ics = loadJson('data/ics.json').ics;
  const entry = ics.find(x => x.id === 'kasumigaseki');
  const r = computeShutokoPay({ outerRoute: 'none', entryIc: entry, isOuter: false });
  assert.strictEqual(r, 'self');
});
```

- [ ] **Step 2: 実装**

```js
export function computeShutokoPay({ outerRoute, entryIc, isOuter }) {
  if (isOuter) return 'company';
  if (outerRoute === 'gaikan_direct') return 'self';
  return entryIc.boundary_tag === 'company_pay_entry' ? 'company' : 'self';
}
```

- [ ] **Step 3: PASS、コミット**

```bash
npm test
git add js/judge.js tests/judge.test.js
git commit -m "feat(judge): computeShutokoPay"
```

---

## Task 15: `judgeRoute` 全体（ゴールデンケース12件）

**Files:**
- Modify: `js/judge.js`
- Modify: `tests/judge.test.js`

- [ ] **Step 1: 仕様書 §9 のゴールデンケース12件を全て失敗テストとして書く**

`tests/judge.test.js` に追加（一部抜粋、全件書く）：
```js
import { judgeRoute } from '../js/judge.js';

function buildInputs() {
  return {
    ics: loadJson('data/ics.json').ics,
    deduction: loadJson('data/deduction.json'),
    shutokoDist: loadJson('data/shutoko_distances.json'),
    gaikanDist: loadJson('data/gaikan_distances.json'),
    routes: loadJson('data/routes.json')
  };
}

function findIc(ics, id) { return ics.find(x => x.id === id); }

test('ゴールデン #1: tomei 東名川崎→霞ヶ関 往復', () => {
  const d = buildInputs();
  const result = judgeRoute({
    outerRoute: 'tomei',
    entryIc: findIc(d.ics, 'tomei_kawasaki'),
    exitIc: findIc(d.ics, 'kasumigaseki'),
    roundTrip: true
  }, d);
  assert.strictEqual(result.totals.paySummary, 'all_company');
  assert.strictEqual(result.totals.deductionKmRoundtrip, 15.4);
});

test('ゴールデン #7: gaikan_direct 大泉→霞ヶ関 → 外環/首都高 self', () => {
  const d = buildInputs();
  const result = judgeRoute({
    outerRoute: 'gaikan_direct',
    entryIc: findIc(d.ics, 'oizumi'),
    exitIc: findIc(d.ics, 'kasumigaseki'),
    roundTrip: true
  }, d);
  assert.strictEqual(result.totals.paySummary, 'all_self');
  assert.strictEqual(result.totals.deductionKmRoundtrip, 0);
});

test('ゴールデン #8: none 舞浜→霞ヶ関 → all_company, 控除0', () => {
  const d = buildInputs();
  const result = judgeRoute({
    outerRoute: 'none',
    entryIc: findIc(d.ics, 'maihama'),
    exitIc: findIc(d.ics, 'kasumigaseki'),
    roundTrip: true
  }, d);
  assert.strictEqual(result.totals.paySummary, 'all_company');
  assert.strictEqual(result.totals.deductionKmRoundtrip, 0);
});

test('ゴールデン #9: none 葛西→霞ヶ関 → all_self, 控除0', () => {
  const d = buildInputs();
  const result = judgeRoute({
    outerRoute: 'none',
    entryIc: findIc(d.ics, 'kasai'),
    exitIc: findIc(d.ics, 'kasumigaseki'),
    roundTrip: true
  }, d);
  assert.strictEqual(result.totals.paySummary, 'all_self');
  assert.strictEqual(result.totals.deductionKmRoundtrip, 0);
});

// #2, #3, #4, #5, #6, #10, #11, #12 も同様に全件書く
```

**※ `kasai` IC が `ics.json` に未追加なら追加する（都心寄りの首都高IC、boundary_tag: null）。**

- [ ] **Step 2: テスト実行、失敗確認（judgeRoute 未実装）**

- [ ] **Step 3: `judgeRoute` 実装**

`js/judge.js` に追加：
```js
const OUTER_TRUNK_ROUTES = new Set([
  'tomei','chuo','kanetsu','tohoku','joban',
  'keiyo','tokan','aqua','tateyama','yokohama'
]);

function needsGaikanTransit(outerRoute, entryIc, routes) {
  const conf = routes.needs_gaikan_transit[outerRoute];
  if (conf === true) return true;
  if (conf === false) return false;
  if (conf === 'optional') {
    // entryIc に gaikan 経由フラグが明示されていないならデフォルト false
    return entryIc._viaGaikan === true;
  }
  return false;
}

function lookupDistance(distData, fromId, toId) {
  const hit = distData.entries.find(e =>
    (e.from === fromId && e.to === toId) || (e.from === toId && e.to === fromId));
  return hit?.km ?? 0;
}

function aggregate(segments, roundTrip) {
  const totalDed = segments.reduce((a, s) => a + s.deductionKm, 0);
  const totalDist = segments.reduce((a, s) => a + s.distanceKm, 0);
  const pays = new Set(segments.map(s => s.pay));
  const paySummary = pays.size === 1
    ? (pays.has('company') ? 'all_company' : 'all_self')
    : 'mixed';
  return {
    paySummary,
    deductionKmOneway: totalDed,
    deductionKmRoundtrip: roundTrip ? totalDed * 2 : totalDed,
    distanceKmOneway: totalDist,
    distanceKmRoundtrip: roundTrip ? totalDist * 2 : totalDist
  };
}

export function judgeRoute({ outerRoute, entryIc, exitIc, roundTrip }, deps) {
  const { deduction, shutokoDist, gaikanDist, routes } = deps;
  const isOuter = OUTER_TRUNK_ROUTES.has(outerRoute);
  const viaGaikan = outerRoute === 'gaikan_direct'
                 || needsGaikanTransit(outerRoute, entryIc, routes);
  const segs = [];

  if (isOuter) {
    const ded = lookupDeduction(deduction, entryIc.id);
    segs.push({
      name: routes.labels[outerRoute],
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
      distanceKm: 0  // 外環JCT間の距離は optional 経由時に別途ルックアップ
    });
  }

  segs.push({
    name: '首都高',
    route: 'shutoko',
    pay: computeShutokoPay({ outerRoute, entryIc, isOuter }),
    deductionKm: 0,
    distanceKm: lookupDistance(shutokoDist, entryIc.id, exitIc.id)
  });

  // ルール2: 湾岸環八降車上書き
  if (exitIc.id === 'wangan_kanpachi' &&
      ['aqua','tateyama','yokohama'].includes(outerRoute)) {
    segs[segs.length - 1].pay = 'company';
  }

  return { segments: segs, totals: aggregate(segs, roundTrip) };
}
```

- [ ] **Step 4: テスト実行、全12件 PASS まで詰める**

```bash
npm test
```

失敗した場合は該当テストを1件ずつデバッグ、`data/*.json` のズレか `judge.js` のロジックかを確認。

- [ ] **Step 5: コミット**

```bash
git add js/judge.js tests/judge.test.js data/ics.json
git commit -m "feat(judge): judgeRoute main logic with 12 golden cases passing"
```

---

## Task 16: SVG 路線図作成（v0.1 は主要ICのみ）

**Files:**
- Create: `svg/map.svg`
- Modify: `data/routes.json`（edges を埋める）

- [ ] **Step 1: `svg/map.svg` を作成**

1200×1200 の論理キャンバス。以下の要素を `<g>` で階層化：

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 1200" id="map-svg">
  <style>
    .route-line { fill: none; stroke: #4a90e2; stroke-width: 6; }
    .route-line.gaikan { stroke: #9b59b6; }
    .route-line.shutoko { stroke: #2c3e50; stroke-width: 8; }
    .ic-node { fill: #ecf0f1; stroke: #34495e; stroke-width: 2; }
    .ic-node.company-pay { fill: #27ae60; }
    .ic-node.self-with-deduction { fill: #3498db; }
    .ic-node.self-no-deduction { fill: #7f8c8d; }
    .ic-label { font: 12px sans-serif; fill: #2c3e50; text-anchor: middle; }
  </style>

  <!-- 都心環状（C1） -->
  <circle cx="600" cy="600" r="80" class="route-line shutoko" />
  <!-- 中央環状（C2） -->
  <circle cx="600" cy="600" r="220" class="route-line shutoko" />
  <!-- 外環（簡略） -->
  <path d="M 300 400 A 350 350 0 0 1 900 400" class="route-line gaikan" />

  <!-- 放射線: 東名 -->
  <line x1="500" y1="700" x2="100" y2="900" class="route-line" />
  <!-- 放射線: 関越 -->
  <line x1="400" y1="520" x2="50" y2="350" class="route-line" />
  <!-- ...他方面も同様 -->

  <!-- IC ノード（例） -->
  <g>
    <circle class="ic-node" cx="600" cy="600" r="10" id="ic-kasumigaseki" data-ic-id="kasumigaseki" />
    <text class="ic-label" x="600" y="580">霞ヶ関</text>
  </g>
  <g>
    <circle class="ic-node" cx="480" cy="770" r="10" id="ic-tomei_kawasaki" data-ic-id="tomei_kawasaki" />
    <text class="ic-label" x="480" y="790">東名川崎</text>
  </g>
  <!-- ...全IC分 -->
</svg>
```

**実装者向けメモ:** `ics.json` の `svg.x` / `svg.y` を反映する自動生成スクリプト (`scripts/gen-ic-nodes.js`) を作っても良い。ただし v0.1 では手書きでOK、100ノード程度なら30分〜1時間。

- [ ] **Step 2: `routes.json` の `edges` を埋める**

```json
"edges": [
  { "from": "tokyo_ic", "to": "tomei_kawasaki", "route": "tomei", "via": "line" },
  { "from": "nerima",   "to": "tokorozawa",     "route": "kanetsu", "via": "line" }
]
```

- [ ] **Step 3: テスト: ICノードが ics.json と一致するかをブラウザ外で検証**

`tests/data-integrity.test.js`:
```js
test('map.svg: data-ic-id 属性が ics.json の全 id をカバー', () => {
  const { ics } = loadJson('data/ics.json');
  const svgText = readFileSync(join(root, 'svg/map.svg'), 'utf8');
  const ids = ics.map(x => x.id);
  for (const id of ids) {
    assert.ok(svgText.includes(`data-ic-id="${id}"`),
      `svg missing node for: ${id}`);
  }
});
```

**⚠️ 実装者は `map.svg` の全IC追加が完了するまでこのテストが通らないことを受け入れる（Task16の最終サブタスク）。**

- [ ] **Step 4: テスト PASS、コミット**

```bash
npm test
git add svg/map.svg data/routes.json tests/data-integrity.test.js
git commit -m "feat(svg): add base map.svg with main ICs and routes"
```

---

## Task 17: `data-loader.js`（JSON fetch + 整合性検証）

**Files:**
- Create: `js/data-loader.js`
- Create: `tests/data-loader.test.js`

- [ ] **Step 1: fetch ベースのロード関数（ブラウザ） + Node 用 fsベースのテスト版**

`js/data-loader.js`:
```js
export async function loadAllData() {
  const paths = {
    ics:         './data/ics.json',
    deduction:   './data/deduction.json',
    shutokoDist: './data/shutoko_distances.json',
    gaikanDist:  './data/gaikan_distances.json',
    routes:      './data/routes.json',
    companyPay:  './data/company-pay.json'
  };
  const entries = await Promise.all(
    Object.entries(paths).map(async ([k, p]) => [k, await (await fetch(p)).json()])
  );
  const data = Object.fromEntries(entries);
  data.ics = data.ics.ics;  // unwrap
  validate(data);
  return data;
}

export function validate(data) {
  const icIds = new Set(data.ics.map(x => x.id));
  const errors = [];

  for (const dir of data.deduction.directions) {
    if (!icIds.has(dir.baseline.ic_id)) {
      errors.push(`deduction baseline missing: ${dir.id}/${dir.baseline.ic_id}`);
    }
    for (const e of dir.entries) {
      if (!icIds.has(e.ic_id)) errors.push(`deduction entry missing: ${e.ic_id}`);
    }
  }
  for (const e of data.shutokoDist.entries) {
    if (!icIds.has(e.from)) errors.push(`shutoko from missing: ${e.from}`);
    if (!icIds.has(e.to))   errors.push(`shutoko to missing: ${e.to}`);
  }
  for (const e of data.gaikanDist.entries) {
    if (!icIds.has(e.from)) errors.push(`gaikan from missing: ${e.from}`);
    if (!icIds.has(e.to))   errors.push(`gaikan to missing: ${e.to}`);
  }

  if (errors.length > 0) {
    throw new Error('Data integrity errors:\n' + errors.join('\n'));
  }
  return true;
}
```

- [ ] **Step 2: Node 用テスト**

`tests/data-loader.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert';
import { loadJson } from './helpers.js';
import { validate } from '../js/data-loader.js';

test('validate: 現行の全JSONで整合性OK', () => {
  const data = {
    ics: loadJson('data/ics.json').ics,
    deduction: loadJson('data/deduction.json'),
    shutokoDist: loadJson('data/shutoko_distances.json'),
    gaikanDist: loadJson('data/gaikan_distances.json'),
    routes: loadJson('data/routes.json'),
    companyPay: loadJson('data/company-pay.json')
  };
  assert.doesNotThrow(() => validate(data));
});
```

- [ ] **Step 3: テスト PASS、コミット**

```bash
npm test
git add js/data-loader.js tests/data-loader.test.js
git commit -m "feat(loader): data-loader with runtime integrity validation"
```

---

## Task 18: `index.html` + `css/style.css` 基本レイアウト

**Files:**
- Create: `index.html`
- Create: `css/style.css`

- [ ] **Step 1: index.html を作成**

```html
<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5">
  <meta name="theme-color" content="#0f1723">
  <title>タクシー IC判定</title>
  <link rel="stylesheet" href="css/style.css">
</head>
<body>
  <main class="app">
    <header class="header">
      <div class="geo-status"><span id="geo-location">現在地: 未取得</span><span id="geo-accuracy"></span></div>
      <button id="btn-geo-refresh" type="button">再取得</button>
    </header>

    <section class="route-select">
      <label>どこから戻る？
        <select id="sel-outer-route"></select>
      </label>
      <label id="label-via-gaikan" hidden>
        <input type="checkbox" id="chk-via-gaikan"> 外環経由
      </label>
    </section>

    <section class="ic-select">
      <label>入口IC
        <select id="sel-entry-ic"></select>
      </label>
      <label>出口IC
        <select id="sel-exit-ic"></select>
      </label>
      <label><input type="checkbox" id="chk-roundtrip" checked> 往復</label>
    </section>

    <section class="verdict" id="verdict">
      <div class="badge-main" id="badge-main">—</div>
      <div class="badge-deduction" id="badge-deduction">—</div>
      <div class="badge-distance" id="badge-distance">—</div>
      <details>
        <summary>区間内訳</summary>
        <ul id="segment-breakdown"></ul>
      </details>
    </section>

    <section class="map">
      <div id="svg-mount"><!-- svg/map.svg を fetch して挿入 --></div>
    </section>
  </main>

  <script type="module" src="js/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: CSS を作成**

```css
:root {
  --bg: #0f1723;
  --surface: #1b2538;
  --text: #ecf0f1;
  --muted: #95a5a6;
  --company: #27ae60;
  --self-ded: #3498db;
  --self-none: #7f8c8d;
  --border: #2c3e50;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
       font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif; }
.app { display: flex; flex-direction: column; min-height: 100vh; }
.header { display: flex; justify-content: space-between; align-items: center;
          padding: 8px 16px; background: var(--surface); border-bottom: 1px solid var(--border); }
.route-select, .ic-select { padding: 12px 16px; display: grid; gap: 8px;
                            background: var(--surface); border-bottom: 1px solid var(--border); }
.route-select label, .ic-select label { display: flex; gap: 8px; align-items: center; }
select { min-width: 180px; min-height: 44px; padding: 8px; font-size: 16px;
         background: var(--bg); color: var(--text); border: 1px solid var(--border); }
button { min-height: 44px; padding: 8px 16px; font-size: 16px;
         background: var(--border); color: var(--text); border: none; border-radius: 4px; }

.verdict { padding: 16px; display: grid; gap: 12px; }
.badge-main { font-size: 40px; font-weight: 700; }
.badge-main.company { color: var(--company); }
.badge-main.self    { color: var(--self-none); }
.badge-main.mixed   { color: var(--self-ded); }
.badge-deduction, .badge-distance { font-size: 18px; color: var(--muted); }

.map { padding: 8px 16px; }
#svg-mount svg { width: 100%; height: auto; max-height: 60vh; }
.ic-node { transition: fill .2s; }
.ic-node.highlight-company { fill: var(--company); }
.ic-node.highlight-self-ded { fill: var(--self-ded); }
.ic-node.highlight-self-none { fill: var(--self-none); }
```

- [ ] **Step 3: ブラウザで `npm run serve` → `http://localhost:8000/` を開いて骨格表示を確認**

この時点では select は空で OK、次タスクで中身を埋める。

- [ ] **Step 4: コミット**

```bash
git add index.html css/style.css
git commit -m "feat(ui): base HTML + dark-mode CSS layout"
```

---

## Task 19: `app.js` — 初期ロード + プルダウン populate

**Files:**
- Create: `js/app.js`

- [ ] **Step 1: app.js を作成**

```js
import { loadAllData } from './data-loader.js';
import { judgeRoute } from './judge.js';

const state = {
  data: null,
  selected: { outerRoute: 'none', entryIcId: null, exitIcId: null, roundTrip: true, viaGaikan: false }
};

async function init() {
  state.data = await loadAllData();
  await loadSvg();
  populateOuterRouteSelect();
  populateIcSelects();
  wireEvents();
  update();
}

async function loadSvg() {
  const svgText = await (await fetch('./svg/map.svg')).text();
  document.getElementById('svg-mount').innerHTML = svgText;
}

function populateOuterRouteSelect() {
  const sel = document.getElementById('sel-outer-route');
  const labels = state.data.routes.labels;
  sel.innerHTML = '';
  for (const [value, label] of Object.entries(labels)) {
    const opt = document.createElement('option');
    opt.value = value; opt.textContent = label;
    if (value === 'none') opt.selected = true;
    sel.appendChild(opt);
  }
}

function populateIcSelects() {
  const entrySel = document.getElementById('sel-entry-ic');
  const exitSel = document.getElementById('sel-exit-ic');
  entrySel.innerHTML = ''; exitSel.innerHTML = '';

  const grouped = groupIcsByRoute(state.data.ics);
  for (const [routeName, list] of Object.entries(grouped)) {
    const ogE = document.createElement('optgroup'); ogE.label = routeName;
    const ogX = document.createElement('optgroup'); ogX.label = routeName;
    for (const ic of list) {
      const e = document.createElement('option'); e.value = ic.id; e.textContent = ic.name;
      const x = document.createElement('option'); x.value = ic.id; x.textContent = ic.name;
      ogE.appendChild(e); ogX.appendChild(x);
    }
    entrySel.appendChild(ogE); exitSel.appendChild(ogX);
  }
  // デフォルト: 入口=舞浜 / 出口=霞ヶ関
  entrySel.value = 'maihama';
  exitSel.value = 'kasumigaseki';
  state.selected.entryIcId = 'maihama';
  state.selected.exitIcId = 'kasumigaseki';
}

function groupIcsByRoute(ics) {
  const map = {};
  for (const ic of ics) {
    const key = ic.route_name || 'その他';
    (map[key] ||= []).push(ic);
  }
  return map;
}

function wireEvents() {
  document.getElementById('sel-outer-route').addEventListener('change', (e) => {
    state.selected.outerRoute = e.target.value;
    toggleGaikanCheckbox();
    update();
  });
  document.getElementById('sel-entry-ic').addEventListener('change', (e) => {
    state.selected.entryIcId = e.target.value; update();
  });
  document.getElementById('sel-exit-ic').addEventListener('change', (e) => {
    state.selected.exitIcId = e.target.value; update();
  });
  document.getElementById('chk-roundtrip').addEventListener('change', (e) => {
    state.selected.roundTrip = e.target.checked; update();
  });
  document.getElementById('chk-via-gaikan').addEventListener('change', (e) => {
    state.selected.viaGaikan = e.target.checked; update();
  });
}

function toggleGaikanCheckbox() {
  const conf = state.data.routes.needs_gaikan_transit[state.selected.outerRoute];
  document.getElementById('label-via-gaikan').hidden = (conf !== 'optional');
}

function update() {
  const icById = (id) => state.data.ics.find(x => x.id === id);
  const entryIc = icById(state.selected.entryIcId);
  const exitIc  = icById(state.selected.exitIcId);
  if (!entryIc || !exitIc) return;

  // optional gaikan 反映
  entryIc._viaGaikan = state.selected.viaGaikan;

  const result = judgeRoute({
    outerRoute: state.selected.outerRoute,
    entryIc, exitIc,
    roundTrip: state.selected.roundTrip
  }, state.data);

  renderVerdict(result);
  renderBreakdown(result);
}

function renderVerdict(result) {
  const main = document.getElementById('badge-main');
  const ded = document.getElementById('badge-deduction');
  const dist = document.getElementById('badge-distance');

  const { paySummary, deductionKmOneway, deductionKmRoundtrip,
          distanceKmOneway, distanceKmRoundtrip } = result.totals;

  main.className = 'badge-main';
  if (paySummary === 'all_company') { main.classList.add('company'); main.textContent = '🟢 全区間 会社負担'; }
  else if (paySummary === 'all_self') { main.classList.add('self'); main.textContent = '⚫ 全区間 自己負担'; }
  else { main.classList.add('mixed'); main.textContent = '🔵 区間混在'; }

  const rt = state.selected.roundTrip;
  ded.textContent  = `🛣 控除: ${rt ? '往復' : '片道'} ${(rt ? deductionKmRoundtrip : deductionKmOneway).toFixed(1)}km`;
  dist.textContent = `📏 総距離: ${rt ? '往復' : '片道'} ${(rt ? distanceKmRoundtrip : distanceKmOneway).toFixed(1)}km`;
}

function renderBreakdown(result) {
  const ul = document.getElementById('segment-breakdown');
  ul.innerHTML = '';
  for (const seg of result.segments) {
    const li = document.createElement('li');
    const emoji = seg.pay === 'company' ? '🟢' : '⚫';
    li.textContent = `${emoji} ${seg.name} — ${seg.pay === 'company' ? '会社負担' : '自己負担'} / 距離 ${seg.distanceKm.toFixed(1)}km / 控除 ${seg.deductionKm.toFixed(1)}km`;
    ul.appendChild(li);
  }
}

init().catch(err => {
  document.body.insertAdjacentHTML('afterbegin',
    `<div style="background:#c0392b;color:#fff;padding:12px">起動エラー: ${err.message}</div>`);
  console.error(err);
});
```

- [ ] **Step 2: ブラウザで動作確認**

```bash
npm run serve
```

`http://localhost:8000/` で：
- 入口=舞浜 / 出口=霞ヶ関 で起動
- 「🟢 全区間 会社負担」「控除 往復 0.0km」が表示される
- 入口プルダウンを「東名川崎」に変えたら「控除 往復 15.4km」になる
- 「どこから戻る？」を `tomei` に変えても結果が同じ（会社負担）

- [ ] **Step 3: コミット**

```bash
git add js/app.js
git commit -m "feat(ui): app.js with full state wiring and verdict rendering"
```

---

## Task 20: `map-svg.js` — SVG 上で現在選択の入口IC・出口ICをハイライト

**Files:**
- Create: `js/map-svg.js`
- Modify: `js/app.js`

- [ ] **Step 1: map-svg.js を作成**

```js
const ALL_HIGHLIGHT_CLASSES = ['highlight-company', 'highlight-self-ded', 'highlight-self-none'];

export function clearHighlights() {
  document.querySelectorAll('#map-svg .ic-node').forEach(el => {
    el.classList.remove(...ALL_HIGHLIGHT_CLASSES);
  });
}

export function highlightIc(icId, variant) {
  const el = document.querySelector(`#map-svg .ic-node[data-ic-id="${icId}"]`);
  if (!el) return;
  el.classList.remove(...ALL_HIGHLIGHT_CLASSES);
  el.classList.add(`highlight-${variant}`);
}
```

- [ ] **Step 2: app.js の update() にハイライト呼び出しを追加**

```js
import { clearHighlights, highlightIc } from './map-svg.js';

// update() 末尾に：
clearHighlights();
const entryVariant = result.segments.some(s => s.pay === 'company') ? 'company' :
                     result.totals.deductionKmOneway > 0 ? 'self-ded' : 'self-none';
highlightIc(state.selected.entryIcId, entryVariant);
highlightIc(state.selected.exitIcId, 'self-none');
```

- [ ] **Step 3: ブラウザ動作確認**

入口ICを変えると SVG 上の対応ノードの色が変わる。

- [ ] **Step 4: コミット**

```bash
git add js/map-svg.js js/app.js
git commit -m "feat(ui): svg highlight on selected entry/exit ICs"
```

---

## Task 21: エラー時の赤バナー表示（JSON整合性違反の可視化）

**Files:**
- Modify: `js/app.js`
- Modify: `css/style.css`

- [ ] **Step 1: CSS に赤バナースタイル追加**

```css
.error-banner { background: #c0392b; color: #fff; padding: 12px 16px;
                white-space: pre-wrap; font-family: monospace; font-size: 13px; }
```

- [ ] **Step 2: app.js の init エラーハンドラを強化**

```js
init().catch(err => {
  const banner = document.createElement('div');
  banner.className = 'error-banner';
  banner.textContent = `起動エラー:\n${err.message}`;
  document.body.prepend(banner);
  console.error(err);
});
```

- [ ] **Step 3: 手動テスト: `data/ics.json` の ic を1件削除 → リロード → 赤バナー表示確認 → 戻す**

- [ ] **Step 4: コミット**

```bash
git add js/app.js css/style.css
git commit -m "feat(ui): red error banner for data integrity violations"
```

---

## Task 22: README 最終版 + 免責全文 + 使い方

**Files:**
- Modify: `README.md`

- [ ] **Step 1: README を拡充**

```markdown
# タクシー乗務 IC判定 Web アプリ

帰りの空車で首都高に戻る際、**会社負担** / **控除距離** / **総走行距離** を一目で判定する個人用ツール。

## 使い方

1. 「どこから戻る？」に走ってきた本線を選ぶ（東名/関越/常磐/...）
2. 「入口IC」に首都高に戻る IC を選ぶ
3. 「出口IC」は降車地最寄の都心IC（デフォルト: 霞ヶ関）
4. 上部バッジで判定確認：
   - 🟢 全区間 会社負担
   - ⚫ 全区間 自己負担
   - 🔵 区間混在（区間内訳を開いて確認）

## ルール要約

- **会社負担**: (1) 指定8入口またはそれより東京外側の首都高IC、(2) 湾岸環八IC降車（アクア/横浜方面戻り）、(3) 常磐/東北/関越道→外環→首都高 の全区間
- **控除距離**: 首都高より外を走った距離。365km/日の法定上限に加算される
- 両者は独立して判定される

## 免責

- 判定は社内ルールに基づく参考情報。最終判断は運転手自身。
- 会社負担ルールは特定1社の社内規定に基づく。他社では使用不可。
- 他者への URL 共有は推奨しない。
- 精度・判定ミスに起因する損害について作成者は責任を負わない。

## ローカル起動

```bash
npm run serve   # http://localhost:8000/
npm test        # node --test tests/
```

## 版数

- v0.1: 手動入力、判定ロジック、SVG路線図、全方面データ
- v0.2: GPS連動、最寄IC自動推定
- v0.3: PWA化、オフライン対応
```

- [ ] **Step 2: コミット**

```bash
git add README.md
git commit -m "docs: complete README with usage, rules summary, disclaimer"
```

---

## Task 23: GitHub Pages デプロイ設定

**Files:**
- Create: `.github/workflows/pages.yml`

- [ ] **Step 1: GitHub Pages 用 Actions を作成**

```yaml
name: Deploy to GitHub Pages
on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm test
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with: { path: '.' }
      - id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 2: リポジトリを GitHub 上に作成し、設定で Pages ソースを "GitHub Actions" に設定**

手動作業：
1. `gh repo create taxi-ic-helper --public --source=. --remote=origin --push` (または Web UI で作成)
2. Settings → Pages → Source: GitHub Actions

- [ ] **Step 3: push して Actions が成功することを確認**

```bash
git push -u origin main
```

Actions タブでビルドを確認、URL に access して動作確認。

- [ ] **Step 4: コミット**

```bash
git add .github/workflows/pages.yml
git commit -m "ci: GitHub Pages deployment via Actions"
git push
```

---

## Task 24: エンドツーエンド受け入れチェック（手動）

**Files:** なし（手動チェックリスト）

- [ ] **Step 1: GitHub Pages の URL で以下を全て確認**

- [ ] 入口=東名川崎 / 出口=霞ヶ関 / tomei / 往復 → 🟢 全区間会社負担、控除15.4km
- [ ] 入口=所沢 / 出口=霞ヶ関 / kanetsu → 🟢 全区間会社負担、控除20.8km
- [ ] 入口=柏 / 出口=霞ヶ関 / joban (外環なし) → 🟢、控除12.2km
- [ ] 入口=柏 / 出口=霞ヶ関 / joban (外環経由) → 🟢、控除12.2km
- [ ] 入口=浦和 / 出口=霞ヶ関 / tohoku (外環経由) → 🟢、控除5.4km
- [ ] 入口=大泉 / 出口=霞ヶ関 / gaikan_direct → 全区間自己負担、控除0
- [ ] 入口=舞浜 / 出口=霞ヶ関 / none → 🟢（8入口）、控除0
- [ ] 入口=葛西 / 出口=霞ヶ関 / none → ⚫ 全区間自己負担、控除0
- [ ] 入口=木更津金田 / 出口=湾岸環八 / aqua → 🟢、控除あり
- [ ] SVG の選択IC が色変わり確認
- [ ] スマホ（実機）で開いて読みやすさ確認
- [ ] 起動〜表示まで 3秒以内
- [ ] 選択変更→反映 200ms 以内

- [ ] **Step 2: 不具合があればタスクを追加して修正**

- [ ] **Step 3: 受け入れ完了コミット（タグ付け）**

```bash
git tag v0.1.0
git push --tags
```

---

## 自己レビュー結果

### スペックカバレッジ
- §2 会社負担ルール → Task 11（宣言データ）+ Task 15（判定ロジック）でカバー
- §3 控除距離ルール → Task 5-7（データ）+ Task 12-13（判定）でカバー
- §4 アーキテクチャ → ファイル構造に反映
- §5 データモデル → Task 4-11 で全JSON作成
- §6 判定ロジック → Task 12-15
- §7 UI → Task 18-21
- §8 路線図SVG → Task 16
- §9 テスト観点 → Task 15（ゴールデン12件）+ Task 24（手動E2E）
- §10 免責 → Task 22
- §11 版数計画 → v0.1 のみスコープ、v0.2/v0.3 は別プラン

### プレースホルダ
- Task 6 Step 5 の「社内資料から書き起こし」は実装者に作業を委ねる形。これは物理的に画像2を見ながらしか埋められないため、プランでは作業範囲の明示までとし、データそのものはプラン外とする（妥当な委譲）。
- Task 8 / Task 16 の「数値は暫定」「svg座標は暫定」も同様、実装者判断を委譲。

### 型整合性
- `judgeRoute` の引数 `deps` は Task 15 で `{ deduction, shutokoDist, gaikanDist, routes }`、Task 17 の `loadAllData` 返値は `{ ics, deduction, shutokoDist, gaikanDist, routes, companyPay }` で、deps に渡す分は全て含む。OK。
- `lookupDeduction(data, id)` の戻り値 `{ direction, name, km }` は Task 5 / Task 12 で一貫。OK。
- `computeShutokoPay` の引数名は Task 14 / Task 15 で一致。OK。

問題なし。
