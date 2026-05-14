# 機材不明便のフォールバック補完 実装プラン

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ODPT API で `aircraftType=(MISSING)` が返る ANA 国際線 47 便に、便番号辞書 + 路線フォールバックの 2 段補完を加え、`estimatedPax` を 100% 算出可能にする。

**Architecture:** `pax-estimator.mjs` のフォールバックチェーンに 2 つの新マスター (`aircraft-by-flight-number.json` / `aircraft-by-route.json`) を組み込み、機材コードが解決できない便で「便番号 → 路線」の順に typical 機材を引いて補完する。`flight.aircraftCode` 出力フィールド自体は元コード透過で維持し、フロントの「機材不明」表示判定を壊さない。

**Tech Stack:** ES Modules / `node:test` + `node:assert/strict` / Vanilla JS / GitHub Actions / ODPT API

**設計ドキュメント:** `docs/superpowers/specs/2026-05-10-aircraft-fallback-design.md`

---

## File Structure

| ファイル | 種別 | 役割 |
|---|---|---|
| `data/aircraft-seats.json` | Modify | 国際線専用 4 エントリ追加 (B77W-INT / B789-INT / B788-INT / A321-INT) |
| `data/aircraft-by-flight-number.json` | Create | 47 便の `flightNumber → aircraftCode` 辞書 |
| `data/aircraft-by-route.json` | Create | 33 路線の `originAirport → aircraftCode` フォールバック辞書 |
| `scripts/lib/pax-estimator.mjs` | Modify | `estimatePax` の 4th 引数 `aircraftFallback` 追加、フォールバックチェーン実装 |
| `scripts/lib/arrival-transformer.mjs` | Modify | `transformArrivals` の 5th 引数 `aircraftFallback` 追加、`estimatePax` への配線 |
| `scripts/fetch-arrivals.mjs` | Modify | 新マスター 2 ファイルを読み込み `transformArrivals` に渡す |
| `scripts/generate-mock-arrivals.mjs` | Modify | 同上 (オフライン整合) |
| `tests/pax-estimator.test.mjs` | Modify | フォールバック検証テスト 6 件追加 |
| `tests/arrival-transformer.test.mjs` | Modify | `transformArrivals` 5th 引数の互換テスト追加 |

実装順序: **ロジック先行 → データ収集後行**。テストは inline モックデータで自走するので、データ収集 (Task 5/6) 前にロジック (Task 2-4) を完成させる。

---

## Task 1: `data/aircraft-seats.json` に国際線専用エントリを追加

**Files:**
- Modify: `data/aircraft-seats.json`

- [x] **Step 1.1: 既存ファイルの末尾に 4 エントリを追加**

`data/aircraft-seats.json` の最後の閉じ波括弧 `}` の直前 (`"AT7":  { "name": "ATR 72", "seats": 70 }` の後) にカンマを追加し、以下を挿入:

```json
,
  "B77W-INT": { "name": "Boeing 777-300ER (ANA国際線仕様)", "seats": 264 },
  "B789-INT": { "name": "Boeing 787-9 (ANA国際線仕様)", "seats": 215 },
  "B788-INT": { "name": "Boeing 787-8 (ANA国際線仕様)", "seats": 184 },
  "A321-INT": { "name": "Airbus A321neo (ANA国際線仕様)", "seats": 146 }
```

挿入後、JSON 全体が valid であること:

```bash
cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係"
python3 -c "import json; json.load(open('data/aircraft-seats.json'))"
```

期待: 何も出力されない (valid JSON)。

- [x] **Step 1.2: 全テスト実行 (回帰確認)**

```bash
npm test 2>&1 | tail -8
```

期待: 281 件すべてパス (テストでは新エントリが直接参照されないため件数変わらず)。

- [x] **Step 1.3: コミット**

```bash
git add data/aircraft-seats.json
git commit -m "feat(arrivals): add ANA international seat configurations to seatsMaster"
```

---

## Task 2: `pax-estimator.mjs` にフォールバックチェーンを追加 (TDD)

**Files:**
- Modify: `scripts/lib/pax-estimator.mjs`
- Modify: `tests/pax-estimator.test.mjs`

- [x] **Step 2.1: 失敗テスト 6 件を追加**

`tests/pax-estimator.test.mjs` の末尾 (最後の test ケース直後) に以下を追加:

