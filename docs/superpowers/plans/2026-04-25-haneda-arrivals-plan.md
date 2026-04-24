# 羽田到着便ビューワー Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ODPT API + 国交省統計を使い、羽田空港の到着便と推定降客数を5分ごとに更新する `data/arrivals.json` を生成し、既存タクシー乗務PWAの第3タブとして可視化する。

**Architecture:** GitHub Actions（cron 5分）が ODPT API を叩いて静的JSONを生成・commit し、GitHub Pages から配信。ブラウザは同一オリジンの JSON を fetch するだけ。サーバー不要・トークン秘匿・コスト0。

**Tech Stack:** Node.js (ES Modules), node:test, GitHub Actions, Vanilla JS (ES2022), HTML5, CSS3, ODPT REST API.

---

## ファイル構造

```
乗務地図関係/
├── arrivals.html                      # 新規・到着便UIエントリ
├── js/
│   ├── arrivals-app.js                # 新規・状態管理 + DOM配線
│   ├── arrivals-render.js             # 新規・ヒートマップ + リスト描画
│   └── arrivals-data.js               # 新規・arrivals.json fetch + 整形
├── data/
│   ├── arrivals.json                  # GitHub Actions が生成・更新
│   ├── aircraft-seats.json            # 新規・機材→座席数マスタ（手動）
│   └── load-factors.json              # 新規・路線→搭乗率マスタ（手動）
├── scripts/
│   ├── fetch-arrivals.mjs             # 新規・Actions実行スクリプト（エントリ）
│   └── lib/
│       ├── odpt-client.mjs            # 新規・ODPT API 呼び出し
│       ├── pax-estimator.mjs          # 新規・搭乗者数推定純関数
│       ├── arrival-transformer.mjs    # 新規・ODPT応答→arrivals.json変換
│       └── heatmap-aggregator.mjs     # 新規・30分ビン集計
├── tests/
│   ├── pax-estimator.test.mjs         # 新規
│   ├── arrival-transformer.test.mjs   # 新規
│   ├── heatmap-aggregator.test.mjs    # 新規
│   └── fixtures/
│       └── odpt-arrival-sample.json   # 新規・ODPT応答サンプル
├── .github/workflows/
│   └── update-arrivals.yml            # 新規・cron 5分
├── index.html                         # 修正・タブに「到着便」追加
├── ic.html                            # 修正・タブに「到着便」追加
└── README.md                          # 修正・データ出典明記
```

**責務分割**
- `pax-estimator.mjs`: 機材+路線→推定降客の**純関数**。副作用なし
- `arrival-transformer.mjs`: ODPT応答→arrivals.json形式の**純関数**
- `heatmap-aggregator.mjs`: フライト配列→30分ビン集計の**純関数**
- `odpt-client.mjs`: HTTP呼び出しのみ。ロジックなし
- `fetch-arrivals.mjs`: 上記をオーケストレーション、ファイル書き込み
- `arrivals-data.js`: ブラウザ側 fetch（CORS不要、同一オリジン）
- `arrivals-render.js`: DOM描画のみ。計算は `arrivals-data.js` に依存
- `arrivals-app.js`: ターミナル切替、最終更新表示等のUI状態管理

---

## Task 1: ODPT 開発者登録とトークン取得（ユーザー手動作業）

**Files:** （なし。ユーザー作業）

- [ ] **Step 1: 開発者サイト登録**

  https://developer.odpt.org/users/sign_up にアクセスしてユーザー登録（無料）。
  登録後、メール認証を完了。

- [ ] **Step 2: アクセストークン発行**

  ログイン後 → アカウント → APIキー（アクセストークン）を発行。
  トークン文字列を控える（後で GitHub Secrets に設定）。

- [ ] **Step 3: 動作確認（curl）**

  Run:
  ```
  curl "https://api.odpt.org/api/v4/odpt:FlightInformationArrival?acl:consumerKey=YOUR_TOKEN&odpt:operator=odpt.Operator:JAL" | head -200
  ```
  Expected: JSON-LD 形式で JAL 到着便配列が返ること。1件目に `odpt:flightNumber` `odpt:terminal` 等のキーが含まれる。

- [ ] **Step 4: HND（羽田）で絞れることを確認**

  Run:
  ```
  curl "https://api.odpt.org/api/v4/odpt:FlightInformationArrival?acl:consumerKey=YOUR_TOKEN&odpt:operator=odpt.Operator:ANA" | jq '.[] | select(.["odpt:terminal"] | contains("HND")) | {flightNumber: .["odpt:flightNumber"], terminal: .["odpt:terminal"], aircraft: .["odpt:aircraftModel"]}' | head -40
  ```
  Expected: HND 到着便のみがフィルタされる。`odpt:terminal` の実値（例 `"odpt.AirportTerminal:HND.T2"`）と `aircraftModel` の値・null率を観察。

- [ ] **Step 5: 結果メモ**

  以下を記録（後続タスクで使う）：
  - `odpt:terminal` の実値フォーマット（例 `"odpt.AirportTerminal:HND.T2"`）
  - `odpt:departureAirport` の実値フォーマット（例 `"odpt.Airport:ITM"`）
  - `odpt:airline` / `odpt:operator` の値
  - `aircraftModel` の出現率（null/値あり）
  - 含まれる航空会社（JAL/ANA以外に SKY/ADO/SNA 等があるか）

  → これをコミットメッセージに残すか `tests/fixtures/odpt-arrival-sample.json` のヘッダコメントに残す

---

## Task 2: GitHub Secrets にトークン設定

**Files:** （なし。GitHub UI 作業）

- [ ] **Step 1: リポジトリ Secrets 画面へ移動**

  GitHub Web UI → リポジトリ `hidenaka/taxi-ic-helper` → Settings → Secrets and variables → Actions → New repository secret

- [ ] **Step 2: ODPT_TOKEN を登録**

  - Name: `ODPT_TOKEN`
  - Secret: Task 1 で取得したトークン文字列

- [ ] **Step 3: 確認**

  Settings → Secrets and variables → Actions に `ODPT_TOKEN` が表示されること。

---

## Task 3: aircraft-seats.json マスタ作成

**Files:**
- Create: `data/aircraft-seats.json`

- [ ] **Step 1: ANA/JAL 国内線機材ページを参照**

  - ANA: https://www.ana.co.jp/ja/jp/guide/prepare/seatmap/domestic/
  - JAL: https://www.jal.co.jp/jp/ja/5971/seatmap/seatmap.html

  各機材の座席数（国内線仕様、合計座席数）を控える。

