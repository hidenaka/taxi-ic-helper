# 羽田到着便 タクシー候補数予測 実装プラン

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 羽田到着便の推定降客数に「アプリ配車のタクシー客に特化した分担率＋終電到達率＋遅延補正＋ODPT運行情報」を組み合わせ、便ごとのタクシー候補数推定値を出して既存 `arrivals.html` に表示する。

**Architecture:** 既存の純関数パイプライン（`scripts/lib/*.mjs`）に新規純関数（`taxi-estimator.mjs` / `route-reachability.mjs`）を追加。データマスタは全てJSON外出し（`transit-share.json` / `last-mile-routes.json` / `terminal-egress.json` / `rail-status.json`）。GitHub Actions の `update-arrivals.yml` をマスタ読込対応に拡張、`update-rail-status.yml` を新設して京急/モノレール運行情報を5分ごとに取得。

**Tech Stack:** Node 20+ / `node:test` / ES Modules / vanilla JS / GitHub Actions / ODPT API v4

**関連設計**: `docs/superpowers/specs/2026-04-25-haneda-taxi-pax-prediction-design.md`

---

## Phase 1: マスタデータ準備

### Task 1: terminal-egress.json を作成

**Files:**
- Create: `data/terminal-egress.json`

- [ ] **Step 1: マスタファイルを作成**

```json
{
  "_meta": {
    "source": "羽田空港旅客ターミナル公表所要時間（国内線15分・国際線50分の保守値）",
    "updated": "2026-04-25",
    "note": "値は分。国際線は入国審査・税関込み"
  },
  "egress": {
    "T1": { "domestic": 15, "international": 50 },
    "T2": { "domestic": 15, "international": 50 },
    "T3": { "domestic": 15, "international": 50 }
  }
}
```

- [ ] **Step 2: JSON妥当性チェック**

Run: `cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係" && node -e "JSON.parse(require('fs').readFileSync('./data/terminal-egress.json'))" && echo "OK"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add data/terminal-egress.json
git commit -m "feat(data): T1/T2/T3 のロビー出口所要時間マスタ追加"
```

---

### Task 2: last-mile-routes.json を作成

**Files:**
- Create: `data/last-mile-routes.json`

- [ ] **Step 1: マスタファイルを作成**

ルート選定は設計書のセクション2.3に準拠。weight は経験則（千代田・港=大、新宿渋谷=大、横浜=中、深夜需要方面=中、リムジン系=小）の暫定値。

```json
{
  "_meta": {
    "source": "京急電鉄 / 東京モノレール / 東京空港交通 公式時刻表（手動取得）",
    "updated": "2026-04-25",
    "note": "weight は降車地の経験則初期値。過去履歴で校正予定。lastArrival は乗継後の目的地着時刻（ロビー出口時刻からの逆算ベース、平日/休日）。"
  },
  "routes": [
    {
      "id": "chiyoda-minato-rail",
      "name": "千代田・港（東京・新橋・品川・六本木）",
      "via": ["京急", "JR山手線/メトロ"],
      "weekdayLastArrival": "00:30",
      "holidayLastArrival": "00:25",
      "weight": 0.30
    },
    {
      "id": "shinjuku-shibuya-rail",
      "name": "新宿・渋谷（京急→品川→JR山手線）",
      "via": ["京急", "JR山手線"],
      "weekdayLastArrival": "00:15",
      "holidayLastArrival": "00:10",
      "weight": 0.20
    },
    {
      "id": "yokohama-rail",
      "name": "横浜（京急本線直通）",
      "via": ["京急本線"],
      "weekdayLastArrival": "00:30",
      "holidayLastArrival": "00:25",
      "weight": 0.10
    },
    {
      "id": "nerima-seibu-ikebukuro",
      "name": "練馬区（西武池袋線）",
      "via": ["京急", "JR山手線", "西武池袋線"],
      "weekdayLastArrival": "00:00",
      "holidayLastArrival": "23:55",
      "weight": 0.06
    },
    {
      "id": "nerima-toei-oedo",
      "name": "練馬区（都営大江戸線）",
      "via": ["都営浅草線", "都営大江戸線"],
      "weekdayLastArrival": "00:10",
      "holidayLastArrival": "00:05",
      "weight": 0.04
    },
    {
      "id": "itabashi-tobu",
      "name": "板橋（東武東上線）",
      "via": ["京急", "JR山手線", "東武東上線"],
      "weekdayLastArrival": "00:00",
      "holidayLastArrival": "23:55",
      "weight": 0.05
    },
    {
      "id": "itabashi-mita",
      "name": "板橋（都営三田線）",
      "via": ["都営浅草線", "都営三田線"],
      "weekdayLastArrival": "00:05",
      "holidayLastArrival": "00:00",
      "weight": 0.04
    },
    {
      "id": "suginami-jr-chuo",
      "name": "杉並（JR中央線）",
      "via": ["京急", "JR山手線", "JR中央線"],
      "weekdayLastArrival": "00:15",
      "holidayLastArrival": "00:10",
      "weight": 0.05
    },
    {
      "id": "suginami-keio-inokashira",
      "name": "杉並（京王井の頭線）",
      "via": ["京急", "JR山手線", "京王井の頭線"],
      "weekdayLastArrival": "00:00",
      "holidayLastArrival": "23:55",
      "weight": 0.04
    },
    {
      "id": "bus-tokyo-st",
      "name": "東京駅（リムジンバス）",
      "via": ["リムジンバス"],
      "weekdayLastArrival": "23:00",
      "holidayLastArrival": "23:00",
      "weight": 0.04
    },
    {
      "id": "bus-shinjuku",
      "name": "新宿駅（リムジンバス）",
      "via": ["リムジンバス"],
      "weekdayLastArrival": "23:30",
      "holidayLastArrival": "23:30",
      "weight": 0.04
    },
    {
      "id": "bus-nerima-musashino",
      "name": "練馬・吉祥寺方面（リムジンバス）",
      "via": ["リムジンバス"],
      "weekdayLastArrival": "21:30",
      "holidayLastArrival": "21:30",
      "weight": 0.04
    }
  ]
}
```

- [ ] **Step 2: weight 合計が 1.0 ±0.01 の範囲か確認**

Run:
```bash
cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係" && node -e "
const d = JSON.parse(require('fs').readFileSync('./data/last-mile-routes.json'));
const sum = d.routes.reduce((s,r)=>s+r.weight,0);
console.log('weight sum =', sum.toFixed(4));
if (Math.abs(sum - 1.0) > 0.01) { console.error('FAIL: weight合計が1.0でない'); process.exit(1); }
console.log('OK');
"
```
Expected: `weight sum = 1.0000` および `OK`

合計が1.0でない場合は最大ウェイトのルート（chiyoda-minato-rail）で調整。

- [ ] **Step 3: Commit**

```bash
git add data/last-mile-routes.json
git commit -m "feat(data): 主要目的地ルートの実質最終接続時刻マスタ追加（12ルート）"
```

---

### Task 3: transit-share.json を作成

**Files:**
- Create: `data/transit-share.json`

- [ ] **Step 1: マスタファイルを作成**

設計書セクション2.2/2.3/6.1の値をそのまま転記。

```json
{
  "_meta": {
    "source": "ユーザー経験則（アプリ配車のタクシー客）+ 国土交通省 航空旅客動態調査（参考）",
    "scope": "アプリ配車のタクシー客に特化（流し営業・付け待ちと別パターン）",
    "updated": "2026-04-25",
    "note": "全係数は過去乗務履歴データで順次校正する前提。バケット境界はロビー出口時刻ベース。"
  },
  "buckets": [
    { "id": "early",     "label": "7-9時",     "fromHHMM": "07:00", "toHHMM": "09:00", "rates": { "T1": 0.08, "T2": 0.08, "T3": 0.10 } },
    { "id": "morning",   "label": "9-12時",    "fromHHMM": "09:00", "toHHMM": "12:00", "rates": { "T1": 0.11, "T2": 0.11, "T3": 0.12 } },
    { "id": "noon",      "label": "12-15時",   "fromHHMM": "12:00", "toHHMM": "15:00", "rates": { "T1": 0.14, "T2": 0.14, "T3": 0.16 } },
    { "id": "afternoon", "label": "15-17時",   "fromHHMM": "15:00", "toHHMM": "17:00", "rates": { "T1": 0.18, "T2": 0.18, "T3": 0.20 } },
    { "id": "peak1",     "label": "17-19時",   "fromHHMM": "17:00", "toHHMM": "19:00", "rates": { "T1": 0.24, "T2": 0.24, "T3": 0.22 } },
    { "id": "evening",   "label": "19-21:30", "fromHHMM": "19:00", "toHHMM": "21:30", "rates": { "T1": 0.14, "T2": 0.14, "T3": 0.18 } },
    { "id": "peak2",     "label": "21:30-24時","fromHHMM": "21:30", "toHHMM": "24:00", "rates": { "T1": 0.21, "T2": 0.21, "T3": 0.22 } },
    { "id": "midnight",  "label": "24時以降",  "fromHHMM": "24:00", "toHHMM": "27:00", "rates": { "T1": 0.05, "T2": 0.05, "T3": 0.22 } }
  ],
  "reachBoost": [
    { "minRate": 0.9, "boost": 1.0 },
    { "minRate": 0.5, "boost": 1.3 },
    { "minRate": 0.1, "boost": 1.8 },
    { "minRate": 0.0, "boost": 2.5 }
  ],
  "delayBoost": {
    "minDelayMinutes": 60,
    "minLobbyExitTime": "23:30",
    "boost": 1.15
  },
  "maxRatio": 0.85,
  "fallbackRate": 0.10
}
```

- [ ] **Step 2: JSON妥当性チェック**

