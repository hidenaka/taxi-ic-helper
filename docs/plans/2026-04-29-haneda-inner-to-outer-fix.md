# 首都高内→外側高速 逆方向ルート計算精度修正

> **For agentic workers:** Use `dispatching-parallel-agents` or execute task-by-task with checkpoint reviews.

**Goal:** 入口ICが首都高内（空港中央など）、出口ICが外側高速（横浜町田など）のパターンで、首都高区間と外側高速区間の距離・控除を正しく計算する。
**Architecture:** `judge.js` の `judgeRoute` 関数に、入口が首都高内・出口が外側高速のケース（reverseOuterの逆パターン）を追加し、首都高セグメントと外側高速セグメントの順序・方向を正しく組み立てる。
**Tech Stack:** Vanilla ES Modules (js/judge.js, js/route-options.js), JSON data files (data/deduction.json, data/shutoko_routes.json)

---

## 現状の問題

### 検証済みの事実

**羽田空港(空港中央) → 横浜町田:**
- `outerRoute: hokuseisen_route`
- `entry: kukou_chuou`（首都高内、hokuseisen_routeのentriesに**存在する** → entryDed=Object）
- `exit: yokohama_machida`（外側高速、hokuseisen_routeのentriesに**存在しない** → exitDed=null）
- 現状: `entryDed && exitDed` が false なので本線途中下車パターンに入らない
- 現状: `reverseOuter = false`（entryOuterDedが存在するため）
- 現状: `startIcId = resolveShutokoStartIcId({outerRoute:hokuseisen_route, entryIc:kukou_chuou...})`
  - hokuseisen_route の baseline は `tokyo_ic`
  - 結果: startIcId = `tokyo_ic`
  - shutokoEndpointIcId = `yokohama_machida`
  - 首都高セグメント: `tokyo_ic → yokohama_machida`（これは間違い）

**本来あるべき計算:**
- 首都高区間: `kukou_chuou → tokyo_ic`
- 外側高速区間: `tokyo_ic → yokohama_machida`（hokuseisen_routeの控除計算）

### 類似パターン

入口ICが首都高内で、外側高速のdirectionのentriesに含まれる場合（km=0で登録された空港中央など）:
- `kukou_chuou` は `hokuseisen_route`, `kitasen_route`, `wangan_route`, `yokohane_route`, `hodogaya_route` のentriesに存在（km=0）
- これらのケースでは entryOuterDed が存在する → reverseOuter=false
- startIcId が baseline になる → 首都高区間が baseline→exit になってしまう

---

## ファイル構成

| ファイル | 役割 |
|----------|------|
| `js/judge.js` | ルート判定・距離計算のコアロジック。修正対象。 |
| `js/route-options.js` | 入口/出口ICからouterRoute候補を導出。影響なし（確認のみ）。 |
| `data/deduction.json` | 各directionのbaselineとentries。km=0の空港中央・湾岸環八登録済み。 |
| `data/shutoko_routes.json` | 首都高内の明示距離ペア。確認対象。 |
| `data/shutoko_graph.json` | 首都高グラフ。確認対象。 |

---

## Task 1: 問題パターンの特定と分類

**Files:**
- Read: `js/judge.js`
- Read: `data/deduction.json`
- Read: `data/ics.json`

**Step 1.1: 入口ICが首都高内・出口ICが外側高速のパターンを分類**

以下の条件が全て満たされるケース:
1. `outerRoute` が `OUTER_TRUNK_ROUTES` に含まれる
2. `entryIc.id` が `outerRoute` の entries に含まれる（`entryOuterDed !== null`）
3. `entryOuterDed.km === 0`（首都高内のICとして登録されている）
4. `exitIc.id` が `outerRoute` の entries に含まれない（`exitOuterDed === null`）
5. または `exitOuterDed !== null` だが `exitOuterDed.km > 0`

このケースでは、首都高区間が「entryIc → baseline」、外側高速区間が「baseline → exitIc」の方向になる。

**Step 1.2: 既存のロジックとの整合性確認**

既存の `reverseOuter` は:
- entryOuterDed === null（入口が首都高内ではない）
- exitOuterDed !== null（出口が外側高速のentriesにある）

今回のケースはその逆:
- entryOuterDed !== null（入口が外側高速のentriesにあり、km=0）
- exitOuterDed === null または 異なる外側高速のentriesにある

**Verification:** 手動で `lookupDeduction(deduction, 'kukou_chuou', 'hokuseisen_route')` が Object(km=0) を返すことを確認。

---

## Task 2: judge.js に inner-to-outer パターン検出を追加