- [ ] **Step 2: `data/aircraft-seats.json` を作成**

  ```json
  {
    "_meta": {
      "source": "ANA/JAL 公式機材ページ（国内線仕様）",
      "updated": "2026-04-25",
      "note": "国内線仕様優先。国際線専用機（B77W等）は別仕様の場合あり"
    },
    "B789": { "name": "Boeing 787-9", "seats": 246 },
    "B788": { "name": "Boeing 787-8", "seats": 200 },
    "B772": { "name": "Boeing 777-200", "seats": 405 },
    "B773": { "name": "Boeing 777-300", "seats": 525 },
    "B77W": { "name": "Boeing 777-300ER", "seats": 244 },
    "B738": { "name": "Boeing 737-800", "seats": 166 },
    "A320": { "name": "Airbus A320", "seats": 146 },
    "A321": { "name": "Airbus A321neo", "seats": 194 },
    "A359": { "name": "Airbus A350-900", "seats": 369 },
    "A35K": { "name": "Airbus A350-1000", "seats": 339 },
    "DH8D": { "name": "Bombardier Q400", "seats": 74 },
    "E70":  { "name": "Embraer E170", "seats": 76 },
    "E90":  { "name": "Embraer E190", "seats": 95 },
    "AT7":  { "name": "ATR 72", "seats": 70 }
  }
  ```

- [ ] **Step 3: コミット**

  ```bash
  git add data/aircraft-seats.json
  git commit -m "feat(arrivals): 機材→座席数マスタ追加"
  ```

---

## Task 4: load-factors.json マスタ作成

**Files:**
- Create: `data/load-factors.json`

- [ ] **Step 1: 国交省 航空輸送統計を参照**

  - 国土交通省 航空輸送統計年報 https://www.mlit.go.jp/k-toukei/22/annual/22_result.html
  - 直近年の「主要路線別 利用状況」表から、羽田発着各路線の平均利用率を確認

- [ ] **Step 2: `data/load-factors.json` を作成**

  ```json
  {
    "_meta": {
      "source": "国土交通省 航空輸送統計年報（直近年）",
      "updated": "2026-04-25",
      "note": "デフォルト値は国内線全体平均。年1回手動更新。値は 0.0-1.0"
    },
    "default": 0.70,
    "routes": {
      "ITM": 0.78,
      "CTS": 0.75,
      "FUK": 0.75,
      "OKA": 0.82,
      "KIX": 0.72,
      "NGO": 0.68,
      "HIJ": 0.70,
      "KMJ": 0.70,
      "KOJ": 0.71,
      "KMI": 0.65,
      "KCZ": 0.65,
      "AKJ": 0.58,
      "KUH": 0.58,
      "MMB": 0.55,
      "AOJ": 0.62,
      "AXT": 0.60,
      "HKD": 0.65,
      "TOY": 0.60,
      "KMQ": 0.65,
      "TAK": 0.65,
      "MYJ": 0.68,
      "OIT": 0.65,
      "NGS": 0.68,
      "ISG": 0.75,
      "MYE": 0.72,
      "KKJ": 0.65
    }
  }
  ```

- [ ] **Step 3: コミット**

  ```bash
  git add data/load-factors.json
  git commit -m "feat(arrivals): 路線別搭乗率マスタ追加"
  ```

---

## Task 5: ODPT応答 fixture サンプル作成

**Files:**
- Create: `tests/fixtures/odpt-arrival-sample.json`

- [ ] **Step 1: Task 1 で取得した実応答から匿名化サンプルを抽出**

  実APIから取得したJSONを編集し、5-10便分のサンプルを残す。**個人情報は含まれていないが**、トークン情報があれば必ず除去する。

- [ ] **Step 2: `tests/fixtures/odpt-arrival-sample.json` を作成**

  ```json
  [
    {
      "@type": "odpt:FlightInformationArrival",
      "owl:sameAs": "urn:uuid:sample-1",
      "dc:date": "2026-04-25T14:30:00+09:00",
      "odpt:operator": "odpt.Operator:JAL",
      "odpt:airline": "odpt.Airline:JAL",
      "odpt:flightNumber": ["JL123"],
      "odpt:departureAirport": "odpt.Airport:ITM",
      "odpt:terminal": "odpt.AirportTerminal:HND.T1",
      "odpt:scheduledTime": "14:35",
      "odpt:estimatedTime": "14:35",
      "odpt:flightStatus": "odpt.FlightStatus:OnTime",
      "odpt:aircraftModel": "B789"
    },
    {
      "@type": "odpt:FlightInformationArrival",
      "owl:sameAs": "urn:uuid:sample-2",
      "dc:date": "2026-04-25T14:30:00+09:00",
      "odpt:operator": "odpt.Operator:ANA",
      "odpt:airline": "odpt.Airline:ANA",
      "odpt:flightNumber": ["NH456"],
      "odpt:departureAirport": "odpt.Airport:CTS",
      "odpt:terminal": "odpt.AirportTerminal:HND.T2",
      "odpt:scheduledTime": "14:42",
      "odpt:estimatedTime": "14:42",
      "odpt:flightStatus": "odpt.FlightStatus:OnTime",
      "odpt:aircraftModel": "B772"
    },
    {
      "@type": "odpt:FlightInformationArrival",
      "owl:sameAs": "urn:uuid:sample-3",
      "dc:date": "2026-04-25T14:30:00+09:00",
      "odpt:operator": "odpt.Operator:JAL",
      "odpt:flightNumber": ["JL789"],
      "odpt:departureAirport": "odpt.Airport:FUK",
      "odpt:terminal": "odpt.AirportTerminal:HND.T1",
      "odpt:scheduledTime": "14:55",
      "odpt:estimatedTime": "15:05",
      "odpt:flightStatus": "odpt.FlightStatus:Delayed",
      "odpt:aircraftModel": "A359"
    },
    {
      "@type": "odpt:FlightInformationArrival",
      "owl:sameAs": "urn:uuid:sample-4",
      "dc:date": "2026-04-25T14:30:00+09:00",
      "odpt:operator": "odpt.Operator:ANA",
      "odpt:flightNumber": ["NH012"],
      "odpt:departureAirport": "odpt.Airport:OKA",
      "odpt:terminal": "odpt.AirportTerminal:HND.T2",
      "odpt:scheduledTime": "15:02",
      "odpt:estimatedTime": "15:02",
      "odpt:flightStatus": "odpt.FlightStatus:OnTime",
      "odpt:aircraftModel": null
    },
    {
      "@type": "odpt:FlightInformationArrival",
      "owl:sameAs": "urn:uuid:sample-5",
      "dc:date": "2026-04-25T14:30:00+09:00",
      "odpt:operator": "odpt.Operator:JAL",
      "odpt:flightNumber": ["JL999"],
      "odpt:departureAirport": "odpt.Airport:UKB",
      "odpt:terminal": "odpt.AirportTerminal:HND.T3",
      "odpt:scheduledTime": "15:30",
      "odpt:estimatedTime": "15:30",
      "odpt:flightStatus": "odpt.FlightStatus:OnTime",
      "odpt:aircraftModel": "B788"
    }
  ]
  ```

  注：実フォーマットが異なる場合は Task 1 のメモを反映して修正する。