Run:
```bash
cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係" && node -e "
const d = JSON.parse(require('fs').readFileSync('./data/transit-share.json'));
console.log('buckets:', d.buckets.length, ' reachBoost:', d.reachBoost.length);
if (d.buckets.length !== 8) { console.error('FAIL: buckets must be 8'); process.exit(1); }
if (d.reachBoost.length !== 4) { console.error('FAIL: reachBoost must be 4'); process.exit(1); }
console.log('OK');
"
```
Expected: `buckets: 8 reachBoost: 4` および `OK`

- [ ] **Step 3: Commit**

```bash
git add data/transit-share.json
git commit -m "feat(data): タクシー分担率マスタ追加（時間帯×ターミナル＋reachブースト＋遅延ブースト）"
```

---

### Task 4: マスタJSONの構造整合性テスト

**Files:**
- Modify: `tests/data-integrity.test.js`

- [ ] **Step 1: 既存ファイルを確認**

Run: `cat "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係/tests/data-integrity.test.js" | head -20`
既存のテストパターンを把握する。

- [ ] **Step 2: テスト追加（失敗テスト書く）**

`tests/data-integrity.test.js` の末尾に以下を追加：

```js
import { test as testM } from 'node:test';
import { strict as assertM } from 'node:assert';
import { readFileSync as rfs } from 'node:fs';

testM('transit-share.json: 8 buckets × 3 terminals × 4 boost levels', () => {
  const d = JSON.parse(rfs('./data/transit-share.json', 'utf8'));
  assertM.equal(d.buckets.length, 8);
  for (const b of d.buckets) {
    assertM.ok(['T1', 'T2', 'T3'].every(t => typeof b.rates[t] === 'number'));
    assertM.ok(b.rates.T1 >= 0 && b.rates.T1 <= 1);
  }
  assertM.equal(d.reachBoost.length, 4);
  assertM.equal(d.maxRatio, 0.85);
  assertM.ok(typeof d.fallbackRate === 'number');
});

testM('last-mile-routes.json: 全ルートが必須フィールドを持ち weight 合計が 1.0 ±0.01', () => {
  const d = JSON.parse(rfs('./data/last-mile-routes.json', 'utf8'));
  assertM.ok(d.routes.length >= 10);
  let sum = 0;
  for (const r of d.routes) {
    assertM.ok(typeof r.id === 'string' && r.id.length > 0);
    assertM.ok(typeof r.weekdayLastArrival === 'string');
    assertM.ok(typeof r.holidayLastArrival === 'string');
    assertM.ok(typeof r.weight === 'number' && r.weight > 0);
    sum += r.weight;
  }
  assertM.ok(Math.abs(sum - 1.0) <= 0.01, `weight sum = ${sum}`);
});

testM('terminal-egress.json: T1/T2/T3 全部に domestic/international', () => {
  const d = JSON.parse(rfs('./data/terminal-egress.json', 'utf8'));
  for (const term of ['T1', 'T2', 'T3']) {
    assertM.ok(typeof d.egress[term].domestic === 'number');
    assertM.ok(typeof d.egress[term].international === 'number');
  }
});
```

注: 既存テストとシンボル衝突を避けるため `testM` `assertM` `rfs` で別名 import する。既存ファイルが ESM か CJS かは Step 1 で確認。CJS なら別ファイル `tests/master-integrity.test.mjs` として独立追加する。

- [ ] **Step 3: テストを走らせて失敗を確認 → 通過**

Run: `cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係" && npm test -- --test-name-pattern="transit-share|last-mile|terminal-egress" 2>&1 | tail -30`
Expected: 3 tests pass（マスタは既に存在するため即PASS）

全テスト走らせて既存86件の非破壊確認:
Run: `cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係" && npm test 2>&1 | tail -10`
Expected: tests pass の数が増えていること（86件→89件以上）

- [ ] **Step 4: Commit**

```bash
git add tests/
git commit -m "test(data): マスタJSON3種の構造整合性テスト追加"
```

---

## Phase 2: 純関数（コアロジック）

### Task 5: route-reachability.mjs を TDD で実装

**Files:**
- Create: `scripts/lib/route-reachability.mjs`
- Create: `tests/route-reachability.test.mjs`

#### Step 1-3: computeLobbyExitTime のテスト＆実装

- [ ] **Step 1: 失敗テストを書く**

`tests/route-reachability.test.mjs`:
```js
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { computeLobbyExitTime } from '../scripts/lib/route-reachability.mjs';

const egress = {
  T1: { domestic: 15, international: 50 },
  T2: { domestic: 15, international: 50 },
  T3: { domestic: 15, international: 50 }
};

test('国内線 T1 15:30着 → 15:45ロビー出口', () => {
  assert.equal(computeLobbyExitTime('15:30', 'T1', false, egress), '15:45');
});

test('国際線 T3 21:30着 → 22:20ロビー出口', () => {
  assert.equal(computeLobbyExitTime('21:30', 'T3', true, egress), '22:20');
});

test('日跨ぎ国内線 T2 23:50着 → 翌00:05表記', () => {
  assert.equal(computeLobbyExitTime('23:50', 'T2', false, egress), '24:05');
});

test('estimatedTime null → null', () => {
  assert.equal(computeLobbyExitTime(null, 'T1', false, egress), null);
});

test('terminalがマスタにない → null', () => {
  assert.equal(computeLobbyExitTime('15:30', 'TX', false, egress), null);
});
```

- [ ] **Step 2: テスト失敗確認**

Run: `cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係" && node --test tests/route-reachability.test.mjs 2>&1 | tail -20`
Expected: FAIL（モジュール未存在）

- [ ] **Step 3: 実装**

`scripts/lib/route-reachability.mjs`:
```js
/**
 * "HH:MM" → 分（24時を超える場合もそのまま）
 */
export function hhmmToMinutes(hhmm) {
  if (!hhmm || typeof hhmm !== 'string') return null;
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/**
 * 分 → "HH:MM"（24時を超える場合は "24:05" 等で返す）
 */
export function minutesToHhmm(min) {
  if (typeof min !== 'number' || isNaN(min)) return null;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * ロビー出口時刻を計算
 * @param {string} estimatedTime "HH:MM"
 * @param {string} terminal "T1"|"T2"|"T3"
 * @param {boolean} isInternational
 * @param {{egress: Object}} egressMaster
 * @returns {string|null} "HH:MM" or null
 */
export function computeLobbyExitTime(estimatedTime, terminal, isInternational, egressMaster) {
  const baseMin = hhmmToMinutes(estimatedTime);
  if (baseMin === null) return null;
  const t = egressMaster?.egress?.[terminal];
  if (!t) return null;
  const add = isInternational ? t.international : t.domestic;
  return minutesToHhmm(baseMin + add);
}
```

- [ ] **Step 4: テスト通過確認**

Run: `cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係" && node --test tests/route-reachability.test.mjs 2>&1 | tail -20`
Expected: 5 tests pass

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/route-reachability.mjs tests/route-reachability.test.mjs
git commit -m "feat(reach): computeLobbyExitTime 純関数（TDD）"
```

#### Step 6-9: computeReachRate のテスト＆実装

- [ ] **Step 6: 失敗テストを追加**

`tests/route-reachability.test.mjs` 末尾に追記：
```js
import { computeReachRate } from '../scripts/lib/route-reachability.mjs';

const sampleRoutes = {
  routes: [
    { id: 'a', weekdayLastArrival: '00:30', holidayLastArrival: '00:30', weight: 0.40, via: ['京急'] },
    { id: 'b', weekdayLastArrival: '23:30', holidayLastArrival: '23:00', weight: 0.30, via: ['モノレール'] },
    { id: 'c', weekdayLastArrival: '21:30', holidayLastArrival: '21:30', weight: 0.30, via: ['リムジンバス'] }
  ]
};

const railOk = { Keikyu: { status: 'OnTime', delayMinutes: 0 }, TokyoMonorail: { status: 'OnTime', delayMinutes: 0 } };

test('全ルート到達可: reachRate = 1.0', () => {
  const r = computeReachRate('20:00', sampleRoutes, 'weekday', railOk);
  assert.equal(r.reachRate, 1.0);
  assert.equal(r.blockedRoutes.length, 0);
});

test('一部不可（c のみ22時超え）: weight比率で 0.7', () => {
  const r = computeReachRate('22:00', sampleRoutes, 'weekday', railOk);
  assert.ok(Math.abs(r.reachRate - 0.7) < 0.001);
  assert.equal(r.blockedRoutes.length, 1);
  assert.equal(r.blockedRoutes[0].id, 'c');
});

test('全不可（24:00超え）: reachRate = 0', () => {
  const r = computeReachRate('00:45', sampleRoutes, 'weekday', railOk);
  // 00:45 は深夜の早朝ではなく、ロビー出口時刻として扱う場合は "24:45" 表記が妥当だが、
  // 入力が "00:45" のまま渡された場合は午前0時45分として扱う。
  // → 前日の便なら lobbyExitTime は "24:45" 形式で来る前提。"00:45" は翌日扱い。
  // 実装は内部で 24時超え表記を許容する。
  // ここでは "24:45" を渡してテスト
  const r2 = computeReachRate('24:45', sampleRoutes, 'weekday', railOk);
  assert.equal(r2.reachRate, 0);
});

test('京急運休: 京急経由ルート(a)を除外、reachRate=0.6', () => {
  const railNg = { Keikyu: { status: 'Suspended', delayMinutes: 0 }, TokyoMonorail: { status: 'OnTime', delayMinutes: 0 } };
  const r = computeReachRate('20:00', sampleRoutes, 'weekday', railNg);
  assert.ok(Math.abs(r.reachRate - 0.6) < 0.001);
  const ids = r.blockedRoutes.map(x => x.id);
  assert.ok(ids.includes('a'));
});

test('holiday指定で別の終電時刻を参照', () => {
  const r = computeReachRate('23:15', sampleRoutes, 'holiday', railOk);
  // 平日 a:00:30 b:23:30 c:21:30 → 全可
  // 休日 a:00:30 b:23:00 c:21:30 → b不可
  // 23:15 vs holiday: a可(00:30) b不可(23:00) c不可(21:30) → 0.40
  assert.ok(Math.abs(r.reachRate - 0.40) < 0.001);
});
```

- [ ] **Step 7: テスト失敗確認**

Run: `cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係" && node --test tests/route-reachability.test.mjs 2>&1 | tail -20`
Expected: 5 tests fail（computeReachRate未実装）