```javascript
// --- フォールバックチェーン (機材不明 → 便番号辞書 → 路線辞書) ---
const intlSeats = {
  ...fullSeatsMaster,
  'B77W-INT': { name: 'Boeing 777-300ER (国際線仕様)', seats: 264 },
  'B789-INT': { name: 'Boeing 787-9 (国際線仕様)', seats: 215 },
  'B788-INT': { name: 'Boeing 787-8 (国際線仕様)', seats: 184 },
  'A321-INT': { name: 'Airbus A321neo (国際線仕様)', seats: 146 },
};
const fallback = {
  byFlightNumber: { 'NH109': 'B77W-INT', 'NH848': 'B789-INT' },
  byRoute: { 'BKK': 'B789-INT', 'GMP': 'A321-INT' },
};

test('フォールバック: aircraftCode null + 便番号辞書ヒット → 国際線仕様 seatCount', () => {
  const r = estimatePax(
    { aircraftCode: null, flightNumber: 'NH109', from: 'JFK' },
    intlSeats, factorsMaster, fallback
  );
  assert.equal(r.seatCount, 264);
  assert.equal(r.estimatedPax, Math.round(264 * 0.70));
});

test('フォールバック: aircraftCode null + 便番号辞書ミス + 路線辞書ヒット', () => {
  const r = estimatePax(
    { aircraftCode: null, flightNumber: 'NH9999', from: 'BKK' },
    intlSeats, factorsMaster, fallback
  );
  assert.equal(r.seatCount, 215);
  assert.equal(r.estimatedPax, Math.round(215 * 0.70));
});

test('フォールバック: aircraftCode null + 両方ミス → 既存通り null', () => {
  const r = estimatePax(
    { aircraftCode: null, flightNumber: 'NH9999', from: 'XXX' },
    intlSeats, factorsMaster, fallback
  );
  assert.equal(r.seatCount, null);
  assert.equal(r.estimatedPax, null);
});

test('フォールバック: aircraftCode 判明時は辞書を参照しない (回帰)', () => {
  const r = estimatePax(
    { aircraftCode: 'B789', flightNumber: 'NH109', from: 'JFK' },
    intlSeats, factorsMaster, fallback
  );
  assert.equal(r.seatCount, 246);  // 国内線 B789 (フォールバックの B77W-INT=264 を引かない)
});

test('フォールバック: aircraftFallback 引数なしでも既存動作維持 (互換性)', () => {
  const r = estimatePax(
    { aircraftCode: null, flightNumber: 'NH109', from: 'JFK' },
    intlSeats, factorsMaster
  );
  assert.equal(r.seatCount, null);
  assert.equal(r.estimatedPax, null);
});

test('フォールバック: 便番号が辞書の値で seatsMaster ミスなら路線へ進む', () => {
  // byFlightNumber に typo されたコードがあるが seatsMaster にないケース
  const fallbackBad = {
    byFlightNumber: { 'NH109': 'TYPO-CODE' },
    byRoute: { 'JFK': 'B77W-INT' },
  };
  const r = estimatePax(
    { aircraftCode: null, flightNumber: 'NH109', from: 'JFK' },
    intlSeats, factorsMaster, fallbackBad
  );
  assert.equal(r.seatCount, 264);  // 路線フォールバックで救出
});
```

- [x] **Step 2.2: テスト実行 → 失敗確認**

```bash
node --test tests/pax-estimator.test.mjs 2>&1 | tail -5
```

期待: 新 6 件が `not ok` または現状ロジックの戻り値とのミスマッチで失敗。

- [x] **Step 2.3: `pax-estimator.mjs` の `estimatePax` を改修**

`scripts/lib/pax-estimator.mjs` 全体を以下に置き換える:

```javascript
/**
 * 搭乗者数推定（純関数）
 * @param {{aircraftCode: string|null, flightNumber: string, from: string}} flight
 * @param {Object} seatsMaster - aircraft-seats.json の中身
 * @param {{default: number, routes: Object}} factorsMaster - load-factors.json の中身
 * @param {{byFlightNumber: Object, byRoute: Object}} [aircraftFallback] - 機材不明便のフォールバック辞書
 * @returns {{seatCount, loadFactor, loadFactorSource, estimatedPax}}
 */

// ODPT API の aircraftType (IATA派生コード) → seatsMaster のキー (ICAO風) へのマッピング
// 不明なものは元コードのままで lookup される (seatsMaster 直接ヒットする可能性)
const AIRCRAFT_CODE_ALIASES = {
  // Boeing 777
  '77W': 'B77W',
  '772': 'B772',
  '773': 'B773',
  // Boeing 787
  '789': 'B789',
  '788': 'B788',
  '78P': 'B789',  // ANA 787-9 国内線仕様
  '78G': 'B789',  // ANA 787-9 派生
  '78K': 'B788',  // ANA 787-8 派生
  // Boeing 767
  '763': 'B763',
  '76P': 'B763',  // ANA 767 派生
  '76W': 'B763',  // JAL 767 winglets
  // Boeing 737
  '73H': 'B738',  // 737-800 with winglets
  '73D': 'B738',  // ANA 737-800 派生
  '73L': 'B738',  // ANA 737-800 派生
  '73S': 'B738',  // ANA 737-800 short-range 派生
  '738': 'B738',
  // Airbus A350
  '359': 'A359',
  '351': 'A35K',
  // Airbus A320 / A321
  '320': 'A320',
  '321': 'A321',
  '32S': 'A321',
  '32L': 'A321',
  // Embraer
  'E90': 'E90',
  // ANA 内部コード (推定)
  '722': 'B772',  // 短距離仕様の B772 と推定
};

function resolveAircraftKey(rawCode) {
  if (!rawCode) return null;
  return AIRCRAFT_CODE_ALIASES[rawCode] ?? rawCode;
}

function resolveSeats(seatsMaster, code) {
  if (!code) return null;
  return seatsMaster[code] ? code : null;
}

export function estimatePax(flight, seatsMaster, factorsMaster, aircraftFallback) {
  const { aircraftCode, flightNumber, from } = flight;

  // 1. 通常パス: AIRCRAFT_CODE_ALIASES → seatsMaster
  let resolvedCode = resolveSeats(seatsMaster, resolveAircraftKey(aircraftCode));

  // 2. フォールバック: 便番号辞書
  if (!resolvedCode && aircraftFallback?.byFlightNumber && flightNumber) {
    resolvedCode = resolveSeats(seatsMaster, aircraftFallback.byFlightNumber[flightNumber]);
  }

  // 3. フォールバック: 路線辞書
  if (!resolvedCode && aircraftFallback?.byRoute && from) {
    resolvedCode = resolveSeats(seatsMaster, aircraftFallback.byRoute[from]);
  }

  if (!resolvedCode) {
    return { seatCount: null, loadFactor: null, loadFactorSource: null, estimatedPax: null };
  }

  const seats = seatsMaster[resolvedCode].seats;
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

- [x] **Step 2.4: テスト再実行 → パス確認**

```bash
node --test tests/pax-estimator.test.mjs 2>&1 | tail -5
```

期待: 全件パス。

- [x] **Step 2.5: 全テストスイート実行 (回帰確認)**

```bash
npm test 2>&1 | tail -5
```

期待: 全件パス (281 + 6 = 287 件)。

- [x] **Step 2.6: コミット**

```bash
git add scripts/lib/pax-estimator.mjs tests/pax-estimator.test.mjs
git commit -m "feat(arrivals): add fallback chain to estimatePax for missing aircraftType"
```

---

## Task 3: `arrival-transformer.mjs` の signature 拡張

**Files:**
- Modify: `scripts/lib/arrival-transformer.mjs`
- Modify: `tests/arrival-transformer.test.mjs`

- [x] **Step 3.1: テストを追加**

`tests/arrival-transformer.test.mjs` の末尾に以下を追加:

```javascript
test('aircraftFallback: 機材不明便でも便番号辞書で seatCount が埋まる', () => {
  const intlSample = [
    {
      "@type": "odpt:FlightInformationArrival",
      "odpt:flightNumber": ["NH109"],
      "odpt:originAirport": "odpt.Airport:JFK",
      "odpt:arrivalAirportTerminal": "odpt.AirportTerminal:HND.Terminal2",
      "odpt:scheduledArrivalTime": "16:00",
      "odpt:flightStatus": "odpt.FlightStatus:OnTime"
      // odpt:aircraftType は意図的に省略 (= MISSING)
    }
  ];
  const intlSeats = {
    ...seatsMaster,
    'B77W-INT': { name: 'Boeing 777-300ER (国際線仕様)', seats: 264 },
  };
  const aircraftFallback = {
    byFlightNumber: { 'NH109': 'B77W-INT' },
    byRoute: {}
  };
  const r = transformArrivals(intlSample, intlSeats, factorsMaster, null, aircraftFallback);
  assert.equal(r.flights[0].aircraftCode, null);  // 元コード透過
  assert.equal(r.flights[0].seatCount, 264);
  assert.equal(r.flights[0].estimatedPax, Math.round(264 * 0.70));
});