- [ ] **Step 3: コミット**

  ```bash
  git add tests/fixtures/odpt-arrival-sample.json
  git commit -m "test(arrivals): ODPT応答サンプル fixture 追加"
  ```

---

## Task 6: pax-estimator.mjs（搭乗者数推定）— TDD

**Files:**
- Create: `tests/pax-estimator.test.mjs`
- Create: `scripts/lib/pax-estimator.mjs`

- [ ] **Step 1: 失敗するテストを書く**

  `tests/pax-estimator.test.mjs`:
  ```javascript
  import { test } from 'node:test';
  import { strict as assert } from 'node:assert';
  import { estimatePax } from '../scripts/lib/pax-estimator.mjs';

  const seatsMaster = {
    'B789': { name: 'Boeing 787-9', seats: 246 },
    'A359': { name: 'Airbus A350-900', seats: 369 }
  };
  const factorsMaster = {
    default: 0.70,
    routes: { 'ITM': 0.78, 'OKA': 0.82 }
  };

  test('機材判明・路線判明で 座席×路線搭乗率', () => {
    const r = estimatePax({ aircraftCode: 'B789', from: 'ITM' }, seatsMaster, factorsMaster);
    assert.equal(r.seatCount, 246);
    assert.equal(r.loadFactor, 0.78);
    assert.equal(r.loadFactorSource, 'route');
    assert.equal(r.estimatedPax, Math.round(246 * 0.78));
  });

  test('機材判明・路線統計なしで デフォルト搭乗率', () => {
    const r = estimatePax({ aircraftCode: 'B789', from: 'XXX' }, seatsMaster, factorsMaster);
    assert.equal(r.loadFactor, 0.70);
    assert.equal(r.loadFactorSource, 'default');
    assert.equal(r.estimatedPax, Math.round(246 * 0.70));
  });

  test('機材nullで 全フィールドnull', () => {
    const r = estimatePax({ aircraftCode: null, from: 'ITM' }, seatsMaster, factorsMaster);
    assert.equal(r.seatCount, null);
    assert.equal(r.loadFactor, null);
    assert.equal(r.loadFactorSource, null);
    assert.equal(r.estimatedPax, null);
  });

  test('機材コードがマスタに存在しない場合も全nullとして扱う', () => {
    const r = estimatePax({ aircraftCode: 'UNKNOWN', from: 'ITM' }, seatsMaster, factorsMaster);
    assert.equal(r.seatCount, null);
    assert.equal(r.estimatedPax, null);
  });
  ```

- [ ] **Step 2: テスト実行（失敗を確認）**

  Run: `node --test tests/pax-estimator.test.mjs`
  Expected: 4件すべて FAIL（モジュールが存在しない）

- [ ] **Step 3: 最小実装**

  `scripts/lib/pax-estimator.mjs`:
  ```javascript
  /**
   * 搭乗者数推定（純関数）
   * @param {{aircraftCode: string|null, from: string}} flight
   * @param {Object} seatsMaster - aircraft-seats.json の中身
   * @param {{default: number, routes: Object}} factorsMaster - load-factors.json の中身
   * @returns {{seatCount, loadFactor, loadFactorSource, estimatedPax}}
   */
  export function estimatePax(flight, seatsMaster, factorsMaster) {
    const { aircraftCode, from } = flight;
    if (!aircraftCode || !seatsMaster[aircraftCode]) {
      return { seatCount: null, loadFactor: null, loadFactorSource: null, estimatedPax: null };
    }
    const seats = seatsMaster[aircraftCode].seats;
    const routeFactor = factorsMaster.routes?.[from];
    const factor = routeFactor ?? factorsMaster.default;
    const source = routeFactor !== undefined ? 'route' : 'default';
    return {
      seatCount: seats,
      loadFactor: factor,
      loadFactorSource: source,
      estimatedPax: Math.round(seats * factor)
    };
  }
  ```

- [ ] **Step 4: テスト実行（成功を確認）**

  Run: `node --test tests/pax-estimator.test.mjs`
  Expected: 4件すべて PASS

- [ ] **Step 5: コミット**

  ```bash
  git add tests/pax-estimator.test.mjs scripts/lib/pax-estimator.mjs
  git commit -m "feat(arrivals): pax-estimator 純関数（TDD）"
  ```

---

## Task 7: arrival-transformer.mjs（ODPT応答→arrivals.json）— TDD

**Files:**
- Create: `tests/arrival-transformer.test.mjs`
- Create: `scripts/lib/arrival-transformer.mjs`

空港コード→日本語名のマッピングは `arrival-transformer.mjs` 内に定数として持つ（10-15路線）。

- [ ] **Step 1: 失敗するテストを書く**

  `tests/arrival-transformer.test.mjs`:
  ```javascript
  import { test } from 'node:test';
  import { strict as assert } from 'node:assert';
  import { readFileSync } from 'node:fs';
  import { transformArrivals } from '../scripts/lib/arrival-transformer.mjs';

  const sample = JSON.parse(readFileSync('./tests/fixtures/odpt-arrival-sample.json', 'utf8'));
  const seatsMaster = {
    'B789': { seats: 246 }, 'B772': { seats: 405 },
    'A359': { seats: 369 }, 'B788': { seats: 200 }
  };
  const factorsMaster = {
    default: 0.70,
    routes: { 'ITM': 0.78, 'CTS': 0.75, 'FUK': 0.75, 'OKA': 0.82 }
  };

  test('ODPT応答からflights配列を生成', () => {
    const r = transformArrivals(sample, seatsMaster, factorsMaster);
    assert.equal(Array.isArray(r.flights), true);
    assert.equal(r.flights.length, 5);
  });

  test('便名・出発空港・ターミナルが正しく抽出される', () => {
    const r = transformArrivals(sample, seatsMaster, factorsMaster);
    const f = r.flights[0];
    assert.equal(f.flightNumber, 'JL123');
    assert.equal(f.from, 'ITM');
    assert.equal(f.fromName, '伊丹');
    assert.equal(f.terminal, 'T1');
  });

  test('機材null便は推定値もnull', () => {
    const r = transformArrivals(sample, seatsMaster, factorsMaster);
    const f = r.flights.find(x => x.flightNumber === 'NH012');
    assert.equal(f.aircraftCode, null);
    assert.equal(f.estimatedPax, null);
  });

  test('遅延便のステータスとestimatedTimeが正しい', () => {
    const r = transformArrivals(sample, seatsMaster, factorsMaster);
    const f = r.flights.find(x => x.flightNumber === 'JL789');
    assert.equal(f.status, '遅延');
    assert.equal(f.estimatedTime, '15:05');
    assert.equal(f.scheduledTime, '14:55');
  });

  test('stats が便数集計を返す', () => {
    const r = transformArrivals(sample, seatsMaster, factorsMaster);
    assert.equal(r.stats.totalFlights, 5);
    assert.equal(r.stats.unknownAircraft, 1);
    assert.deepEqual(r.stats.byTerminal, { T1: 2, T2: 2, T3: 1 });
  });

  test('updatedAt が ISO8601 形式（+09:00）', () => {
    const r = transformArrivals(sample, seatsMaster, factorsMaster);
    assert.match(r.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/);
  });
  ```