**Files:**
- Modify: `js/judge.js:200-295`

**Step 2.1: inner-to-outer フラグを追加**

```javascript
const entryOuterDed = isOuter ? lookupDeduction(deduction, entryIc.id, outerRoute) : null;
const exitOuterDed = isOuter ? lookupDeduction(deduction, exitIc.id, outerRoute) : null;

// reverseOuter: 入口が首都高側・出口が外側高速側（既存）
const reverseOuter = Boolean(isOuter && !entryOuterDed && exitOuterDed);

// innerToOuter: 入口が外側高速のentriesにkm=0で存在・出口が外側高速側または首都高外
// つまり「首都高内のICから外側高速に向かう」パターン
const innerToOuter = Boolean(
  isOuter && entryOuterDed && entryOuterDed.km === 0 && 
  (!exitOuterDed || (exitOuterDed && exitOuterDed.km > 0 && entryIc.id !== exitIc.id))
);
```

**Step 2.2: inner-to-outer 時の首都高セグメント方向を修正**

`innerToOuter` の場合:
- 首都高区間: `entryIc.id → baseline.ic_id`（または外側高速接続点）
- 外側高速区間: `baseline.ic_id → exitIc.id`

現在の `resolveShutokoStartIcId` は外側高速→首都高を想定しているため、inner-to-outer時には別のロジックが必要。

```javascript
// innerToOuter時: 首都高区間は entryIc から外側高速接続点へ
const shutokoStartForInnerToOuter = () => {
  if (innerToOuter) {
    // 入口は首都高内、出口は外側高速
    // 首都高区間: entryIc.id → outerRouteの接続点
    const dir = deduction.directions.find(d => d.id === outerRoute);
    if (dir) return { start: entryIc.id, end: dir.baseline.ic_id };
  }
  return null;
};
```

**Step 2.3: innerToOuter 時のセグメント構築順序を修正**

innerToOuter の場合、セグメント順序は:
1. 首都高区間 (`entryIc.id` → `baseline.ic_id`)
2. 外側高速区間 (`baseline.ic_id` → `exitIc.id`)

現在の `reverseOuter` の逆で、外側高速が後に来る。

```javascript
if (innerToOuter) {
  // 首都高区間を先に追加
  const dir = deduction.directions.find(d => d.id === outerRoute);
  const hubId = dir?.baseline.ic_id;
  
  // 首都高: entryIc → hub
  const shutokoInfo = resolveShutokoDistance({
    shutokoRoutes, shutokoDist, shutokoGraph, ics: deps.ics,
    startIcId: entryIc.id, exitIcId: hubId, shutokoRouteId
  });
  
  if (hubId !== entryIc.id) {
    segs.push({
      name: shutokoInfo.routeLabel ? `首都高（${shutokoInfo.routeLabel}）` : '首都高',
      route: 'shutoko',
      pay: computeShutokoPay({ outerRoute, entryIc, isOuter }),
      deductionKm: 0,
      distanceKm: shutokoInfo.km,
      path: shutokoInfo.path ?? null
    });
  }
  
  // 外側高速: hub → exit
  const controlKm = exitOuterDed?.km ?? 0;
  const physicalBase = exitOuterDed?.physicalKm ?? controlKm;
  segs.push({
    name: routes.labels[outerRoute],
    route: outerRoute,
    pay: 'company',
    deductionKm: controlKm,
    distanceKm: Math.max(0, physicalBase),
    note: exitOuterDed?.note ?? null,
  });
} else if (reverseOuter) {
  // ... 既存のreverseOuter処理
}
```

**注意:** `entryOuterDed.km === 0` のケースで、外側高速区間の控除が `exitOuterDed.km` になるが、baseline からの距離なので、実際には `exitOuterDed.km - entryOuterDed.km = exitOuterDed.km` となる（entryOuterDed.km=0なので）。これは正しい。

**Verification:** Playwright で以下を確認:
- 空港中央 → 横浜町田: 首都高区間 + 外側高速区間が2つ表示される
- 空港中央 → 東京IC: 首都高区間のみ（東京ICがhokuseisen_routeのbaselineなので外側高速区間は不要）
- 空港中央 → 港北: 首都高区間 + 外側高速区間（hokuseisen_routeの港北km=13.3）

---

## Task 3: innerToOuter 時の距離計算の精緻化

**Files:**
- Modify: `js/judge.js`

**Step 3.1: innerToOuter 時の外側高速区間の距離計算を調整**

innerToOuter の場合、外側高速区間は baseline から exit までなので、現状の `reverseOuter` 時の計算と同様に `exitOuterDed.km` をそのまま使えばよい。