- [ ] **Step 8: 実装追加**

`scripts/lib/route-reachability.mjs` に追記：
```js
const RAIL_BLOCKED_STATUSES = new Set(['Suspended', 'Cancelled']);
const RAIL_DELAY_THRESHOLD_MIN = 30;

function isRailBlocked(railStatus) {
  if (!railStatus) return false;
  if (RAIL_BLOCKED_STATUSES.has(railStatus.status)) return true;
  if ((railStatus.delayMinutes ?? 0) >= RAIL_DELAY_THRESHOLD_MIN) return true;
  return false;
}

function routeBlockedByRail(route, rail) {
  if (!rail) return false;
  const via = route.via ?? [];
  if (via.some(v => v.includes('京急')) && isRailBlocked(rail.Keikyu)) return true;
  if (via.some(v => v.includes('モノレール')) && isRailBlocked(rail.TokyoMonorail)) return true;
  return false;
}

/**
 * @param {string} lobbyExitTime "HH:MM"（24時超え可）
 * @param {{routes: Array}} routesMaster
 * @param {'weekday'|'holiday'} dayType
 * @param {Object} railStatus { Keikyu: {...}, TokyoMonorail: {...} } or null
 * @returns {{reachRate: number, reachableRoutes: Array, blockedRoutes: Array}}
 */
export function computeReachRate(lobbyExitTime, routesMaster, dayType, railStatus) {
  const exitMin = hhmmToMinutes(lobbyExitTime);
  const routes = routesMaster?.routes ?? [];
  const reachable = [];
  const blocked = [];
  let totalWeight = 0;
  let reachWeight = 0;
  for (const r of routes) {
    totalWeight += r.weight;
    const lastStr = dayType === 'holiday' ? r.holidayLastArrival : r.weekdayLastArrival;
    const lastMin = hhmmToMinutes(lastStr);
    const blockedByRail = routeBlockedByRail(r, railStatus);
    const tooLate = exitMin === null || lastMin === null || exitMin > lastMin;
    if (blockedByRail || tooLate) {
      blocked.push({ id: r.id, reason: blockedByRail ? 'rail' : 'time' });
    } else {
      reachable.push(r);
      reachWeight += r.weight;
    }
  }
  const reachRate = totalWeight > 0 ? reachWeight / totalWeight : 0;
  return { reachRate, reachableRoutes: reachable, blockedRoutes: blocked };
}
```

- [ ] **Step 9: テスト通過確認**

Run: `cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係" && node --test tests/route-reachability.test.mjs 2>&1 | tail -20`
Expected: 全テスト pass

- [ ] **Step 10: Commit**

```bash
git add scripts/lib/route-reachability.mjs tests/route-reachability.test.mjs
git commit -m "feat(reach): computeReachRate（重み付き到達率＋ODPT運行情報考慮）"
```

---

### Task 6: taxi-estimator.mjs を TDD で実装

**Files:**
- Create: `scripts/lib/taxi-estimator.mjs`
- Create: `tests/taxi-estimator.test.mjs`

- [ ] **Step 1: 失敗テストを書く**

`tests/taxi-estimator.test.mjs`:
```js
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { estimateTaxiPax, pickBucket, pickBoost } from '../scripts/lib/taxi-estimator.mjs';

const transitShare = {
  buckets: [
    { id: 'early',     label: '7-9時',     fromHHMM: '07:00', toHHMM: '09:00', rates: { T1: 0.08, T2: 0.08, T3: 0.10 } },
    { id: 'morning',   label: '9-12時',    fromHHMM: '09:00', toHHMM: '12:00', rates: { T1: 0.11, T2: 0.11, T3: 0.12 } },
    { id: 'noon',      label: '12-15時',   fromHHMM: '12:00', toHHMM: '15:00', rates: { T1: 0.14, T2: 0.14, T3: 0.16 } },
    { id: 'afternoon', label: '15-17時',   fromHHMM: '15:00', toHHMM: '17:00', rates: { T1: 0.18, T2: 0.18, T3: 0.20 } },
    { id: 'peak1',     label: '17-19時',   fromHHMM: '17:00', toHHMM: '19:00', rates: { T1: 0.24, T2: 0.24, T3: 0.22 } },
    { id: 'evening',   label: '19-21:30',  fromHHMM: '19:00', toHHMM: '21:30', rates: { T1: 0.14, T2: 0.14, T3: 0.18 } },
    { id: 'peak2',     label: '21:30-24時',  fromHHMM: '21:30', toHHMM: '24:00', rates: { T1: 0.21, T2: 0.21, T3: 0.22 } },
    { id: 'midnight',  label: '24時以降',  fromHHMM: '24:00', toHHMM: '27:00', rates: { T1: 0.05, T2: 0.05, T3: 0.22 } }
  ],
  reachBoost: [
    { minRate: 0.9, boost: 1.0 },
    { minRate: 0.5, boost: 1.3 },
    { minRate: 0.1, boost: 1.8 },
    { minRate: 0.0, boost: 2.5 }
  ],
  delayBoost: { minDelayMinutes: 60, minLobbyExitTime: '23:30', boost: 1.15 },
  maxRatio: 0.85,
  fallbackRate: 0.10
};

test('pickBucket: 18:30 → peak1', () => {
  assert.equal(pickBucket('18:30', transitShare).id, 'peak1');
});

test('pickBucket: 21:00 → evening (境界 21:30 未満)', () => {
  assert.equal(pickBucket('21:00', transitShare).id, 'evening');
});

test('pickBucket: 21:30 → peak2 (境界 ちょうど)', () => {
  assert.equal(pickBucket('21:30', transitShare).id, 'peak2');
});

test('pickBucket: 24:30 → midnight', () => {
  assert.equal(pickBucket('24:30', transitShare).id, 'midnight');
});

test('pickBucket: 06:30 → null（範囲外）', () => {
  assert.equal(pickBucket('06:30', transitShare), null);
});

test('pickBoost: reachRate=1.0 → 1.0', () => {
  assert.equal(pickBoost(1.0, transitShare), 1.0);
});

test('pickBoost: reachRate=0.6 → 1.3', () => {
  assert.equal(pickBoost(0.6, transitShare), 1.3);
});

test('pickBoost: reachRate=0 → 2.5', () => {
  assert.equal(pickBoost(0, transitShare), 2.5);
});

test('estimateTaxiPax: T2 18:30 reach=1.0 → 推定降客×0.24', () => {
  const r = estimateTaxiPax({
    estimatedPax: 200,
    terminal: 'T2',
    lobbyExitTime: '18:30',
    delayMinutes: 0
  }, transitShare, 1.0);
  assert.equal(r.estimatedTaxiPax, Math.round(200 * 0.24 * 1.0));
});

test('estimateTaxiPax: T3 23:00 reach=0 → 0.22 × 2.5、上限0.85クランプ', () => {
  const r = estimateTaxiPax({
    estimatedPax: 300,
    terminal: 'T3',
    lobbyExitTime: '23:00',
    delayMinutes: 0
  }, transitShare, 0.0);
  // 0.22 × 2.5 = 0.55、 maxRatio 0.85 内
  assert.equal(r.estimatedTaxiPax, Math.round(300 * 0.22 * 2.5));
  assert.equal(r.appliedBoost, 2.5);
  assert.equal(r.appliedDelayBoost, 1.0);
});

test('estimateTaxiPax: T1 24:30 遅延60分以上 → 遅延ブースト適用', () => {
  // 遅延ブースト条件: delay >= 60 AND lobbyExitTime >= 23:30
  // T1 midnight=0.05、reach=0→2.5、delay=1.15
  // 0.05 × 2.5 × 1.15 = 0.14375
  const r = estimateTaxiPax({
    estimatedPax: 150,
    terminal: 'T1',
    lobbyExitTime: '24:30',
    delayMinutes: 70
  }, transitShare, 0.0);
  assert.equal(r.appliedDelayBoost, 1.15);
  assert.equal(r.estimatedTaxiPax, Math.round(150 * 0.05 * 2.5 * 1.15));
});

test('estimateTaxiPax: 上限0.85クランプが効く（極端値）', () => {
  // baseRate を強制的に 0.5 にしたケース：0.5 × 2.5 × 1.15 = 1.4375 → 0.85 にクランプ
  const extreme = JSON.parse(JSON.stringify(transitShare));
  extreme.buckets[7].rates.T3 = 0.50; // midnight T3
  const r = estimateTaxiPax({
    estimatedPax: 100,
    terminal: 'T3',
    lobbyExitTime: '24:30',
    delayMinutes: 70
  }, extreme, 0.0);
  assert.equal(r.estimatedTaxiPax, Math.round(100 * 0.85));
  assert.equal(r.clamped, true);
});

test('estimateTaxiPax: estimatedPax=null → null', () => {
  const r = estimateTaxiPax({
    estimatedPax: null,
    terminal: 'T1',
    lobbyExitTime: '12:00',
    delayMinutes: 0
  }, transitShare, 1.0);
  assert.equal(r.estimatedTaxiPax, null);
});

test('estimateTaxiPax: バケット範囲外（早朝5時など）→ fallbackRate', () => {
  const r = estimateTaxiPax({
    estimatedPax: 100,
    terminal: 'T1',
    lobbyExitTime: '05:30',
    delayMinutes: 0
  }, transitShare, 1.0);
  // fallbackRate=0.10 × 1.0 = 0.10 → 10
  assert.equal(r.estimatedTaxiPax, 10);
  assert.equal(r.bucket, 'fallback');
});
```

- [ ] **Step 2: テスト失敗確認**

Run: `cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係" && node --test tests/taxi-estimator.test.mjs 2>&1 | tail -20`
Expected: FAIL（モジュール未存在）