- [ ] **Step 2: テスト実行（失敗を確認）**

  Run: `node --test tests/arrival-transformer.test.mjs`
  Expected: 6件すべて FAIL

- [ ] **Step 3: 最小実装**

  `scripts/lib/arrival-transformer.mjs`:
  ```javascript
  import { estimatePax } from './pax-estimator.mjs';

  const AIRPORT_NAMES = {
    'ITM': '伊丹', 'CTS': '千歳', 'FUK': '福岡', 'OKA': '那覇',
    'KIX': '関空', 'NGO': '中部', 'HIJ': '広島', 'KMJ': '熊本',
    'KOJ': '鹿児島', 'KMI': '宮崎', 'KCZ': '高知', 'AKJ': '旭川',
    'KUH': '釧路', 'MMB': '女満別', 'AOJ': '青森', 'AXT': '秋田',
    'HKD': '函館', 'TOY': '富山', 'KMQ': '小松', 'TAK': '高松',
    'MYJ': '松山', 'OIT': '大分', 'NGS': '長崎', 'ISG': '石垣',
    'MYE': '宮古', 'KKJ': '北九州', 'UKB': '神戸',
    'ICN': 'ソウル', 'PEK': '北京', 'PVG': '上海', 'TPE': '台北',
    'HKG': '香港', 'BKK': 'バンコク', 'SIN': 'シンガポール',
    'JFK': 'ニューヨーク', 'LAX': 'ロサンゼルス', 'LHR': 'ロンドン',
    'CDG': 'パリ', 'FRA': 'フランクフルト', 'SYD': 'シドニー'
  };

  const STATUS_MAP = {
    'odpt.FlightStatus:OnTime': '定刻',
    'odpt.FlightStatus:Delayed': '遅延',
    'odpt.FlightStatus:Arrived': '到着',
    'odpt.FlightStatus:Cancelled': '欠航'
  };

  function extractAirportCode(odptValue) {
    if (!odptValue) return null;
    return odptValue.split(':').pop();
  }

  function extractTerminal(odptValue) {
    if (!odptValue) return null;
    const m = odptValue.match(/HND\.(T\d)/);
    return m ? m[1] : null;
  }

  function extractAirline(odptValue) {
    if (!odptValue) return null;
    return odptValue.split(':').pop();
  }

  function nowJstIso() {
    const d = new Date();
    const jst = new Date(d.getTime() + 9 * 3600 * 1000);
    return jst.toISOString().replace('Z', '+09:00').replace(/\.\d+/, '');
  }

  export function transformArrivals(odptResponse, seatsMaster, factorsMaster) {
    const flights = odptResponse.map(item => {
      const flightNumber = Array.isArray(item['odpt:flightNumber'])
        ? item['odpt:flightNumber'][0]
        : item['odpt:flightNumber'];
      const from = extractAirportCode(item['odpt:departureAirport']);
      const terminal = extractTerminal(item['odpt:terminal']);
      const aircraftCode = item['odpt:aircraftModel'] ?? null;
      const status = STATUS_MAP[item['odpt:flightStatus']] ?? '不明';
      const pax = estimatePax({ aircraftCode, from }, seatsMaster, factorsMaster);
      return {
        flightNumber,
        airline: extractAirline(item['odpt:airline']),
        from,
        fromName: AIRPORT_NAMES[from] ?? from,
        terminal,
        scheduledTime: item['odpt:scheduledTime'] ?? null,
        estimatedTime: item['odpt:estimatedTime'] ?? null,
        actualTime: item['odpt:actualTime'] ?? null,
        status,
        aircraftCode,
        ...pax
      };
    });
    const byTerminal = flights.reduce((acc, f) => {
      if (f.terminal) acc[f.terminal] = (acc[f.terminal] ?? 0) + 1;
      return acc;
    }, {});
    return {
      updatedAt: nowJstIso(),
      source: 'ODPT (api.odpt.org)',
      flights,
      stats: {
        totalFlights: flights.length,
        unknownAircraft: flights.filter(f => f.aircraftCode === null).length,
        byTerminal
      }
    };
  }
  ```

- [ ] **Step 4: テスト実行（成功を確認）**

  Run: `node --test tests/arrival-transformer.test.mjs`
  Expected: 6件すべて PASS

- [ ] **Step 5: コミット**

  ```bash
  git add tests/arrival-transformer.test.mjs scripts/lib/arrival-transformer.mjs
  git commit -m "feat(arrivals): arrival-transformer 純関数（TDD）"
  ```

---

## Task 8: heatmap-aggregator.mjs（30分ビン集計）— TDD

**Files:**
- Create: `tests/heatmap-aggregator.test.mjs`
- Create: `scripts/lib/heatmap-aggregator.mjs`

- [ ] **Step 1: 失敗するテストを書く**

  `tests/heatmap-aggregator.test.mjs`:
  ```javascript
  import { test } from 'node:test';
  import { strict as assert } from 'node:assert';
  import { aggregateHeatmap } from '../scripts/lib/heatmap-aggregator.mjs';

  const flights = [
    { terminal: 'T1', estimatedTime: '14:35', estimatedPax: 192 },
    { terminal: 'T1', estimatedTime: '14:42', estimatedPax: 315 },
    { terminal: 'T1', estimatedTime: '15:02', estimatedPax: 156 },
    { terminal: 'T1', estimatedTime: '15:30', estimatedPax: null },  // 機材不明
    { terminal: 'T2', estimatedTime: '14:50', estimatedPax: 100 }
  ];

  test('指定ターミナルの30分ビン集計', () => {
    const r = aggregateHeatmap(flights, 'T1');
    assert.equal(r.length > 0, true);
    const bin1430 = r.find(b => b.bin === '14:30');
    assert.equal(bin1430.totalPax, 192 + 315);
    assert.equal(bin1430.flightCount, 2);
    assert.equal(bin1430.unknownCount, 0);
  });

  test('機材不明便はtotalPaxから除外され、unknownCountに加算', () => {
    const r = aggregateHeatmap(flights, 'T1');
    const bin1530 = r.find(b => b.bin === '15:30');
    assert.equal(bin1530.totalPax, 0);
    assert.equal(bin1530.flightCount, 1);
    assert.equal(bin1530.unknownCount, 1);
  });

  test('別ターミナルの便は除外される', () => {
    const r = aggregateHeatmap(flights, 'T1');
    const t2only = r.find(b => b.totalPax === 100);
    assert.equal(t2only, undefined);
  });

  test('空配列でも空配列を返す', () => {
    const r = aggregateHeatmap([], 'T1');
    assert.deepEqual(r, []);
  });

  test('isPeak フラグ：最大値の80%以上のビンに付く', () => {
    const r = aggregateHeatmap(flights, 'T1');
    const max = Math.max(...r.map(b => b.totalPax));
    const peak = r.filter(b => b.isPeak);
    peak.forEach(b => assert.equal(b.totalPax >= max * 0.8, true));
  });
  ```