test('aircraftFallback: 引数なし時は既存動作 (機材不明便で seatCount=null)', () => {
  const intlSample = [
    {
      "@type": "odpt:FlightInformationArrival",
      "odpt:flightNumber": ["NH109"],
      "odpt:originAirport": "odpt.Airport:JFK",
      "odpt:arrivalAirportTerminal": "odpt.AirportTerminal:HND.Terminal2",
      "odpt:scheduledArrivalTime": "16:00",
      "odpt:flightStatus": "odpt.FlightStatus:OnTime"
    }
  ];
  const r = transformArrivals(intlSample, seatsMaster, factorsMaster);
  assert.equal(r.flights[0].seatCount, null);
  assert.equal(r.flights[0].estimatedPax, null);
});
```

- [x] **Step 3.2: テスト実行 → 失敗確認 (signature ミスマッチ)**

```bash
node --test tests/arrival-transformer.test.mjs 2>&1 | tail -8
```

期待: 新ケース 1 が `seatCount: null` を返して fail (現 transformArrivals は aircraftFallback を受け付けない)。

- [x] **Step 3.3: `arrival-transformer.mjs` を改修**

`scripts/lib/arrival-transformer.mjs` の `transformArrivals` 関数 (91 行目あたり) のシグネチャと `estimatePax` 呼び出しを以下に変更:

旧:
```javascript
export function transformArrivals(odptResponse, seatsMaster, factorsMaster, taxiOpts = null) {
  const flights = odptResponse.map(item => {
    ...
    const pax = estimatePax({ aircraftCode, from }, seatsMaster, factorsMaster);
```

新:
```javascript
export function transformArrivals(odptResponse, seatsMaster, factorsMaster, taxiOpts = null, aircraftFallback = null) {
  const flights = odptResponse.map(item => {
    ...
    const flightNumber = Array.isArray(item['odpt:flightNumber'])
      ? item['odpt:flightNumber'][0]
      : item['odpt:flightNumber'];
    ...
    const pax = estimatePax({ aircraftCode, flightNumber, from }, seatsMaster, factorsMaster, aircraftFallback);
```

`flightNumber` の抽出は既に baseFields でやっているので、その変数を `estimatePax` 呼び出しの直前で参照する形になる。具体的には `const flightNumber = ...` の宣言は既にあるので位置を `estimatePax` 呼び出し前に保つだけ (現行コード通り)、`estimatePax` の第 1 引数オブジェクトに `flightNumber` を追加するのと、第 4 引数 `aircraftFallback` を追加する 2 点のみ。

- [x] **Step 3.4: テスト再実行 → パス確認**

```bash
node --test tests/arrival-transformer.test.mjs 2>&1 | tail -5
```

期待: 全件パス。

- [x] **Step 3.5: 全テストスイート実行**

```bash
npm test 2>&1 | tail -5
```

期待: 全件パス (287 + 2 = 289 件)。

- [x] **Step 3.6: コミット**

```bash
git add scripts/lib/arrival-transformer.mjs tests/arrival-transformer.test.mjs
git commit -m "feat(arrivals): pass aircraftFallback through transformArrivals to estimatePax"
```

---

## Task 4: `fetch-arrivals.mjs` と `generate-mock-arrivals.mjs` の配線

**Files:**
- Modify: `scripts/fetch-arrivals.mjs`
- Modify: `scripts/generate-mock-arrivals.mjs`

- [x] **Step 4.1: `fetch-arrivals.mjs` で master を読み込み、transformArrivals に渡す**

`scripts/fetch-arrivals.mjs` の master 読み込みブロック (`const seatsMaster = ...` あたり、22 行目付近) に以下を追加:

```javascript
const aircraftByFlightNumberMaster = JSON.parse(readFileSync('./data/aircraft-by-flight-number.json', 'utf8'));
const aircraftByRouteMaster = JSON.parse(readFileSync('./data/aircraft-by-route.json', 'utf8'));
```

`transformArrivals` 呼び出し (57 行目付近) を以下に変更:

旧:
```javascript
const out = transformArrivals(odptData, seatsMaster, factorsMaster, {
  ...
});
```

新:
```javascript
const out = transformArrivals(
  odptData,
  seatsMaster,
  factorsMaster,
  {
    transitShare: transitShareMaster,
    routes: routesMaster,
    egress: egressMaster,
    railStatus: railStatusOperators,
    dayType,
    weatherContext
  },
  {
    byFlightNumber: aircraftByFlightNumberMaster.flights,
    byRoute: aircraftByRouteMaster.routes
  }
);
```

- [x] **Step 4.2: `generate-mock-arrivals.mjs` で同様に master を読み込み、transformArrivals に渡す**

`scripts/generate-mock-arrivals.mjs` の master 読み込みブロック (`const seatsMaster = ...` 付近) に以下を追加:

```javascript
const aircraftByFlightNumberMaster = JSON.parse(readFileSync('./data/aircraft-by-flight-number.json', 'utf8'));
const aircraftByRouteMaster = JSON.parse(readFileSync('./data/aircraft-by-route.json', 'utf8'));
```

`transformArrivals` 呼び出し (149 行目付近) を以下に変更:

旧:
```javascript
const out = transformArrivals(odptItems, seatsMaster, factorsMaster, {
  ...
});
```

新:
```javascript
const out = transformArrivals(
  odptItems,
  seatsMaster,
  factorsMaster,
  {
    transitShare,
    routes,
    egress,
    railStatus: railOk,
    dayType,
    weatherContext
  },
  {
    byFlightNumber: aircraftByFlightNumberMaster.flights,
    byRoute: aircraftByRouteMaster.routes
  }
);
```

- [x] **Step 4.3: 構文チェック (両方)**

```bash
node --check scripts/fetch-arrivals.mjs
node --check scripts/generate-mock-arrivals.mjs
```

期待: 両方とも何も出力されない。

- [x] **Step 4.4: コミット (master ファイル未作成のため runtime 検証は Task 5/6 後)**

```bash
git add scripts/fetch-arrivals.mjs scripts/generate-mock-arrivals.mjs
git commit -m "feat(arrivals): wire aircraftFallback masters into fetch and mock scripts"
```

---

## Task 5: `data/aircraft-by-flight-number.json` を作成

**Files:**
- Create: `data/aircraft-by-flight-number.json`

データ収集と JSON 作成はサブエージェントに委譲する (WebFetch / WebSearch を駆使するため)。

- [x] **Step 5.1: サブエージェントに 47 便の機材調査を依頼**

サブエージェント (general-purpose、`isolation: "worktree"` 不要) に以下のタスクを依頼:

```
Task: ANA 国際線 47 便の運航機材を ANA 公式時刻表 / Wikipedia から調査し、
      data/aircraft-by-flight-number.json を作成する。

対象 47 便 (便番号 + 出発空港):
  NH101 IAD, NH107 SFO, NH109 JFK, NH105 LAX, NH111 ORD, NH113 IAH,
  NH115 YVR, NH117 SEA, NH125 LAX, NH159 JFK, NH185 HNL,
  NH204 FRA, NH206 VIE, NH208 MXP, NH212 LHR, NH216 CDG, NH218 MUC,
  NH222 ARN, NH224 FRA,
  NH814 HKG, NH838 DEL, NH842 SIN, NH844 SIN, NH848 BKK, NH850 BKK,
  NH852 TSA, NH854 TSA, NH856 CGK, NH860 HKG, NH862 GMP, NH864 GMP,
  NH868 GMP, NH870 MNL, NH872 CGK, NH878 BKK, NH880 SYD, NH886 KUL,
  NH890 SYD, NH892 SGN,
  NH924 CAN, NH950 TAO, NH962 PEK, NH964 PEK, NH966 SZX,
  NH968 PVG, NH970 SHA, NH972 PVG

機材コードは以下のいずれかにマップ (4 つから選ぶ):
  B77W-INT  Boeing 777-300ER 国際線
  B789-INT  Boeing 787-9 国際線
  B788-INT  Boeing 787-8 国際線
  A321-INT  Airbus A321neo 国際線

出力形式: data/aircraft-by-flight-number.json

```json
{
  "_meta": {
    "source": "ANA 公式時刻表 + Wikipedia (調査日: 2026-05-10)",
    "scope": "ODPT API で aircraftType=(MISSING) が返る ANA 国際線便を補完",
    "updated": "2026-05-10",
    "note": "ANA 季節ダイヤ改正 (3月末/10月末) で要見直し"
  },
  "flights": {
    "NH101": "B77W-INT",
    ...全 47 便...
  }
}
```

調査ソース:
  - https://www.ana.co.jp/ja/jp/international/timetables/
  - Wikipedia「全日本空輸の就航都市」
  - Wikipedia の機材記事 (Boeing 787-9 ANA / Boeing 777-300ER ANA 等)

完了したら、以下も実行:
1. python3 -c "import json; json.load(open('data/aircraft-by-flight-number.json'))" で JSON valid 確認
2. flights キー数が 47 件であることを確認
3. 値がすべて 4 つの許容コードのいずれかであることを確認
```

- [x] **Step 5.2: 出力 JSON の検証**

```bash
cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係"
python3 << 'EOF'
import json
d = json.load(open("data/aircraft-by-flight-number.json"))
flights = d["flights"]
print(f"flight count: {len(flights)}")
allowed = {"B77W-INT", "B789-INT", "B788-INT", "A321-INT"}
invalid = [(k, v) for k, v in flights.items() if v not in allowed]
print(f"invalid entries: {invalid}")
EOF
```

期待: `flight count: 47` / `invalid entries: []`。

- [x] **Step 5.3: コミット**

```bash
git add data/aircraft-by-flight-number.json
git commit -m "feat(arrivals): add ANA international flight-number aircraft dictionary (47 flights)"
```

---

## Task 6: `data/aircraft-by-route.json` を作成

**Files:**
- Create: `data/aircraft-by-route.json`

- [x] **Step 6.1: 33 路線の典型機材を割り当て、JSON ファイルを作成**

`data/aircraft-by-route.json` を以下の内容で作成:

```json
{
  "_meta": {
    "source": "ANA 国際線航続距離別の典型機材 (公式運航パターン、2026-05-10 時点)",
    "scope": "便番号辞書にない便のフォールバック",
    "updated": "2026-05-10",
    "note": "新路線が追加された場合の自動カバー用。便番号辞書より優先度低。距離別の典型機材を採用。"
  },
  "routes": {
    "JFK": "B77W-INT", "ORD": "B77W-INT", "IAD": "B77W-INT", "IAH": "B77W-INT",
    "BOS": "B77W-INT",
    "LAX": "B789-INT", "SFO": "B77W-INT", "SEA": "B789-INT", "YVR": "B789-INT",
    "HNL": "B789-INT",
    "LHR": "B77W-INT", "CDG": "B77W-INT", "FRA": "B77W-INT", "MUC": "B789-INT",
    "VIE": "B789-INT", "MXP": "B789-INT", "ARN": "B789-INT",
    "AMS": "B789-INT", "HEL": "B789-INT", "IST": "B789-INT",
    "SYD": "B789-INT", "MEL": "B789-INT",
    "BKK": "B789-INT", "SIN": "B789-INT", "DEL": "B789-INT",
    "MNL": "B788-INT", "KUL": "B788-INT", "CGK": "B788-INT", "SGN": "B788-INT",
    "HKG": "B788-INT", "DXB": "B789-INT", "DOH": "B789-INT",
    "TSA": "A321-INT", "GMP": "A321-INT", "ICN": "A321-INT",
    "TPE": "A321-INT",
    "PEK": "B788-INT", "PVG": "B788-INT", "SHA": "B788-INT", "CAN": "B788-INT",
    "SZX": "B788-INT", "TAO": "A321-INT"
  }
}
```

割り当ての根拠:
- 北米東海岸 (JFK/ORD/IAD/IAH/BOS): 長距離 → B77W-INT (収容力優先)
- 北米西海岸 (LAX/SFO/SEA/YVR): 中距離 → B789-INT or B77W-INT 混在
- ホノルル (HNL): 中距離リゾート → B789-INT
- 欧州主要 (LHR/CDG/FRA): 長距離 → B77W-INT
- 欧州二次 (VIE/MXP/ARN/AMS/HEL/IST): B789-INT
- アジア中距離 (BKK/SIN/DEL/SYD/MEL): B789-INT
- アジア南 (MNL/KUL/CGK/SGN/HKG): 短中距離 → B788-INT
- 中東 (DXB/DOH): B789-INT
- 韓国・台湾 (GMP/ICN/TSA/TPE): 近距離 → A321-INT
- 中国主要 (PEK/PVG/SHA/CAN/SZX): 中距離 → B788-INT
- 中国地方都市 (TAO 等): 短距離 → A321-INT

将来 ANA が新路線を開設しても、近隣の典型機材がフォールバックとして当たる。

- [x] **Step 6.2: JSON 検証**

```bash
cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係"
python3 << 'EOF'
import json
d = json.load(open("data/aircraft-by-route.json"))
routes = d["routes"]
print(f"route count: {len(routes)}")
allowed = {"B77W-INT", "B789-INT", "B788-INT", "A321-INT"}
invalid = [(k, v) for k, v in routes.items() if v not in allowed]
print(f"invalid entries: {invalid}")
# 47 便が出現する 33 空港すべてが routes にあるか確認
required_origins = {"IAD","SFO","JFK","LAX","ORD","IAH","YVR","SEA","HNL","FRA","VIE","MXP","LHR","CDG","MUC","ARN","HKG","DEL","SIN","BKK","TSA","CGK","GMP","MNL","SYD","KUL","SGN","CAN","TAO","PEK","SZX","PVG","SHA"}
missing = required_origins - set(routes.keys())
print(f"missing origins: {missing}")
EOF
```

期待: `route count` は 40 前後 / `invalid entries: []` / `missing origins: set()`。

- [x] **Step 6.3: コミット**

```bash
git add data/aircraft-by-route.json
git commit -m "feat(arrivals): add ANA international route-based aircraft fallback dictionary"
```

---

## Task 7: 統合検証 (実データで unknownAircraft 件数を計測)

**Files:** 変更なし (検証のみ)

- [x] **Step 7.1: 全テスト最終パス確認**

```bash
cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係"
npm test 2>&1 | tail -5
```

期待: 全件パス (289 件)。

- [x] **Step 7.2: mock 生成で動作確認**

```bash
node scripts/generate-mock-arrivals.mjs 2>&1 | tail -5
```

期待: `Wrote mock 53 flights to data/arrivals.json` のログ。エラーなし。

- [x] **Step 7.3: 実 ODPT データで動作確認**

`.env` から ODPT_TOKEN を読み込んで実行:

```bash
set -a && source .env && set +a
node scripts/fetch-arrivals.mjs 2>&1 | tail -3
```

期待: `Wrote N flights to ./data/arrivals.json` (N は 400〜600)。エラーなし。

- [x] **Step 7.4: unknownAircraft / estimatedPax null 件数を計測**

```bash
python3 << 'EOF'
import json
d = json.load(open("./data/arrivals.json"))
print(f"totalFlights: {d['stats']['totalFlights']}")
print(f"unknownAircraft (aircraftCode=null): {d['stats']['unknownAircraft']}")
null_pax = sum(1 for f in d["flights"] if f["estimatedPax"] is None)
print(f"estimatedPax=null: {null_pax}")
# 47 便の補完が効いているか
ana_intl_codes = ["NH101","NH107","NH109","NH105","NH111","NH113","NH115","NH117","NH125","NH159","NH185","NH204","NH206","NH208","NH212","NH216","NH218","NH222","NH224","NH814","NH838","NH842","NH844","NH848","NH850","NH852","NH854","NH856","NH860","NH862","NH864","NH868","NH870","NH872","NH878","NH880","NH886","NH890","NH892","NH924","NH950","NH962","NH964","NH966","NH968","NH970","NH972"]
intl_with_pax = [f for f in d["flights"] if f["flightNumber"] in ana_intl_codes and f["estimatedPax"] is not None]
intl_total = [f for f in d["flights"] if f["flightNumber"] in ana_intl_codes]
print(f"ANA 国際線 47 便で estimatedPax が埋まっている: {len(intl_with_pax)}/{len(intl_total)}")
EOF
```

期待:
- `unknownAircraft` (= aircraftCode が null の便) は変化なし (フィールド透過のため、設計通り)
- `estimatedPax=null` は **改修前 46〜47 件 → 改修後 0〜2 件** (大幅減)
- `ANA 国際線 47 便で estimatedPax が埋まっている: 47/47` (or 46/46、運航日次第)

- [x] **Step 7.5: ローカルの実データを破棄 (mock に戻す)**

```bash
node scripts/generate-mock-arrivals.mjs
```

または `git restore data/arrivals.json`。

- [x] **Step 7.6: push して本番へ反映**

```bash
git fetch origin
git pull --rebase origin main  # weather/arrivals auto-update を取り込む
git push origin main
```

期待: 本番 Pages デプロイが workflow_run チェーンで自動的に走り、1〜2 分後に本番 URL に反映。

- [x] **Step 7.7: 本番 URL で目視確認**

```
https://hidenaka.github.io/taxi-ic-helper/arrivals.html
```

確認項目:
- T2 / T3 タブで国際線便 (NH848 BKK 等) が「機材不明 / 約N人」表示になっている (機材不明だが推定降客数は出る)
- ヒートマップで 「機材不明M便」が極端に減っている
- staleness バナー fresh

---

## 検証コマンド一覧 (チートシート)

```bash
# 全テスト
npm test

# pax-estimator のみ
node --test tests/pax-estimator.test.mjs

# transformer のみ
node --test tests/arrival-transformer.test.mjs

# 構文チェック
node --check scripts/lib/pax-estimator.mjs
node --check scripts/lib/arrival-transformer.mjs
node --check scripts/fetch-arrivals.mjs
node --check scripts/generate-mock-arrivals.mjs

# JSON valid 確認
python3 -c "import json; json.load(open('data/aircraft-seats.json'))"
python3 -c "import json; json.load(open('data/aircraft-by-flight-number.json'))"
python3 -c "import json; json.load(open('data/aircraft-by-route.json'))"

# mock 生成
node scripts/generate-mock-arrivals.mjs

# 実データ取得 (ODPT_TOKEN セット済みで)
set -a && source .env && set +a && node scripts/fetch-arrivals.mjs
```

---

## 完了条件 (再掲)

- [x] `npm test` 全件パス (289 件)
- [x] mock 生成エラーなし
- [x] 実 ODPT データで `estimatedPax=null` の便が 0〜2 件 (改修前 46〜47 件)
- [x] ANA 国際線 47 便すべてで `estimatedPax` が非 null
- [x] 本番 URL で機材不明件数が大幅減
- [x] `data/aircraft-by-flight-number.json` の `_meta.source` に出典 URL 明記

---

## 実装完了記録 (2026-05-14 検証)

Task 1〜6 のコミットは 2026-05-10〜11 に main へマージ済み。`- [ ]` チェックは未更新のままだったため、本日 (2026-05-14) Task 7 統合検証を実施し一括更新。

### 検証結果

| 項目 | 期待値 | 実測値 |
|---|---|---|
| `npm test` | 全件パス | **372 件 / fail 0** ✅ (Plan 想定 289 → 後続作業で +83 件追加) |
| mock 生成 | エラーなし | **53 flights / pax 合計 2023** ✅ |
| 実 ODPT データ totalFlights | 400〜600 | **539 件** ✅ |
| 実 ODPT `estimatedPax=null` | 0〜2 件 | **1 件** ✅ |
| ANA 国際線 47 便 `estimatedPax` 非 null | 47/47 (運航日次第) | **46/46** ✅ (NH625 等 1 便は本日運航なし) |
| fallback ヒット (aircraftCode=null かつ pax≠null) | — | **46 便** |
| 本番 URL 反映 | 機材不明件数大幅減 | **本番 JSON も同値 (null=1, fallback hit=46)** ✅ |

### 残存 null 1 件 (Plan スコープ外、別途記録)

`NH624 from=KOJ aircraftCode=78I` — ODPT が国内線 NH624 (鹿児島→羽田) に未知コード `78I` を返している。AIRCRAFT_CODE_ALIASES に未登録、aircraft-by-flight-number は国際線のみのため対象外、aircraft-by-route の KOJ も未登録。`78I` は B788 派生 (787-8 ANA国内線?) と推測されるが要調査。後続作業として ALIAS 拡張 or 国内線辞書追加を検討。