- [ ] **Step 3: 実装**

`scripts/lib/taxi-estimator.mjs`:
```js
import { hhmmToMinutes } from './route-reachability.mjs';

/**
 * lobbyExitTime からバケットを決定。範囲外は null。
 */
export function pickBucket(lobbyExitTime, transitShare) {
  const m = hhmmToMinutes(lobbyExitTime);
  if (m === null) return null;
  for (const b of transitShare.buckets) {
    const from = hhmmToMinutes(b.fromHHMM);
    const to = hhmmToMinutes(b.toHHMM);
    if (m >= from && m < to) return b;
  }
  return null;
}

/**
 * reachRate から boost 値を決定（テーブル降順前提）。
 */
export function pickBoost(reachRate, transitShare) {
  const sorted = [...transitShare.reachBoost].sort((a, b) => b.minRate - a.minRate);
  for (const r of sorted) {
    if (reachRate >= r.minRate) return r.boost;
  }
  return sorted[sorted.length - 1].boost;
}

function shouldApplyDelayBoost(lobbyExitTime, delayMinutes, transitShare) {
  const cfg = transitShare.delayBoost;
  if (!cfg) return false;
  if ((delayMinutes ?? 0) < cfg.minDelayMinutes) return false;
  const exitMin = hhmmToMinutes(lobbyExitTime);
  const minMin = hhmmToMinutes(cfg.minLobbyExitTime);
  if (exitMin === null || minMin === null) return false;
  return exitMin >= minMin;
}

/**
 * @param {{estimatedPax: number|null, terminal: string, lobbyExitTime: string, delayMinutes: number}} flight
 * @param {Object} transitShare
 * @param {number} reachRate
 * @returns {{estimatedTaxiPax: number|null, baseRate, appliedBoost, appliedDelayBoost, clamped, bucket}}
 */
export function estimateTaxiPax(flight, transitShare, reachRate) {
  if (flight.estimatedPax === null || flight.estimatedPax === undefined) {
    return { estimatedTaxiPax: null, baseRate: null, appliedBoost: null, appliedDelayBoost: null, clamped: false, bucket: null };
  }
  const bucket = pickBucket(flight.lobbyExitTime, transitShare);
  let baseRate;
  let bucketId;
  if (bucket) {
    baseRate = bucket.rates[flight.terminal];
    bucketId = bucket.id;
  } else {
    baseRate = transitShare.fallbackRate;
    bucketId = 'fallback';
  }
  if (typeof baseRate !== 'number') {
    return { estimatedTaxiPax: null, baseRate: null, appliedBoost: null, appliedDelayBoost: null, clamped: false, bucket: bucketId };
  }
  const boost = pickBoost(reachRate, transitShare);
  const delayBoost = shouldApplyDelayBoost(flight.lobbyExitTime, flight.delayMinutes, transitShare)
    ? transitShare.delayBoost.boost
    : 1.0;
  let ratio = baseRate * boost * delayBoost;
  let clamped = false;
  if (ratio > transitShare.maxRatio) {
    ratio = transitShare.maxRatio;
    clamped = true;
  }
  return {
    estimatedTaxiPax: Math.round(flight.estimatedPax * ratio),
    baseRate,
    appliedBoost: boost,
    appliedDelayBoost: delayBoost,
    clamped,
    bucket: bucketId
  };
}
```

- [ ] **Step 4: テスト通過確認**

Run: `cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係" && node --test tests/taxi-estimator.test.mjs 2>&1 | tail -20`
Expected: 全テスト pass

- [ ] **Step 5: 全テスト走らせて非破壊確認**

Run: `cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係" && npm test 2>&1 | tail -10`
Expected: 既存の86件＋新規テストが pass

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/taxi-estimator.mjs tests/taxi-estimator.test.mjs
git commit -m "feat(taxi): estimateTaxiPax 純関数（バケット引き＋ブースト＋遅延補正＋上限クランプ）"
```

---

## Phase 3: 既存パイプラインへ統合

### Task 7: arrival-transformer.mjs に taxi 推定を統合

**Files:**
- Modify: `scripts/lib/arrival-transformer.mjs`
- Modify: `tests/arrival-transformer.test.mjs`

- [ ] **Step 1: 既存テストを失敗させない形でテスト追加**

`tests/arrival-transformer.test.mjs` 末尾に追記：
```js
import { readFileSync as rfs2 } from 'node:fs';

const transitShareReal = JSON.parse(rfs2('./data/transit-share.json', 'utf8'));
const routesReal = JSON.parse(rfs2('./data/last-mile-routes.json', 'utf8'));
const egressReal = JSON.parse(rfs2('./data/terminal-egress.json', 'utf8'));
const railOk = { Keikyu: { status: 'OnTime', delayMinutes: 0 }, TokyoMonorail: { status: 'OnTime', delayMinutes: 0 } };

test('taxi拡張: 各便に lobbyExitTime / reachRate / estimatedTaxiPax が出る', () => {
  const r = transformArrivals(sample, seatsMaster, factorsMaster, {
    transitShare: transitShareReal,
    routes: routesReal,
    egress: egressReal,
    railStatus: railOk,
    dayType: 'weekday'
  });
  for (const f of r.flights) {
    assert.ok('lobbyExitTime' in f);
    assert.ok('reachRate' in f);
    assert.ok('reachTier' in f);
    assert.ok('estimatedTaxiPax' in f);
  }
});

test('taxi拡張: 機材nullの便は estimatedTaxiPax も null', () => {
  const r = transformArrivals(sample, seatsMaster, factorsMaster, {
    transitShare: transitShareReal,
    routes: routesReal,
    egress: egressReal,
    railStatus: railOk,
    dayType: 'weekday'
  });
  const f = r.flights.find(x => x.flightNumber === 'NH012');
  assert.equal(f.estimatedPax, null);
  assert.equal(f.estimatedTaxiPax, null);
});

test('taxi拡張: stats.totalEstimatedTaxiPax が便ごとの合計', () => {
  const r = transformArrivals(sample, seatsMaster, factorsMaster, {
    transitShare: transitShareReal,
    routes: routesReal,
    egress: egressReal,
    railStatus: railOk,
    dayType: 'weekday'
  });
  const sum = r.flights.reduce((s, f) => s + (f.estimatedTaxiPax ?? 0), 0);
  assert.equal(r.stats.totalEstimatedTaxiPax, sum);
});

test('taxi拡張: 引数なしでも既存挙動を維持', () => {
  const r = transformArrivals(sample, seatsMaster, factorsMaster);
  assert.equal(r.flights.length, 5);
  // 拡張オプションなしの場合 lobbyExitTime 等は undefined or null で出ても良い
});
```

- [ ] **Step 2: テスト失敗確認**

Run: `cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係" && node --test tests/arrival-transformer.test.mjs 2>&1 | tail -30`
Expected: 新規4テストが FAIL（拡張未実装）、既存テストはPASS

- [ ] **Step 3: 実装**

`scripts/lib/arrival-transformer.mjs` の冒頭に import 追加：
```js
import { computeLobbyExitTime, computeReachRate, hhmmToMinutes } from './route-reachability.mjs';
import { estimateTaxiPax } from './taxi-estimator.mjs';
```

`transformArrivals` のシグネチャを拡張：
```js
export function transformArrivals(odptResponse, seatsMaster, factorsMaster, taxiOpts = null) {
  const flights = odptResponse.map(item => {
    // ... 既存ロジックそのまま ...
    const baseFlight = {
      flightNumber, airline, from, fromName, terminal, isInternational,
      scheduledTime, estimatedTime, actualTime, status, aircraftCode, ...pax
    };
    if (!taxiOpts) {
      return {
        ...baseFlight,
        lobbyExitTime: null, reachRate: null, reachTier: null,
        estimatedTaxiPax: null, taxiBucket: null
      };
    }
    const lobbyExitTime = computeLobbyExitTime(estimatedTime, terminal, baseFlight.isInternational, taxiOpts.egress);
    const { reachRate } = computeReachRate(lobbyExitTime, taxiOpts.routes, taxiOpts.dayType ?? 'weekday', taxiOpts.railStatus);
    const reachTier = reachRate >= 0.9 ? 'high' : reachRate >= 0.5 ? 'mid' : reachRate >= 0.1 ? 'low' : 'none';
    const delayMinutes = (estimatedTime && scheduledTime)
      ? Math.max(0, (hhmmToMinutes(estimatedTime) ?? 0) - (hhmmToMinutes(scheduledTime) ?? 0))
      : 0;
    const tx = estimateTaxiPax({
      estimatedPax: baseFlight.estimatedPax,
      terminal, lobbyExitTime, delayMinutes
    }, taxiOpts.transitShare, reachRate);
    return {
      ...baseFlight,
      lobbyExitTime,
      reachRate: Number(reachRate.toFixed(3)),
      reachTier,
      estimatedTaxiPax: tx.estimatedTaxiPax,
      taxiBucket: tx.bucket,
      taxiBaseRate: tx.baseRate,
      taxiBoost: tx.appliedBoost,
      taxiDelayBoost: tx.appliedDelayBoost,
      taxiClamped: tx.clamped
    };
  });
  // ... 既存 byTerminal そのまま ...
  return {
    updatedAt: nowJstIso(),
    source: 'ODPT (api.odpt.org)',
    flights,
    stats: {
      totalFlights: flights.length,
      unknownAircraft: flights.filter(f => f.aircraftCode === null).length,
      internationalFlights: flights.filter(f => f.isInternational === true).length,
      byTerminal,
      totalEstimatedTaxiPax: flights.reduce((s, f) => s + (f.estimatedTaxiPax ?? 0), 0)
    }
  };
}
```

注: `extractAirline` 等の既存ヘルパは触らない。`baseFlight` 構築まで既存のロジックを保持し、`taxiOpts` がある場合のみ拡張フィールドを追加する形にする。

- [ ] **Step 4: テスト通過確認**