- [ ] **Step 2: テスト実行（失敗を確認）**

  Run: `node --test tests/heatmap-aggregator.test.mjs`
  Expected: 5件すべて FAIL

- [ ] **Step 3: 最小実装**

  `scripts/lib/heatmap-aggregator.mjs`:
  ```javascript
  /**
   * フライト配列を30分ビンで集計
   * @param {Array} flights - { terminal, estimatedTime "HH:MM", estimatedPax }
   * @param {string} terminal - 'T1' | 'T2' | 'T3'
   * @returns {Array<{bin, totalPax, flightCount, unknownCount, isPeak}>}
   */
  export function aggregateHeatmap(flights, terminal) {
    const filtered = flights.filter(f => f.terminal === terminal && f.estimatedTime);
    const bins = new Map();
    for (const f of filtered) {
      const [h, m] = f.estimatedTime.split(':').map(Number);
      const binMin = m < 30 ? '00' : '30';
      const key = `${String(h).padStart(2, '0')}:${binMin}`;
      if (!bins.has(key)) bins.set(key, { bin: key, totalPax: 0, flightCount: 0, unknownCount: 0 });
      const b = bins.get(key);
      b.flightCount += 1;
      if (f.estimatedPax === null) b.unknownCount += 1;
      else b.totalPax += f.estimatedPax;
    }
    const arr = Array.from(bins.values()).sort((a, b) => a.bin.localeCompare(b.bin));
    const max = Math.max(0, ...arr.map(b => b.totalPax));
    return arr.map(b => ({ ...b, isPeak: max > 0 && b.totalPax >= max * 0.8 }));
  }
  ```

- [ ] **Step 4: テスト実行（成功を確認）**

  Run: `node --test tests/heatmap-aggregator.test.mjs`
  Expected: 5件すべて PASS

- [ ] **Step 5: コミット**

  ```bash
  git add tests/heatmap-aggregator.test.mjs scripts/lib/heatmap-aggregator.mjs
  git commit -m "feat(arrivals): heatmap-aggregator 純関数（TDD）"
  ```

---

## Task 9: odpt-client.mjs（API呼び出し）

**Files:**
- Create: `scripts/lib/odpt-client.mjs`

テストは外部APIに依存するため省略（モックは過剰）。エラー時の挙動を try/catch で覆う。

- [ ] **Step 1: 実装**

  `scripts/lib/odpt-client.mjs`:
  ```javascript
  const ENDPOINT = 'https://api.odpt.org/api/v4/odpt:FlightInformationArrival';
  const OPERATORS = ['JAL', 'ANA', 'JJP', 'SKY', 'ADO', 'SNA', 'SFJ'];

  /**
   * ODPT API から羽田到着便を取得
   * @param {string} token - acl:consumerKey
   * @returns {Promise<Array>} odpt:FlightInformationArrival の配列
   */
  export async function fetchHndArrivals(token) {
    if (!token) throw new Error('ODPT token is required');
    const all = [];
    for (const op of OPERATORS) {
      const url = `${ENDPOINT}?odpt:operator=odpt.Operator:${op}&acl:consumerKey=${encodeURIComponent(token)}`;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) {
          console.error(`[odpt-client] ${op} HTTP ${res.status}`);
          continue;
        }
        const data = await res.json();
        const hndOnly = data.filter(item => {
          const t = item['odpt:terminal'];
          return typeof t === 'string' && t.includes('HND');
        });
        all.push(...hndOnly);
      } catch (e) {
        console.error(`[odpt-client] ${op} error: ${e.message}`);
      }
    }
    return all;
  }
  ```

- [ ] **Step 2: コミット**

  ```bash
  git add scripts/lib/odpt-client.mjs
  git commit -m "feat(arrivals): odpt-client（HND到着便取得）"
  ```

---

## Task 10: fetch-arrivals.mjs（オーケストレーション）

**Files:**
- Create: `scripts/fetch-arrivals.mjs`

- [ ] **Step 1: 実装**

  `scripts/fetch-arrivals.mjs`:
  ```javascript
  #!/usr/bin/env node
  import { readFileSync, writeFileSync, existsSync } from 'node:fs';
  import { fetchHndArrivals } from './lib/odpt-client.mjs';
  import { transformArrivals } from './lib/arrival-transformer.mjs';

  const TOKEN = process.env.ODPT_TOKEN;
  if (!TOKEN) {
    console.error('ERROR: ODPT_TOKEN env var is required');
    process.exit(1);
  }

  // JST 5:00 前は到着便がほぼないのでスキップ
  const jstHour = parseInt(
    new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour: 'numeric', hour12: false }),
    10
  );
  if (jstHour < 5) {
    console.log(`JST ${jstHour}:00 - skipping (before 05:00)`);
    process.exit(0);
  }

  const seatsMaster = JSON.parse(readFileSync('./data/aircraft-seats.json', 'utf8'));
  const factorsMaster = JSON.parse(readFileSync('./data/load-factors.json', 'utf8'));

  const odptData = await fetchHndArrivals(TOKEN);
  if (odptData.length === 0) {
    console.error('No arrival data fetched. Skipping write to preserve previous JSON.');
    process.exit(0);
  }

  const out = transformArrivals(odptData, seatsMaster, factorsMaster);
  const outPath = './data/arrivals.json';
  const newJson = JSON.stringify(out, null, 2);

  if (existsSync(outPath)) {
    const prev = readFileSync(outPath, 'utf8');
    const stripUpdatedAt = s => s.replace(/"updatedAt":\s*"[^"]+",?/, '');
    if (stripUpdatedAt(prev) === stripUpdatedAt(newJson)) {
      console.log('No content change. Skipping write.');
      process.exit(0);
    }
  }

  writeFileSync(outPath, newJson, 'utf8');
  console.log(`Wrote ${out.flights.length} flights to ${outPath}`);
  ```

- [ ] **Step 2: ローカル実行確認（手動）**

  Run:
  ```bash
  ODPT_TOKEN=YOUR_TOKEN node scripts/fetch-arrivals.mjs
  ```
  Expected: `data/arrivals.json` が生成され、`Wrote N flights to ./data/arrivals.json` と出る。