ただし、`entryOuterDed.km === 0` の場合、外側高速区間の控除は `exitOuterDed.km - 0 = exitOuterDed.km` で正しい。

**Step 3.2: 物理走行距離の計算**

`exitOuterDed.physicalKm` があればそれを使う。なければ `exitOuterDed.km` をフォールバック。

**Verification:**
- 空港中央 → 港北 (hokuseisen_route):
  - 控除: 13.3km
  - 走行: 20.3km
- 空港中央 → 都筑 (hokuseisen_route):
  - 控除: 15.9km
  - 走行: 22.9km

---

## Task 4: エッジケースの対応

**Files:**
- Modify: `js/judge.js`

**Step 4.1: 入口=出口のケース**

`entryIc.id === exitIc.id` の場合は計算不要。現状のコードで既に `skipShutoko` で対応されるはず。

**Step 4.2: entryOuterDed.km > 0 のケース（本線途中下車パターン）**

これは既存の `entryDed && exitDed` で正しく処理される。

**Step 4.3: innerToOuter かつ viaGaikan のケース**

例: 羽田空港 → 関越方面（外環経由）
- 首都高: 空港中央 → 外環接続点
- 外環: 外環接続点 → 関越接続点
- 外側高速: 関越接続点 → exit

これは現状の `viaGaikan` 処理と組み合わせる必要がある。`innerToOuter` フラグが `viaGaikan` よりも前に評価されるように注意。

**Verification:** Playwright で外環経由パターンも確認。

---

## Task 5: Playwright 自動検証スクリプト

**Files:**
- Create: `tests/e2e/haneda-routes.spec.js`

**Step 5.1: 検証スクリプトを作成**

```javascript
// tests/e2e/haneda-routes.spec.js
// 羽田空港発の各ルートで正しいセグメント数・距離・控除が出ることを検証
```

検証ケース:
1. 空港中央 → 横浜町田 (hokuseisen_route): セグメント数=2, 控除>0
2. 空港中央 → 東京IC (hokuseisen_route): セグメント数=1 or 2, 控除=13.3
3. 空港中央 → 港北 (hokuseisen_route): セグメント数=2, 控除=13.3, 走行=20.3
4. 空港中央 → 都筑 (hokuseisen_route): セグメント数=2, 控除=15.9, 走行=22.9
5. 空港中央 → 横浜青葉 (kitasen_route): セグメント数=2, 控除=0, 走行=19.0
6. 横浜町田 → 空港中央 (tomei, 逆区間): セグメント数=2, 控除=19.7

**Step 5.2: ローカルサーバーで実行**

```bash
python3 -m http.server 8888 &
npx playwright test tests/e2e/haneda-routes.spec.js
```

**Verification:** 全テストがPASSすること。

---

## Task 6: コミットとデプロイ確認

**Step 6.1: コミット**

```bash
git add js/judge.js tests/e2e/haneda-routes.spec.js
git commit -m "fix: 首都高内→外側高速の距離・控除計算を修正

- judge.js: innerToOuterパターンを追加。
  入口ICが首都高内(km=0)、出口ICが外側高速のケースで、
  首都高区間(entry→baseline)と外側高速区間(baseline→exit)を
  正しい順序・方向で計算するように修正。" 
```

**Step 6.2: プッシュ**

```bash
git pull --no-rebase origin main
git push origin main
```

**Step 6.3: GitHub Pages で確認**

ブラウザで `https://hidenaka.github.io/taxi-ic-helper/ic.html` を開き、羽田空港→横浜町田を選択して正しい計算結果が表示されることを確認。

---

## Spec Coverage Check

| 要求 | 対応Task |
|------|----------|
| 首都高内→外側高速のセグメント順序が正しい | Task 2 |
| 距離計算が正しい | Task 3 |
| 控除計算が正しい | Task 3 |
| 外環経由との組み合わせ | Task 4 |
| 自動テスト | Task 5 |

## Placeholder Scan

- コード例は `js/judge.js` の実際の関数シグネチャに基づいている
- ファイルパスは既存の構成に基づいている
- "TBD", "TODO", "implement later" はなし

## 実装上の注意点

1. `resolveShutokoDistance` の `startIcId` / `exitIcId` は双方向検索対応済み（`lookupDistance` が双方向）
2. `innerToOuter` の場合、外側高速区間は `baseline → exit` なので `reverseOuter` とは別に扱う必要がある
3. `entryOuterDed.km === 0` の判定は `Number(entryOuterDed.km) === 0` で厳密に行う