Run: `cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係" && node --test tests/arrival-transformer.test.mjs 2>&1 | tail -20`
Expected: 既存テスト＋新規4テスト全部 pass

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/arrival-transformer.mjs tests/arrival-transformer.test.mjs
git commit -m "feat(transformer): taxi拡張オプションで便ごとに reachRate / estimatedTaxiPax を出力"
```

---

### Task 8: fetch-arrivals.mjs にマスタ読み込みを追加

**Files:**
- Modify: `scripts/fetch-arrivals.mjs`

- [ ] **Step 1: 実装**

`scripts/fetch-arrivals.mjs` の seatsMaster/factorsMaster 読込直後に以下を追加：

```js
const transitShareMaster = JSON.parse(readFileSync('./data/transit-share.json', 'utf8'));
const routesMaster = JSON.parse(readFileSync('./data/last-mile-routes.json', 'utf8'));
const egressMaster = JSON.parse(readFileSync('./data/terminal-egress.json', 'utf8'));

// rail-status は存在すれば読む（C案部分。最初は無くても良い）
let railStatus = null;
try {
  railStatus = JSON.parse(readFileSync('./data/rail-status.json', 'utf8')).operators;
} catch {
  railStatus = { Keikyu: { status: 'OnTime', delayMinutes: 0 }, TokyoMonorail: { status: 'OnTime', delayMinutes: 0 } };
}

// 当日の dayType 判定（JST）
const jstDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
const dayOfWeek = jstDate.getDay(); // 0=Sun, 6=Sat
const dayType = (dayOfWeek === 0 || dayOfWeek === 6) ? 'holiday' : 'weekday';
```

`transformArrivals` 呼び出しを以下に変更：
```js
const out = transformArrivals(odptData, seatsMaster, factorsMaster, {
  transitShare: transitShareMaster,
  routes: routesMaster,
  egress: egressMaster,
  railStatus,
  dayType
});
```

- [ ] **Step 2: ローカルでスクリプト動作確認（モックでもOK）**

Run（トークンなしの早期exit動作確認）:
```bash
cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係" && node scripts/fetch-arrivals.mjs 2>&1 | head -5
```
Expected: `ERROR: ODPT_TOKEN env var is required`（既存挙動）

- [ ] **Step 3: 既存テストの非破壊確認**

Run: `cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係" && npm test 2>&1 | tail -10`
Expected: 全テスト pass（既存86件＋新規が壊れてない）

- [ ] **Step 4: Commit**

```bash
git add scripts/fetch-arrivals.mjs
git commit -m "feat(fetch): マスタ3種＋rail-status＋dayType を transformArrivals に渡す"
```

---

## Phase 4: UI拡張

### Task 9: arrivals-data.js のヒートマップ集計を taxi 候補対応に拡張

**Files:**
- Modify: `js/arrivals-data.js`

- [ ] **Step 1: 既存 aggregateHeatmapClient を taxi候補も集計するように拡張**

`js/arrivals-data.js` の `aggregateHeatmapClient` 内、bin初期化部分に `totalTaxiPax: 0` を追加し、ループ内で `b.totalTaxiPax += f.estimatedTaxiPax ?? 0` を追加。

具体的には：
```js
if (!bins.has(key)) {
  bins.set(key, {
    bin: key, totalPax: 0, internationalPax: 0,
    totalTaxiPax: 0,                    // 追加
    flightCount: 0, unknownCount: 0, delayedCount: 0, internationalCount: 0,
    reachNoneCount: 0                   // 追加: reach=none の便数
  });
}
const b = bins.get(key);
b.flightCount += 1;
if (f.estimatedPax === null) b.unknownCount += 1;
else {
  b.totalPax += f.estimatedPax;
  if (f.isInternational) b.internationalPax += f.estimatedPax;
}
b.totalTaxiPax += f.estimatedTaxiPax ?? 0;        // 追加
if (f.reachTier === 'none') b.reachNoneCount += 1; // 追加
```

`classifyDensity` の引数を `(totalPax, mode)` に変更し、mode が `'taxi'` の場合は閾値を `70` `30` に切替：
```js
const TAXI_DENSITY_HIGH = 70;
const TAXI_DENSITY_MID = 30;

function classifyDensity(value, mode = 'pax') {
  const high = mode === 'taxi' ? TAXI_DENSITY_HIGH : DENSITY_HIGH;
  const mid = mode === 'taxi' ? TAXI_DENSITY_MID : DENSITY_MID;
  if (value >= high) return 'high';
  if (value >= mid) return 'mid';
  return 'low';
}
```

戻り値の densityTier 計算をモード対応：
```js
return arr.map(b => ({
  ...b,
  densityTier: classifyDensity(b.totalPax),
  taxiDensityTier: classifyDensity(b.totalTaxiPax, 'taxi')
}));
```

- [ ] **Step 2: 動作確認（既存JS構成のためブラウザでの目視確認、またはNodeで簡易確認）**

```bash
cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係" && node -e "
import('./js/arrivals-data.js').then(m => {
  const flights = [
    { estimatedTime: '18:30', estimatedPax: 200, estimatedTaxiPax: 48, isInternational: false, status: '定刻', reachTier: 'high' },
    { estimatedTime: '18:45', estimatedPax: 100, estimatedTaxiPax: 24, isInternational: false, status: '定刻', reachTier: 'high' }
  ];
  const bins = m.aggregateHeatmapClient(flights);
  console.log(JSON.stringify(bins, null, 2));
});
"
```
Expected: 1つのbin（18:30）に totalTaxiPax=72 / taxiDensityTier='mid' が出る

- [ ] **Step 3: Commit**

```bash
git add js/arrivals-data.js
git commit -m "feat(data): ヒートマップ集計に taxi 候補数 / reach不可便数を追加"
```

---

### Task 10: arrivals-data.js のサマリ＆トピックを taxi 対応に拡張

**Files:**
- Modify: `js/arrivals-data.js`

- [ ] **Step 1: summarizeFlights に taxi 集計追加**

`summarizeFlights` の戻り値に追加：
```js
const totalTaxiPax = flights.reduce((s, f) => s + (f.estimatedTaxiPax ?? 0), 0);
const reachNoneCount = flights.filter(f => f.reachTier === 'none').length;
const peakTaxiBin = (() => {
  // 30分単位で最も taxi 数が多いbinを返す
  const bins = new Map();
  for (const f of flights) {
    const t = f.estimatedTime ?? f.scheduledTime;
    if (!t) continue;
    const [h, mm] = t.split(':').map(Number);
    const binMin = mm < 30 ? '00' : '30';
    const key = `${String(h).padStart(2,'0')}:${binMin}`;
    bins.set(key, (bins.get(key) ?? 0) + (f.estimatedTaxiPax ?? 0));
  }
  let bestKey = null, best = 0;
  for (const [k, v] of bins) if (v > best) { bestKey = k; best = v; }
  return { bin: bestKey, value: best };
})();
return {
  totalPax, internationalPax,
  totalFlights, internationalCount,
  delayedCount, unknownCount, hourlyAvg,
  windowLabel,
  totalTaxiPax,        // 追加
  reachNoneCount,      // 追加
  peakTaxiBin          // 追加
};
```

- [ ] **Step 2: detectTopics を taxi 急増ベースに置換**

既存 `detectTopics` を以下に書き換え（旧仕様の MAJOR_DELAY/LATE_NIGHT は廃止）：
```js
export function detectTopics(flights) {
  const topics = [];
  for (const f of flights) {
    if (f.status === '到着') continue;
    const reachNone = f.reachTier === 'none';
    const delayBoost = f.taxiDelayBoost && f.taxiDelayBoost > 1.0;
    if (!reachNone && !delayBoost) continue;
    const sched = timeToMinutes(f.scheduledTime);
    const est = timeToMinutes(f.estimatedTime ?? f.scheduledTime);
    const delayMin = (sched !== null && est !== null) ? Math.max(0, est - sched) : 0;
    topics.push({
      flightNumber: f.flightNumber,
      fromName: f.fromName,
      terminal: f.terminal,
      scheduledTime: f.scheduledTime,
      estimatedTime: f.estimatedTime ?? f.scheduledTime,
      delayMin,
      reachNone,
      delayBoost: !!delayBoost,
      estimatedTaxiPax: f.estimatedTaxiPax ?? 0
    });
  }
  topics.sort((a, b) => timeToMinutes(a.estimatedTime) - timeToMinutes(b.estimatedTime));
  return topics;
}
```

- [ ] **Step 3: 動作確認**

```bash
cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係" && node -e "
import('./js/arrivals-data.js').then(m => {
  const flights = [
    { flightNumber: 'NH001', estimatedTime: '24:30', scheduledTime: '23:00', status: '遅延', estimatedPax: 100, estimatedTaxiPax: 30, isInternational: false, reachTier: 'none', taxiDelayBoost: 1.15, terminal: 'T2', fromName: '福岡' }
  ];
  console.log('topics:', m.detectTopics(flights));
  console.log('summary:', m.summarizeFlights(flights));
});
"
```
Expected: topics 1件（reachNone=true, delayBoost=true）、summary に totalTaxiPax=30, reachNoneCount=1, peakTaxiBin

- [ ] **Step 4: Commit**

```bash
git add js/arrivals-data.js
git commit -m "feat(data): サマリにtaxi合計＋ピーク帯／トピックを reach不可・遅延ブースト発動便に置換"
```

---

### Task 11: arrivals-render.js: 便リスト拡張

**Files:**
- Modify: `js/arrivals-render.js`

- [ ] **Step 1: renderFlightList に taxi 候補数と reach アイコンを追加**