- [ ] **Step 3: 生成されたJSONを検査**

  Run:
  ```bash
  jq '.stats' data/arrivals.json
  jq '.flights[0]' data/arrivals.json
  ```
  Expected: `byTerminal` に `T1`/`T2`/`T3` がある。1便目に推定降客等が入っている。

- [ ] **Step 4: コミット（生成された arrivals.json も初回はコミット）**

  ```bash
  git add scripts/fetch-arrivals.mjs data/arrivals.json
  git commit -m "feat(arrivals): fetch-arrivals.mjs オーケストレーション"
  ```

---

## Task 11: GitHub Actions ワークフロー

**Files:**
- Create: `.github/workflows/update-arrivals.yml`

- [ ] **Step 1: ワークフロー作成**

  `.github/workflows/update-arrivals.yml`:
  ```yaml
  name: Update Haneda Arrivals

  on:
    schedule:
      - cron: '*/5 * * * *'
    workflow_dispatch: {}

  permissions:
    contents: write

  jobs:
    update:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4

        - uses: actions/setup-node@v4
          with:
            node-version: '20'

        - name: Fetch arrivals
          env:
            ODPT_TOKEN: ${{ secrets.ODPT_TOKEN }}
          run: node scripts/fetch-arrivals.mjs
          # JST 5:00前はスクリプト側で early-exit する

        - name: Commit if changed
          run: |
            if [ -n "$(git status --porcelain data/arrivals.json)" ]; then
              git config user.name "github-actions[bot]"
              git config user.email "github-actions[bot]@users.noreply.github.com"
              git add data/arrivals.json
              git commit -m "chore(arrivals): auto-update $(TZ=Asia/Tokyo date '+%Y-%m-%d %H:%M JST')"
              git push
            else
              echo "No change. Skipping commit."
            fi
  ```

  注：早朝（JST 5:00前）スキップは `fetch-arrivals.mjs` 側で `process.exit(0)` する。スクリプトが正常終了し、`data/arrivals.json` に差分がないため次のCommitステップも空振りで終わる。

- [ ] **Step 2: コミット**

  ```bash
  git add .github/workflows/update-arrivals.yml
  git commit -m "ci(arrivals): GitHub Actions cron 5分ごと"
  ```

- [ ] **Step 3: GitHub Web UI で workflow_dispatch 手動実行**

  リポジトリ → Actions → "Update Haneda Arrivals" → Run workflow

  Expected: Run が成功し、`data/arrivals.json` が更新される（時間帯による）。

- [ ] **Step 4: cron 自動実行を観察**

  5-15分待ち、Actionsタブで自動Runが成功することを確認。

---

## Task 12: arrivals-data.js（ブラウザ側 fetch）

**Files:**
- Create: `js/arrivals-data.js`

- [ ] **Step 1: 実装**

  `js/arrivals-data.js`:
  ```javascript
  export async function loadArrivals() {
    const res = await fetch('./data/arrivals.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  export function filterByTerminal(arrivals, terminal) {
    return arrivals.flights.filter(f => f.terminal === terminal);
  }

  export function filterByTimeWindow(flights, nowDate, pastMinutes = 30, futureMinutes = 180) {
    const nowMin = nowDate.getHours() * 60 + nowDate.getMinutes();
    return flights.filter(f => {
      const t = f.estimatedTime ?? f.scheduledTime;
      if (!t) return false;
      const [h, m] = t.split(':').map(Number);
      const fMin = h * 60 + m;
      return fMin >= nowMin - pastMinutes && fMin <= nowMin + futureMinutes;
    });
  }

  export function aggregateHeatmapClient(flights) {
    const bins = new Map();
    for (const f of flights) {
      const t = f.estimatedTime ?? f.scheduledTime;
      if (!t) continue;
      const [h, m] = t.split(':').map(Number);
      const binMin = m < 30 ? '00' : '30';
      const key = `${String(h).padStart(2, '0')}:${binMin}`;
      if (!bins.has(key)) bins.set(key, { bin: key, totalPax: 0, flightCount: 0, unknownCount: 0 });
      const b = bins.get(key);
      b.flightCount += 1;
      if (f.estimatedPax === null) b.unknownCount += 1;
      else b.totalPax += f.estimatedPax;
    }
    const arr = Array.from(bins.values()).sort((a, b) => a.bin.localeCompare(b.bin));
    const max = Math.max(0, ...arr.map(b => b.totalPax));
    return arr.map(b => ({ ...b, isPeak: max > 0 && b.totalPax >= max * 0.8 }));
  }

  export function minutesSince(isoString) {
    const t = new Date(isoString);
    return Math.floor((Date.now() - t.getTime()) / 60000);
  }
  ```

- [ ] **Step 2: コミット**

  ```bash
  git add js/arrivals-data.js
  git commit -m "feat(arrivals): ブラウザ側 fetch + フィルタ + 集計"
  ```

---

## Task 13: arrivals-render.js（DOM描画）

**Files:**
- Create: `js/arrivals-render.js`

- [ ] **Step 1: 実装**

  `js/arrivals-render.js`:
  ```javascript
  export function renderHeatmap(container, bins) {
    container.innerHTML = '';
    if (bins.length === 0) {
      container.innerHTML = '<div class="empty">表示可能な時間帯がありません</div>';
      return;
    }
    const maxPax = Math.max(1, ...bins.map(b => b.totalPax));
    for (const b of bins) {
      const row = document.createElement('div');
      row.className = 'heatmap-row' + (b.isPeak ? ' is-peak' : '');
      const widthPct = (b.totalPax / maxPax) * 100;
      const unknownNote = b.unknownCount > 0 ? ` (機材不明${b.unknownCount})` : '';
      row.innerHTML = `
        <span class="heatmap-time">${b.bin}</span>
        <span class="heatmap-bar" style="width:${widthPct}%"></span>
        <span class="heatmap-label">${b.totalPax}人 (${b.flightCount}便)${unknownNote}</span>
      `;
      container.appendChild(row);
    }
  }

  export function renderFlightList(container, flights) {
    container.innerHTML = '';
    if (flights.length === 0) {
      container.innerHTML = '<div class="empty">表示可能な便がありません</div>';
      return;
    }
    for (const f of flights) {
      const row = document.createElement('div');
      const isDelayed = f.status === '遅延';
      const isUnknown = f.aircraftCode === null;
      row.className = 'flight-row' + (isDelayed ? ' is-delayed' : '') + (isUnknown ? ' is-unknown' : '');
      const time = f.estimatedTime ?? f.scheduledTime ?? '--:--';
      const aircraft = f.aircraftCode ?? '機材不明';
      const pax = f.estimatedPax !== null ? `約${f.estimatedPax}人` : '推定不可';
      const factorNote = f.loadFactorSource === 'route'
        ? ` (路線実績 ${Math.round(f.loadFactor * 100)}%)`
        : f.loadFactorSource === 'default'
          ? ` (平均搭乗率 ${Math.round(f.loadFactor * 100)}%)`
          : '';
      const statusIcon = isDelayed ? ' ⚠' : '';
      row.innerHTML = `
        <div class="flight-line1">
          <span class="time">${time}</span>
          <span class="flight-no">${f.flightNumber}</span>
          <span class="from">${f.fromName}</span>
          <span class="aircraft">${aircraft}</span>
        </div>
        <div class="flight-line2">
          <span class="pax">${pax}</span>
          <span class="status">${f.status}${statusIcon}</span>
          <span class="factor">${factorNote}</span>
        </div>
      `;
      container.appendChild(row);
    }
  }

  export function renderUpdatedAt(container, updatedAt, totalUnknownAircraft) {
    const t = new Date(updatedAt);
    const minAgo = Math.floor((Date.now() - t.getTime()) / 60000);
    const stale = minAgo > 10;
    const hh = String(t.getHours()).padStart(2, '0');
    const mm = String(t.getMinutes()).padStart(2, '0');
    container.innerHTML = `
      <span class="updated">最終更新: ${hh}:${mm} (${minAgo}分前)${stale ? ' ⚠ データが古い' : ''}</span>
      <span class="unknown-stat">${totalUnknownAircraft > 0 ? `機材不明: ${totalUnknownAircraft}便` : ''}</span>
      <span class="source">データ出典: ODPT / 国交省統計</span>
    `;
    container.classList.toggle('is-stale', stale);
  }
  ```