`renderFlightList` の `row.innerHTML = ...` の `flight-line2` 部分を以下に置換：
```js
const reachIcon = f.reachTier === 'high' ? '🟢'
                : f.reachTier === 'mid'  ? '🟡'
                : f.reachTier === 'low'  ? '🟡'
                : f.reachTier === 'none' ? '🔴'
                : '';
const taxiPax = f.estimatedTaxiPax !== null && f.estimatedTaxiPax !== undefined
  ? `タクシー候補~${f.estimatedTaxiPax}`
  : '';
const delayBoostBadge = (f.taxiDelayBoost && f.taxiDelayBoost > 1.0)
  ? ` <span class="delay-boost">遅延+深夜</span>`
  : '';
row.innerHTML = `
  <div class="flight-line1">
    <span class="time">${time}</span>
    <span class="flight-no">${f.flightNumber}</span>
    <span class="from">${f.fromName}</span>
    <span class="aircraft">${aircraft}</span>
    <span class="reach">${reachIcon}</span>
  </div>
  <div class="flight-line2">
    <span class="pax">${pax}</span>
    <span class="taxi-pax">${taxiPax}</span>
    <span class="status">${f.status}${statusIcon}${delayBoostBadge}</span>
  </div>
`;
```

CSSに以下を追加（`arrivals.html` の `<style>` 内）：
```css
.flight-line1 .reach { font-size: 13px; }
.flight-line2 .taxi-pax { color: #ffd66e; font-weight: 600; }
.delay-boost { color: var(--peak); font-size: 11px; padding: 1px 4px; border-radius: 3px; background: rgba(255,82,82,0.15); }
```

- [ ] **Step 2: ローカルブラウザで目視確認**

```bash
cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係" && npm run serve
```
別ターミナルで `open http://localhost:8000/arrivals.html`
Expected: 便リストに🟢/🟡/🔴アイコンと「タクシー候補~XX」が出る

注: ローカルの `data/arrivals.json` が拡張前の旧フォーマットの場合、estimatedTaxiPax が undefined のため空表示になる。**このタスク前に Task 7-8 を完了させ、ローカルで一度 fetch-arrivals.mjs を走らせて新しい arrivals.json を生成しておく**こと（または手動でモックデータに taxi フィールドを追加）。

- [ ] **Step 3: Commit**

```bash
git add js/arrivals-render.js arrivals.html
git commit -m "feat(ui): 便リストに reach アイコンとタクシー候補数を表示"
```

---

### Task 12: arrivals-render.js: サマリ・トピック拡張

**Files:**
- Modify: `js/arrivals-render.js`

- [ ] **Step 1: renderSummary を taxi 対応に拡張**

`renderSummary` の `container.innerHTML = ...` の末尾に追加：
```js
const taxiPart = summary.totalTaxiPax > 0
  ? `<span class="summary-item summary-taxi">タクシー候補 <strong>${summary.totalTaxiPax.toLocaleString()}人</strong></span>`
  : '';
const peakPart = summary.peakTaxiBin?.bin
  ? `<span class="summary-item summary-peak">ピーク帯 ${summary.peakTaxiBin.bin}</span>`
  : '';
const reachNonePart = summary.reachNoneCount > 0
  ? `<span class="summary-item summary-reach-none">🔴 ${summary.reachNoneCount}便（公共交通不可）</span>`
  : '';
container.innerHTML = `
  <span class="summary-item">${summary.windowLabel} <strong>${summary.totalPax.toLocaleString()}人</strong></span>
  <span class="summary-item">時間あたり <strong>${summary.hourlyAvg.toLocaleString()}人</strong></span>
  <span class="summary-item">${summary.totalFlights}便</span>
  ${taxiPart}
  ${peakPart}
  ${reachNonePart}
  ${intlPart}
  ${delayPart}
`;
```

- [ ] **Step 2: renderTopics を新スキーマに対応**

`renderTopics` を以下に置換：
```js
export function renderTopics(container, topics) {
  if (!container) return;
  if (topics.length === 0) {
    container.innerHTML = '';
    container.hidden = true;
    return;
  }
  container.hidden = false;
  const items = topics.map(t => {
    const icons = [
      t.reachNone ? '🔴' : '',
      t.delayBoost ? '🌙⚠' : ''
    ].filter(Boolean).join('');
    const detail = t.delayMin > 0
      ? `${t.delayMin}分遅延 / タクシー候補~${t.estimatedTaxiPax}`
      : `${t.estimatedTime}着 / タクシー候補~${t.estimatedTaxiPax}`;
    return `<div class="topic-item">
      <span class="topic-icons">${icons}</span>
      <span class="topic-flight">${t.flightNumber}</span>
      <span class="topic-from">${t.fromName}</span>
      <span class="topic-detail">${detail}</span>
      <span class="topic-terminal">${t.terminal}</span>
    </div>`;
  }).join('');
  container.innerHTML = `
    <div class="topic-header">🚨 タクシー需要急増 (${topics.length}件) — 公共交通不可 / 遅延深夜</div>
    ${items}
  `;
}
```

CSS追加（arrivals.html）:
```css
.summary-taxi strong { color: #ffd66e !important; }
.summary-peak { color: var(--accent); font-size: 12px; }
.summary-reach-none { color: var(--peak); font-size: 12px; font-weight: 600; }
```

- [ ] **Step 3: ブラウザで目視確認**

`npm run serve` の状態で `http://localhost:8000/arrivals.html` を再読込。
Expected: サマリに「タクシー候補 X人 / ピーク帯 HH:MM」表示。トピックがあれば置換された見出しで表示。

- [ ] **Step 4: Commit**

```bash
git add js/arrivals-render.js arrivals.html
git commit -m "feat(ui): サマリにタクシー候補合計＋ピーク帯／トピックを reach不可ベースに更新"
```

---

### Task 13: ヒートマップに「降客 / タクシー候補」切替トグル

**Files:**
- Modify: `js/arrivals-render.js`
- Modify: `js/arrivals-app.js`
- Modify: `arrivals.html`

- [ ] **Step 1: arrivals.html にトグルボタン追加**

`<section><h2>時間帯別 推定降客（30分単位）</h2>` の前に：
```html
<div class="heatmap-mode-toggle" style="padding: 4px 12px;">
  <button id="heatmap-mode-pax" class="terminal-tab is-active" data-mode="pax">降客数</button>
  <button id="heatmap-mode-taxi" class="terminal-tab" data-mode="taxi">タクシー候補</button>
</div>
```

`<h2>` のテキストは動的化：
```html
<h2 id="heatmap-title">時間帯別 推定降客（30分単位）</h2>
```

- [ ] **Step 2: renderHeatmap をモード切替対応に拡張**

`renderHeatmap` のシグネチャを `renderHeatmap(container, bins, mode = 'pax')` に変更し、mode に応じて表示値を切替：
```js
export function renderHeatmap(container, bins, mode = 'pax') {
  container.innerHTML = '';
  if (bins.length === 0) {
    container.innerHTML = '<div class="empty">表示可能な時間帯がありません</div>';
    return;
  }
  const isTaxi = mode === 'taxi';
  const valueOf = b => isTaxi ? (b.totalTaxiPax ?? 0) : b.totalPax;
  const tierOf = b => isTaxi ? b.taxiDensityTier : b.densityTier;
  const maxVal = Math.max(1, ...bins.map(valueOf));
  for (const b of bins) {
    const row = document.createElement('div');
    row.className = `heatmap-row tier-${tierOf(b)}`;
    const totalWidthPct = (valueOf(b) / maxVal) * 100;
    const intlWidthPct = (!isTaxi && b.totalPax > 0) ? (b.internationalPax / b.totalPax) * 100 : 0;
    const unknownNote = b.unknownCount > 0 ? ` <span class="unknown-note">機材不明${b.unknownCount}</span>` : '';
    const delayBadge = b.delayedCount > 0 ? ` <span class="delay-badge">⚠${b.delayedCount}遅延</span>` : '';
    const intlBadge = (!isTaxi && b.internationalPax > 0)
      ? ` <span class="intl-badge">国際${b.internationalPax}人</span>`
      : '';
    const reachNoneBadge = (isTaxi && b.reachNoneCount > 0)
      ? ` <span class="delay-badge">🔴${b.reachNoneCount}</span>`
      : '';
    const tier = TIER_INFO[tierOf(b)];
    const tierBadge = valueOf(b) > 0
      ? ` <span class="tier-badge">${tier.emoji}${tier.label}</span>`
      : '';
    const valueLabel = isTaxi ? `タクシー候補${valueOf(b)}人` : `${valueOf(b)}人 (${b.flightCount}便)`;
    row.innerHTML = `
      <span class="heatmap-time">${b.bin}</span>
      <span class="heatmap-bar-wrap">
        <span class="heatmap-bar" style="width:${totalWidthPct}%">
          <span class="heatmap-bar-intl" style="width:${intlWidthPct}%"></span>
        </span>
      </span>
      <span class="heatmap-label">${valueLabel}${unknownNote}${delayBadge}${intlBadge}${reachNoneBadge}${tierBadge}</span>
    `;
    container.appendChild(row);
  }
}
```

- [ ] **Step 3: arrivals-app.js にモード状態とトグル制御を追加**

```js
// state に追加
const state = { arrivals: null, tab: 'T1T2', detailMode: false, heatmapMode: 'pax' };

// render() 内の renderHeatmap 呼び出しを以下に変更
renderHeatmap(document.getElementById('heatmap'), bins, state.heatmapMode);
const title = document.getElementById('heatmap-title');
if (title) title.textContent = state.heatmapMode === 'taxi'
  ? '時間帯別 タクシー候補数（30分単位）'
  : '時間帯別 推定降客数（30分単位）';

// setupHeatmapModeToggle 追加
function setupHeatmapModeToggle() {
  document.querySelectorAll('.heatmap-mode-toggle button').forEach(btn => {
    btn.addEventListener('click', () => {
      state.heatmapMode = btn.dataset.mode;
      document.querySelectorAll('.heatmap-mode-toggle button').forEach(b => {
        b.classList.toggle('is-active', b.dataset.mode === state.heatmapMode);
      });
      if (state.arrivals) render();
    });
  });
}
// 既存の setupReload(); の後に追加
setupHeatmapModeToggle();
```

- [ ] **Step 4: ブラウザで目視確認**

`http://localhost:8000/arrivals.html` を再読込し、「降客数 / タクシー候補」トグルを切替えて表示が変わることを確認。

- [ ] **Step 5: Commit**

```bash
git add js/arrivals-render.js js/arrivals-app.js arrivals.html
git commit -m "feat(ui): ヒートマップに降客/タクシー候補の切替トグル追加"
```

---

## Phase 5: ODPT 運行情報（C案）

### Task 14: ODPT TrainInformation API スパイク（手動）

**Files:**
- Create: `docs/superpowers/specs/odpt-traininformation-spike-notes.md`

このタスクはコード書かず、API実機確認のみ。

- [ ] **Step 1: 京急 TrainInformation を curl で取得**

```bash
# ODPT_TOKEN は GitHub Secrets と同じものをローカル env で設定
# ※ 既存の `.env` 等への記録はしない。シェルでの一回限りの利用に留める
cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係"
curl -sS "https://api.odpt.org/api/v4/odpt:TrainInformation?odpt:operator=odpt.Operator:Keikyu&acl:consumerKey=${ODPT_TOKEN}" | head -c 2000
```
Expected: JSON-LD配列（複数の TrainInformation アイテム）または空配列

- [ ] **Step 2: 東京モノレール TrainInformation も取得**

```bash
curl -sS "https://api.odpt.org/api/v4/odpt:TrainInformation?odpt:operator=odpt.Operator:TokyoMonorail&acl:consumerKey=${ODPT_TOKEN}" | head -c 2000
```

- [ ] **Step 3: 結果を docs にメモ**

`docs/superpowers/specs/odpt-traininformation-spike-notes.md` に：
- 取得できたフィールド一覧
- ステータス文字列のバリエーション（`odpt:trainInformationText` など）
- 平常時のレスポンス例
- 見つからなかったフィールドや想定外の挙動

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/odpt-traininformation-spike-notes.md
git commit -m "docs(spike): ODPT TrainInformation API 京急/モノレール 実機確認メモ"
```

---

### Task 15: odpt-rail-status.mjs を TDD で実装

**Files:**
- Create: `scripts/lib/odpt-rail-status.mjs`
- Create: `tests/odpt-rail-status.test.mjs`
- Create: `tests/fixtures/odpt-traininfo-keikyu-ontime.json`
- Create: `tests/fixtures/odpt-traininfo-keikyu-suspended.json`

- [ ] **Step 1: Spike結果に基づき fixtures を作成**

Task 14のスパイクで取得した実レスポンスから、平常時と異常時（過去ログから取れなければ仮想データ）の fixture を作成：

`tests/fixtures/odpt-traininfo-keikyu-ontime.json`（最低限のフィールド）:
```json
[
  {
    "@type": "odpt:TrainInformation",
    "odpt:operator": "odpt.Operator:Keikyu",
    "odpt:railway": "odpt.Railway:Keikyu.Airport",
    "odpt:trainInformationText": { "ja": "平常通り運転しています。" },
    "odpt:trainInformationStatus": { "ja": "平常運転" }
  }
]
```

`tests/fixtures/odpt-traininfo-keikyu-suspended.json`:
```json
[
  {
    "@type": "odpt:TrainInformation",
    "odpt:operator": "odpt.Operator:Keikyu",
    "odpt:railway": "odpt.Railway:Keikyu.Airport",
    "odpt:trainInformationText": { "ja": "運転を見合わせています。" },
    "odpt:trainInformationStatus": { "ja": "運転見合わせ" }
  }
]
```

注: 実フィールド名がスパイクで違っていた場合は spike-notes.md に従って修正。

- [ ] **Step 2: 失敗テストを書く**

`tests/odpt-rail-status.test.mjs`:
```js
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { parseTrainInformation } from '../scripts/lib/odpt-rail-status.mjs';

test('平常運転 → status: OnTime', () => {
  const input = JSON.parse(readFileSync('./tests/fixtures/odpt-traininfo-keikyu-ontime.json', 'utf8'));
  const r = parseTrainInformation(input);
  assert.equal(r.status, 'OnTime');
  assert.equal(r.delayMinutes, 0);
});

test('運転見合わせ → status: Suspended', () => {
  const input = JSON.parse(readFileSync('./tests/fixtures/odpt-traininfo-keikyu-suspended.json', 'utf8'));
  const r = parseTrainInformation(input);
  assert.equal(r.status, 'Suspended');
});

test('空配列 → status: OnTime（情報なし=平常扱い）', () => {
  const r = parseTrainInformation([]);
  assert.equal(r.status, 'OnTime');
});
```

- [ ] **Step 3: テスト失敗確認**

Run: `cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係" && node --test tests/odpt-rail-status.test.mjs 2>&1 | tail -10`
Expected: FAIL（モジュール未存在）

- [ ] **Step 4: 実装**

`scripts/lib/odpt-rail-status.mjs`:
```js
const ENDPOINT = 'https://api.odpt.org/api/v4/odpt:TrainInformation';

const SUSPENDED_KEYWORDS = ['運転見合わせ', '運休', '運転を見合わせ'];
const DELAY_KEYWORDS = ['遅延', '遅れ'];

function extractText(item) {
  const status = item['odpt:trainInformationStatus'];
  const text = item['odpt:trainInformationText'];
  const pickJa = obj => (obj && (obj.ja ?? Object.values(obj)[0])) ?? '';
  return `${pickJa(status)} ${pickJa(text)}`.trim();
}

export function parseTrainInformation(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { status: 'OnTime', delayMinutes: 0, raw: '' };
  }
  // 最も「悪い」ステータスを採用
  let worst = { status: 'OnTime', delayMinutes: 0, raw: '' };
  for (const it of items) {
    const txt = extractText(it);
    if (SUSPENDED_KEYWORDS.some(k => txt.includes(k))) {
      return { status: 'Suspended', delayMinutes: 0, raw: txt };
    }
    if (DELAY_KEYWORDS.some(k => txt.includes(k))) {
      // 数字を抽出（例「30分以上の遅れ」→ 30）
      const m = txt.match(/(\d{1,3})\s*分/);
      const delayMin = m ? parseInt(m[1], 10) : 30;
      if (delayMin > worst.delayMinutes) worst = { status: 'Delayed', delayMinutes: delayMin, raw: txt };
    }
  }
  return worst;
}

export async function fetchRailStatus(operator, token) {
  const url = `${ENDPOINT}?odpt:operator=odpt.Operator:${operator}&acl:consumerKey=${encodeURIComponent(token)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const items = await res.json();
  return parseTrainInformation(items);
}
```

- [ ] **Step 5: テスト通過確認**

Run: `cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係" && node --test tests/odpt-rail-status.test.mjs 2>&1 | tail -10`
Expected: 3 tests pass

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/odpt-rail-status.mjs tests/odpt-rail-status.test.mjs tests/fixtures/odpt-traininfo-keikyu-ontime.json tests/fixtures/odpt-traininfo-keikyu-suspended.json
git commit -m "feat(rail): ODPT TrainInformation パーサ純関数（TDD）"
```

---

### Task 16: fetch-rail-status.mjs スクリプト作成

**Files:**
- Create: `scripts/fetch-rail-status.mjs`

- [ ] **Step 1: 実装**

`scripts/fetch-rail-status.mjs`:
```js
#!/usr/bin/env node
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { fetchRailStatus } from './lib/odpt-rail-status.mjs';

const TOKEN = process.env.ODPT_TOKEN;
if (!TOKEN) {
  console.error('ERROR: ODPT_TOKEN env var is required');
  process.exit(1);
}

function nowJstIso() {
  const d = new Date();
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  return jst.toISOString().replace('Z', '+09:00').replace(/\.\d+/, '');
}

async function safe(operator) {
  try {
    return await fetchRailStatus(operator, TOKEN);
  } catch (e) {
    console.error(`[rail-status] ${operator}: ${e.message}`);
    return { status: 'OnTime', delayMinutes: 0, raw: `error: ${e.message}` };
  }
}

const [keikyu, monorail] = await Promise.all([
  safe('Keikyu'),
  safe('TokyoMonorail')
]);

const out = {
  updatedAt: nowJstIso(),
  source: 'ODPT TrainInformation',
  operators: { Keikyu: keikyu, TokyoMonorail: monorail }
};

const outPath = './data/rail-status.json';
const newJson = JSON.stringify(out, null, 2);
const stripUpdatedAt = s => s.replace(/"updatedAt":\s*"[^"]+",?/, '');
if (existsSync(outPath) && stripUpdatedAt(readFileSync(outPath, 'utf8')) === stripUpdatedAt(newJson)) {
  console.log('No content change. Skipping write.');
  process.exit(0);
}
writeFileSync(outPath, newJson, 'utf8');
console.log(`Wrote rail-status: Keikyu=${keikyu.status}, TokyoMonorail=${monorail.status}`);
```

- [ ] **Step 2: 動作確認（トークンなし）**

Run: `cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係" && node scripts/fetch-rail-status.mjs 2>&1 | head -3`
Expected: `ERROR: ODPT_TOKEN env var is required`

- [ ] **Step 3: 初期 rail-status.json を作成（手動でひな型）**

`data/rail-status.json`:
```json
{
  "updatedAt": "2026-04-25T00:00:00+09:00",
  "source": "ODPT TrainInformation (initial placeholder)",
  "operators": {
    "Keikyu": { "status": "OnTime", "delayMinutes": 0, "raw": "" },
    "TokyoMonorail": { "status": "OnTime", "delayMinutes": 0, "raw": "" }
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add scripts/fetch-rail-status.mjs data/rail-status.json
git commit -m "feat(rail): fetch-rail-status.mjs と初期 rail-status.json"
```

---

### Task 17: GitHub Actions: update-rail-status.yml

**Files:**
- Create: `.github/workflows/update-rail-status.yml`

- [ ] **Step 1: workflow ファイル作成**