- [ ] **Step 2: コミット**

  ```bash
  git add js/arrivals-render.js
  git commit -m "feat(arrivals): DOM描画（ヒートマップ・リスト・フッター）"
  ```

---

## Task 14: arrivals-app.js（状態管理 + 配線）

**Files:**
- Create: `js/arrivals-app.js`

- [ ] **Step 1: 実装**

  `js/arrivals-app.js`:
  ```javascript
  import { loadArrivals, filterByTerminal, filterByTimeWindow, aggregateHeatmapClient } from './arrivals-data.js';
  import { renderHeatmap, renderFlightList, renderUpdatedAt } from './arrivals-render.js';

  const state = { arrivals: null, terminal: 'T1' };

  async function refresh() {
    try {
      state.arrivals = await loadArrivals();
      render();
    } catch (e) {
      document.getElementById('arrivals-error').textContent = `データ取得失敗: ${e.message}`;
      document.getElementById('arrivals-error').hidden = false;
    }
  }

  function render() {
    const all = filterByTerminal(state.arrivals, state.terminal);
    const visible = filterByTimeWindow(all, new Date(), 30, 180);
    const bins = aggregateHeatmapClient(visible);
    renderHeatmap(document.getElementById('heatmap'), bins);
    renderFlightList(document.getElementById('flight-list'), visible);
    renderUpdatedAt(
      document.getElementById('arrivals-footer'),
      state.arrivals.updatedAt,
      state.arrivals.stats.unknownAircraft
    );
    document.querySelectorAll('.terminal-tab').forEach(el => {
      el.classList.toggle('is-active', el.dataset.terminal === state.terminal);
    });
  }

  function setupTerminalTabs() {
    document.querySelectorAll('.terminal-tab').forEach(el => {
      el.addEventListener('click', () => {
        state.terminal = el.dataset.terminal;
        if (state.arrivals) render();
      });
    });
  }

  function setupReload() {
    const btn = document.getElementById('arrivals-reload');
    if (btn) btn.addEventListener('click', refresh);
  }

  setupTerminalTabs();
  setupReload();
  refresh();
  setInterval(refresh, 60000);
  ```

- [ ] **Step 2: コミット**

  ```bash
  git add js/arrivals-app.js
  git commit -m "feat(arrivals): 状態管理 + DOM配線"
  ```

---

## Task 15: arrivals.html（UIエントリ）

**Files:**
- Create: `arrivals.html`

既存の `index.html` / `ic.html` のヘッダースタイルを踏襲する。タブナビは3つ。

- [ ] **Step 1: 実装**

  `arrivals.html`:
  ```html
  <!DOCTYPE html>
  <html lang="ja">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>羽田到着便</title>
    <link rel="manifest" href="./manifest.webmanifest">
    <link rel="apple-touch-icon" href="./icon-180.png">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <style>
      :root { --bg: #0e0e10; --fg: #e8e8e8; --sub: #888; --accent: #4ea1ff; --peak: #ff5252; --warn: #ffb84d; }
      * { box-sizing: border-box; }
      body { margin: 0; background: var(--bg); color: var(--fg); font-family: -apple-system, system-ui, sans-serif; font-size: 15px; }
      header { padding: 8px 12px; border-bottom: 1px solid #222; }
      .app-tabs { display: flex; gap: 8px; }
      .app-tabs a { color: var(--sub); text-decoration: none; padding: 6px 10px; border-radius: 6px; }
      .app-tabs a.active { color: var(--fg); background: #1a1a1d; }
      .terminal-tabs { display: flex; gap: 6px; padding: 8px 12px; border-bottom: 1px solid #222; }
      .terminal-tab { background: #1a1a1d; color: var(--sub); padding: 6px 12px; border-radius: 6px; border: none; cursor: pointer; }
      .terminal-tab.is-active { background: var(--accent); color: #000; }
      section { padding: 8px 12px; }
      h2 { font-size: 13px; color: var(--sub); margin: 8px 0; font-weight: normal; }
      #heatmap .heatmap-row { display: grid; grid-template-columns: 50px 1fr 140px; align-items: center; gap: 8px; padding: 4px 0; }
      .heatmap-time { color: var(--sub); font-variant-numeric: tabular-nums; }
      .heatmap-bar { background: var(--accent); height: 10px; border-radius: 2px; min-width: 2px; }
      .heatmap-row.is-peak .heatmap-bar { background: var(--peak); }
      .heatmap-label { color: var(--fg); font-size: 12px; text-align: right; }
      #flight-list .flight-row { padding: 8px 0; border-bottom: 1px solid #1a1a1d; }
      .flight-line1 { display: flex; gap: 8px; align-items: baseline; }
      .flight-line1 .time { font-weight: bold; min-width: 50px; }
      .flight-line1 .flight-no { color: var(--accent); min-width: 60px; }
      .flight-line1 .from { flex: 1; }
      .flight-line1 .aircraft { color: var(--sub); font-size: 12px; }
      .flight-line2 { display: flex; gap: 8px; color: var(--sub); font-size: 12px; padding-left: 50px; }
      .flight-row.is-delayed { background: rgba(255, 184, 77, 0.08); }
      .flight-row.is-delayed .status { color: var(--warn); }
      .flight-row.is-unknown { opacity: 0.6; }
      footer { padding: 8px 12px; color: var(--sub); font-size: 11px; border-top: 1px solid #222; display: flex; flex-direction: column; gap: 2px; }
      footer.is-stale .updated { color: var(--warn); }
      .empty { color: var(--sub); padding: 12px 0; text-align: center; }
      #arrivals-error { background: #4a1a1a; color: #ffb; padding: 8px; border-radius: 4px; margin: 8px 12px; }
    </style>
  </head>
  <body>
    <header>
      <nav class="app-tabs">
        <a href="./">タイマー</a>
        <a href="./ic.html">IC判定</a>
        <a href="./arrivals.html" class="active">到着便</a>
      </nav>
    </header>

    <div class="terminal-tabs">
      <button class="terminal-tab is-active" data-terminal="T1">T1 (JAL系)</button>
      <button class="terminal-tab" data-terminal="T2">T2 (ANA系)</button>
      <button class="terminal-tab" data-terminal="T3">T3 (国際)</button>
      <button id="arrivals-reload" style="margin-left:auto; background:transparent; color:var(--sub); border:none; cursor:pointer;">↻</button>
    </div>

    <div id="arrivals-error" hidden></div>

    <section>
      <h2>時間帯別 推定降客（30分単位）</h2>
      <div id="heatmap"></div>
    </section>

    <section>
      <h2>便リスト（過去30分〜未来3時間）</h2>
      <div id="flight-list"></div>
    </section>

    <footer id="arrivals-footer"></footer>

    <script type="module" src="./js/arrivals-app.js"></script>
  </body>
  </html>
  ```

- [ ] **Step 2: ローカル確認**

  Run: `npm run serve`
  http://localhost:8000/arrivals.html を開く。

  Expected:
  - 3タブ表示
  - T1/T2/T3切替で表示が変わる
  - ヒートマップとリストが描画される
  - フッターに最終更新と出典

- [ ] **Step 3: コミット**

  ```bash
  git add arrivals.html
  git commit -m "feat(arrivals): UIエントリ HTML（タブ・ヒートマップ・リスト）"
  ```

---

## Task 16: 既存タブに「到着便」リンクを追加

**Files:**
- Modify: `index.html`
- Modify: `ic.html`

既存ファイルの `nav` 部分に到着便を追加する。

- [ ] **Step 1: 既存タブ箇所を確認**

  Run:
  ```bash
  grep -n 'href="./ic.html"\|href="./"' index.html ic.html
  ```
  Expected: 各ファイルでナビゲーションのタブ定義が見つかる。

- [ ] **Step 2: index.html を編集**

  既存の `nav` セクション（タイマー＋IC判定の2タブ）を3タブに変更。
  該当箇所が `<nav>...</nav>` になっているはずなので、`ic.html` リンクの直後に追加：

  ```html
  <a href="./arrivals.html">到着便</a>
  ```

  既存スタイル（`.app-tabs` クラス等）と整合させる。差分は1行追加のみ。

- [ ] **Step 3: ic.html を編集**

  index.htmlと同様に `arrivals.html` リンクを追加。

- [ ] **Step 4: ローカル確認**

  Run: `npm run serve`
  各ページから3タブが見え、相互遷移できることを確認。

- [ ] **Step 5: コミット**

  ```bash
  git add index.html ic.html
  git commit -m "feat(arrivals): 既存タブに到着便リンク追加"
  ```

---

## Task 17: README にデータ出典を追記

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 既存README末尾の「ディレクトリ」セクション直前に追加**

  追加内容（既存スタイルに合わせる）:

  ```markdown
  ## 到着便ビューワー (v0.4)

  羽田到着便と推定降客数を時間帯別に可視化。`arrivals.html` でアクセス。

  ### データソース

  - **到着便スケジュール**: 公共交通オープンデータセンター（ODPT）
    `https://api.odpt.org/` 配下の `odpt:FlightInformationArrival`。
    ライセンス: 公共交通オープンデータ基本ライセンス。
  - **路線別搭乗率**: 国土交通省 航空輸送統計年報。
  - **機材座席数**: ANA / JAL 公式機材ページ（国内線仕様）。

  ### 推定値の注意

  搭乗者数は **推定値** であり、実際の搭乗者数ではない。
  実際の搭乗者数は航空会社の機密情報で、外部から取得不可能。
  推定式: `機材座席数 × 路線別平均搭乗率`。

  ### 更新

  GitHub Actions が JST 5:00-24:00 の間、5分ごとに ODPT API を叩き
  `data/arrivals.json` を更新する。
  ```

- [ ] **Step 2: コミット**

  ```bash
  git add README.md
  git commit -m "docs(arrivals): データ出典・推定の注意を追記"
  ```

---

## Task 18: 全テスト実行と PWA 動作確認

**Files:** （なし。確認のみ）

- [ ] **Step 1: 全テスト走らせる**

  Run: `npm test`
  Expected: 既存68件 + 新規（pax-estimator 4 + arrival-transformer 6 + heatmap-aggregator 5 = 15件）= 計83件すべて PASS

- [ ] **Step 2: ローカルサーバーで全ページ確認**

  Run: `npm run serve`
  - http://localhost:8000/ → タイマー、3タブ表示
  - http://localhost:8000/ic.html → IC判定、3タブ表示
  - http://localhost:8000/arrivals.html → 到着便、ヒートマップ・リスト・フッター

- [ ] **Step 3: iPhone Safariで確認（実機）**

  iPhoneで GitHub Pages 公開URL（`https://hidenaka.github.io/taxi-ic-helper/arrivals.html`）にアクセス。

  - 3タブ表示
  - T1/T2/T3切替が機能
  - ホーム画面追加 → アプリ内に留まる（タブがブラウザに飛ばない）

- [ ] **Step 4: GitHub Actions の cron が正しく回っていることを確認**

  Actionsタブを開いて直近の自動Runが緑であること。`data/arrivals.json` の最終更新コミットが直近5-10分以内であること。

- [ ] **Step 5: 完成タグ付け（任意）**

  ```bash
  git tag v0.4-arrivals
  git push --tags
  ```

---

## 完了基準

- [ ] 全テスト PASS（83件）
- [ ] `data/arrivals.json` が GitHub Actions で5分ごと（JST 5-24時）に更新される
- [ ] iPhone Safari で `arrivals.html` が表示・3タブが機能・ヒートマップとリストが描画される
- [ ] 機材null便がフッター集計に反映される
- [ ] 推定値であることが UI に明示されている
- [ ] README にデータ出典が明記されている

---

## リスク・後続対応

- **Phase 1 で `aircraftModel` の null 率が >50% だった場合**: 便番号→機材の補助マッピング（過去数日のデータから自動収集）を追加検討。これは別 spec / 別 plan で対応。
- **ODPT が LCC をカバーしない場合**: 「JAL/ANAのみ」と arrivals.html フッターに注記追加（1行修正）。
- **commit ログが多すぎる場合**: `arrivals-data` 別ブランチへ push する変更を別 plan で対応。