`.github/workflows/update-rail-status.yml`:
```yaml
name: Update Rail Status

on:
  schedule:
    - cron: '2,7,12,17,22,27,32,37,42,47,52,57 * * * *'  # arrivals(*/5) より2分ずらす
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

      - name: Skip if token not configured
        id: token-check
        env:
          ODPT_TOKEN: ${{ secrets.ODPT_TOKEN }}
        run: |
          if [ -z "$ODPT_TOKEN" ]; then
            echo "ODPT_TOKEN secret not set. Skipping."
            echo "skip=true" >> $GITHUB_OUTPUT
          else
            echo "skip=false" >> $GITHUB_OUTPUT
          fi

      - name: Fetch rail status
        if: steps.token-check.outputs.skip == 'false'
        env:
          ODPT_TOKEN: ${{ secrets.ODPT_TOKEN }}
        run: node scripts/fetch-rail-status.mjs

      - name: Commit if changed
        run: |
          if [ -n "$(git status --porcelain data/rail-status.json)" ]; then
            git config user.name "github-actions[bot]"
            git config user.email "github-actions[bot]@users.noreply.github.com"
            git add data/rail-status.json
            git commit -m "chore(rail-status): auto-update $(TZ=Asia/Tokyo date '+%Y-%m-%d %H:%M JST')"
            git push
          else
            echo "No change. Skipping commit."
          fi
```

- [ ] **Step 2: workflow YAML 構文チェック**

Run（actionlint があれば。なければ目視）:
```bash
which actionlint && actionlint .github/workflows/update-rail-status.yml || echo "actionlint not installed; skipping"
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/update-rail-status.yml
git commit -m "ci: update-rail-status workflow（5分ごと、arrivalsから2分オフセット）"
```

---

### Task 18: 運行情報バッジ UI

**Files:**
- Modify: `js/arrivals-data.js`
- Modify: `js/arrivals-render.js`
- Modify: `js/arrivals-app.js`
- Modify: `arrivals.html`

- [ ] **Step 1: arrivals-data.js に rail-status.json ローダ追加**

```js
export async function loadRailStatus() {
  try {
    const res = await fetch('./data/rail-status.json', { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    return data.operators ?? null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: arrivals-render.js に renderRailStatusBadges 追加**

```js
export function renderRailStatusBadges(container, operators) {
  if (!container) return;
  if (!operators) {
    container.innerHTML = '';
    container.hidden = true;
    return;
  }
  container.hidden = false;
  const labelOf = op => {
    if (!op) return '不明';
    if (op.status === 'Suspended') return '運転見合わせ';
    if (op.status === 'Delayed') return `${op.delayMinutes}分遅延`;
    return '通常運転';
  };
  const cssOf = op => {
    if (!op) return 'rail-unknown';
    if (op.status === 'Suspended') return 'rail-bad';
    if (op.status === 'Delayed' && op.delayMinutes >= 30) return 'rail-warn';
    return 'rail-ok';
  };
  container.innerHTML = `
    <span class="rail-badge ${cssOf(operators.Keikyu)}">京急: ${labelOf(operators.Keikyu)}</span>
    <span class="rail-badge ${cssOf(operators.TokyoMonorail)}">モノレール: ${labelOf(operators.TokyoMonorail)}</span>
  `;
}
```

- [ ] **Step 3: arrivals.html に DOM とCSS追加**

`<div id="topics" hidden></div>` の前に：
```html
<div id="rail-status" class="rail-status-bar"></div>
```

CSS:
```css
.rail-status-bar { display: flex; gap: 8px; padding: 6px 12px; background: #14141a; border-bottom: 1px solid #222; font-size: 12px; }
.rail-badge { padding: 3px 8px; border-radius: 4px; }
.rail-ok { background: rgba(110, 201, 110, 0.15); color: #6ec96e; }
.rail-warn { background: rgba(255, 184, 77, 0.15); color: var(--warn); }
.rail-bad { background: rgba(255, 82, 82, 0.2); color: var(--peak); font-weight: 600; }
.rail-unknown { background: rgba(255,255,255,0.05); color: var(--sub); }
```

- [ ] **Step 4: arrivals-app.js で読込＆描画**

```js
import { loadArrivals, loadRailStatus, ... } from './arrivals-data.js';
import { ..., renderRailStatusBadges } from './arrivals-render.js';

const state = { arrivals: null, railStatus: null, tab: 'T1T2', detailMode: false, heatmapMode: 'pax' };

async function refresh() {
  try {
    const [arrivals, railStatus] = await Promise.all([loadArrivals(), loadRailStatus()]);
    state.arrivals = arrivals;
    state.railStatus = railStatus;
    render();
  } catch (e) { /* ... */ }
}

// render() 内で：
renderRailStatusBadges(document.getElementById('rail-status'), state.railStatus);
```

- [ ] **Step 5: ブラウザで目視確認**

`http://localhost:8000/arrivals.html` を再読込。
Expected: 上部に「京急: 通常運転 / モノレール: 通常運転」バッジが出る。

- [ ] **Step 6: Commit**

```bash
git add js/arrivals-data.js js/arrivals-render.js js/arrivals-app.js arrivals.html
git commit -m "feat(ui): 京急/モノレール 運行情報バッジを画面上部に表示"
```

---

### Task 19: 全体動作確認 & READMEの v0.5 追記

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 全テスト実行**

Run: `cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係" && npm test 2>&1 | tail -15`
Expected: 全テストpass、件数が大幅増（既存86件＋新規30件以上）

- [ ] **Step 2: README に v0.5 セクション追記**

`README.md` 末尾の `## 版数` セクションに追加：
```markdown
- **v0.5**: タクシー候補数推定（経験則ベース時間帯×ターミナル分担率＋終電到達率＋遅延ブースト＋ODPT京急/モノレール運行情報リアルタイム連携）
```

`## 到着便ビューワー (v0.4)` を `## 到着便ビューワー (v0.5)` に更新し、推定式とデータソースのセクションに以下を追加：
```markdown
### タクシー候補数推定

各便の推定降客数に「アプリ配車のタクシー客に特化した分担率」を掛け、終電到達率と遅延補正を適用してタクシー候補数を出力。
- ベース分担率: 時間帯（7-9朝・17-19第1ピーク・19-21:30暇・21:30-第2ピーク）×ターミナル
- 終電到達率: 主要目的地ルート12本の最終接続時刻と便のロビー出口時刻を比較した重み付き比率
- 遅延ブースト: 60分以上遅延 かつ 23:30以降ロビー出口の便に×1.15
- ODPT TrainInformation で京急/モノレールの運休・大規模遅延を反映

詳細は `docs/superpowers/specs/2026-04-25-haneda-taxi-pax-prediction-design.md` を参照。
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README v0.5 — タクシー候補数推定機能"
```

---

## Phase 6: 過去履歴データでの校正（後フェーズ）

### Task 20: 過去乗務履歴CSVから transit-share.json を校正

このタスクはユーザーから過去乗務履歴のCSVコピーを受領した後に着手する。**先送りタスク**。

**Files:**
- Modify: `data/transit-share.json`
- Modify: `data/last-mile-routes.json`（route weight）
- Create: `scripts/calibrate-from-history.mjs`（校正用ワンショットスクリプト）
- Create: `tests/fixtures/history-sample.csv`（テスト用サンプル数行）

- [ ] **Step 1: ユーザーから CSV を受領、`data/_private/history.csv` に置く（gitignore 追加）**

`.gitignore` に追加：
```
data/_private/
```

- [ ] **Step 2: CSV のスキーマを確認**

スプレッドシートの列名を把握（乗車日時 / 乗車場所 / 降車場所 / 運賃 / 距離 など）。

- [ ] **Step 3: `scripts/calibrate-from-history.mjs` を実装**

要点：
- CSV を読む
- 乗車場所 = 羽田空港 でフィルタ
- 乗車時刻を 8 つの bucket に振り分け
- 降車地域を last-mile-routes の地域に逆引き
- bucket × ターミナル別の発生比率を出力（参考値）
- 地域別件数 → route weight の実測値計算

- [ ] **Step 4: 出力を `transit-share.json` と `last-mile-routes.json` の手動更新材料として使う**

スクリプトは値を直接書き換えず、**「現行値 vs 履歴ベース推定値」の比較レポートを stdout に出す**。乗務員が判断して手動でJSONを更新。

- [ ] **Step 5: 校正後テスト**

校正後の値で全テストが pass し、ヒートマップやサマリの数値が実感に合うかブラウザで目視確認。

- [ ] **Step 6: Commit**

```bash
git add scripts/calibrate-from-history.mjs data/transit-share.json data/last-mile-routes.json .gitignore
git commit -m "feat(calibrate): 過去乗務履歴ベースで分担率＋ルート重みを校正"
```

---

## 実装後の確認チェックリスト

- [ ] 既存86件 + 新規テストが全て pass
- [ ] `arrivals.html` をブラウザで開いて以下を目視確認:
  - [ ] 便リストに 🟢/🟡/🔴 アイコンと「タクシー候補~XX」が出る
  - [ ] サマリに「タクシー候補 XX人 / ピーク帯 HH:MM」が出る
  - [ ] ヒートマップ「降客 / タクシー候補」トグルが切替わる
  - [ ] 上部に「京急 / モノレール」運行情報バッジが出る
  - [ ] トピックが「reach不可 / 遅延深夜便」を表示する
- [ ] GitHub Actions:
  - [ ] update-arrivals が正常動作（既存）
  - [ ] update-rail-status が初回手動実行で動作（workflow_dispatch）
- [ ] 過去履歴CSVを受領したら Task 20 を実行

## 補足

- **Phase 5（C案・運行情報）はスパイク（Task 14）で API 仕様を確認してから着手**。スパイク結果次第で Task 15 のフィールド名が変わる可能性あり。
- **Phase 6（校正）はユーザーから CSV 提供後**に実施。それまでは経験則ベース初期値で運用開始可能。
- 各 Phase の後で `npm test` を実行して既存テストの非破壊を確認する。
