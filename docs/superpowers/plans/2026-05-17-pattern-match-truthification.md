# stall-pattern-match.json の真値化 実装 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `stall-pattern-match.json` の `historicalCurve` の outflow を書き出し時に calibration 係数 `k` 倍し、真の出庫 throughput 単位にする（forecast/ensemble/accuracy と揃える）。

**Architecture:** G-5 の純関数 `applyThroughputScale(obj, k)` に第3引数 `slotsKey`（既定 `'slots'`）を追加して一般化し、pattern-match では `slotsKey='historicalCurve'` で再利用する。`observe-taxi-pool.mjs` が `stall-pattern-match.json` 書き出し時にこれを通す。in-memory の `patternMatchResult` と `computePatternMatch` 内部は不変。

**Tech Stack:** Node.js ESM（`node:test`）。新依存なし。`computePatternMatch`・`computeEnsemble`・Python は不変。

**Spec:** `docs/superpowers/specs/2026-05-17-pattern-match-truthification-design.md`

**git 運用:** main 直 push 運用（feature branch なし）。worktree 不要、main workdir で作業。各 Task の最後に commit → `git pull --rebase --autostash origin main` → `git push origin main`。コミットは scripts/tests のみ、観測データ（`data/*`）は混ぜない（`git diff --cached --name-only` で確認、混入時 `git restore --staged data/<file>`）。コミットメッセージ末尾に `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`。

**作業ディレクトリ:** `/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係`（以下、全パスはここからの相対）。

**テストコマンド:** `npm test`（node:test）

---

## File Structure

| ファイル | 役割 | Task |
|---|---|---|
| `scripts/lib/throughput-calibration.mjs` | **改修**。`applyThroughputScale` に `slotsKey` 引数を追加し一般化。 | 1 |
| `tests/throughput-calibration.test.mjs` | **改修**。`slotsKey` 経路の node:test を追加。 | 1 |
| `scripts/observe-taxi-pool.mjs` | **改修**。`stall-pattern-match.json` 書き出しを `applyThroughputScale(..., 'historicalCurve')` 経由に。 | 2 |

---

## Task 1: `applyThroughputScale` の一般化（`slotsKey` 引数）

`applyThroughputScale` に第3引数 `slotsKey`（既定 `'slots'`）を追加し、`obj[slotsKey]` の配列をスケールするよう一般化する。

**Files:**
- Modify: `scripts/lib/throughput-calibration.mjs`（`applyThroughputScale` 関数 + JSDoc）
- Test: `tests/throughput-calibration.test.mjs`

- [ ] **Step 1: 失敗テストを書く**

`tests/throughput-calibration.test.mjs` の末尾に以下を追加:

```js
// --- applyThroughputScale: slotsKey (pattern-match 対応) ---

// pattern-match 形の出力オブジェクトを作る
function makePatternMatchObj() {
  return {
    schemaVersion: 1,
    today: { date: '2026-05-17', dayType: 'sunday_holiday', filterTier: 'all' },
    candidateCount: 5,
    similarDays: [{ date: '2025-05-18', similarity: 0.9, label: 'x' }],
    historicalCurve: [
      { slotStart: '07:45', slotEnd: '07:50', stall1: 1, stall2: 2, stall3: 0, stall4: 3, total: 6 },
      { slotStart: '07:50', slotEnd: '07:55', stall1: 2, stall2: 0, stall3: 1, stall4: 1, total: 4 },
    ],
  };
}

test('applyThroughputScale: slotsKey="historicalCurve" で historicalCurve をスケール', () => {
  const r = applyThroughputScale(makePatternMatchObj(), 2, 'historicalCurve');
  assert.equal(r.historicalCurve[0].stall1, 2);
  assert.equal(r.historicalCurve[0].stall4, 6);
  assert.equal(r.historicalCurve[0].total, 12); // 2+4+0+6
  assert.equal(r.historicalCurve[1].total, 8);  // 4+0+2+2
  assert.equal(r.throughputScaleK, 2);
});

test('applyThroughputScale: slotsKey="historicalCurve" は similarDays/today/metadata を保持', () => {
  const r = applyThroughputScale(makePatternMatchObj(), 2, 'historicalCurve');
  assert.equal(r.today.dayType, 'sunday_holiday');
  assert.equal(r.candidateCount, 5);
  assert.deepEqual(r.similarDays, [{ date: '2025-05-18', similarity: 0.9, label: 'x' }]);
  assert.equal(r.schemaVersion, 1);
});

test('applyThroughputScale: slotsKey 省略時は従来どおり slots をスケール (後方互換)', () => {
  const r = applyThroughputScale(makeForecastObj(), 2);
  assert.equal(r.slots[0].stall1, 4); // makeForecastObj の slots[0].stall1=2 → ×2
  assert.equal(r.slots[0].total, 12); // 4+6+0+2
  assert.equal(r.throughputScaleK, 2);
});

test('applyThroughputScale: slotsKey 配下が配列でない → throughputScaleK のみ付与', () => {
  const r = applyThroughputScale({ schemaVersion: 1, today: {} }, 2, 'historicalCurve');
  assert.equal(r.throughputScaleK, 2);
  assert.equal(r.schemaVersion, 1);
  assert.equal(r.historicalCurve, undefined);
});
```

> `makeForecastObj` は G-5 で同ファイルに定義済みのヘルパ（`slots[0]` が `stall1:2, stall2:3, stall3:0, stall4:1`）。再利用する。

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm test -- tests/throughput-calibration.test.mjs 2>&1 | tail -20`
Expected: 新規テスト「`slotsKey="historicalCurve"` で historicalCurve をスケール」が FAIL（現 `applyThroughputScale` は第3引数を無視し常に `obj.slots` を見るため、pattern-match obj は `slots` 不在で `historicalCurve` がスケールされず `stall1` が元の `1` のまま）。他の新規3テストは現実装でも偶然 pass しうるが、Step 3 実装後に全テストが意図どおり pass することを Step 4 で確認する。

- [ ] **Step 3: `applyThroughputScale` を一般化**

`scripts/lib/throughput-calibration.mjs` の現在の `applyThroughputScale` の JSDoc ブロックと関数全体:

```js
/**
 * forecast / ensemble の出力オブジェクトの slot outflow を k 倍した新オブジェクトを返す。
 *
 * 各 slot の stall1-4 を round(値×k)、total はスケール後 stall1-4 の合計で再計算する。
 * slot のその他フィールド (slotStart/slotEnd/flightFactor/leadBucket 等) と
 * トップレベルのその他フィールド (schemaVersion/trendFactor/trendWindow/weights 等) は保持する。
 * 入力は破壊しない。トップレベルに throughputScaleK (適用した k) を付与する。
 *
 * @param {{slots?: Array}} obj forecast または ensemble の出力オブジェクト
 * @param {number} k スケール係数 (非数値・非正なら 1.0 扱い)
 * @returns {object} スケール済みの新オブジェクト
 */
export function applyThroughputScale(obj, k) {
  const scale = (Number.isFinite(k) && k > 0) ? k : 1.0;
  if (!Array.isArray(obj.slots)) {
    return { ...obj, throughputScaleK: scale };
  }
  const slots = obj.slots.map(slot => {
    const out = { ...slot };
    let total = 0;
    for (const name of ['stall1', 'stall2', 'stall3', 'stall4']) {
      if (typeof slot[name] === 'number') {
        out[name] = Math.round(slot[name] * scale);
        total += out[name];
      }
    }
    out.total = total;
    return out;
  });
  return { ...obj, slots, throughputScaleK: scale };
}
```

を、以下に置換:

```js
/**
 * forecast / ensemble / pattern-match の出力オブジェクトの slot outflow を k 倍した新オブジェクトを返す。
 *
 * slotsKey 配下の配列の各 slot の stall1-4 を round(値×k)、total はスケール後 stall1-4 の
 * 合計で再計算する。slot のその他フィールド (slotStart/slotEnd/flightFactor/leadBucket 等) と
 * トップレベルのその他フィールド (schemaVersion/trendFactor/similarDays/today 等) は保持する。
 * 入力は破壊しない。トップレベルに throughputScaleK (適用した k) を付与する。
 *
 * @param {object} obj forecast/ensemble/pattern-match の出力オブジェクト
 * @param {number} k スケール係数 (非数値・非正なら 1.0 扱い)
 * @param {string} [slotsKey] スケール対象の配列のキー (既定 'slots'、pattern-match は 'historicalCurve')
 * @returns {object} スケール済みの新オブジェクト
 */
export function applyThroughputScale(obj, k, slotsKey = 'slots') {
  const scale = (Number.isFinite(k) && k > 0) ? k : 1.0;
  if (!Array.isArray(obj[slotsKey])) {
    return { ...obj, throughputScaleK: scale };
  }
  const scaledSlots = obj[slotsKey].map(slot => {
    const out = { ...slot };
    let total = 0;
    for (const name of ['stall1', 'stall2', 'stall3', 'stall4']) {
      if (typeof slot[name] === 'number') {
        out[name] = Math.round(slot[name] * scale);
        total += out[name];
      }
    }
    out.total = total;
    return out;
  });
  return { ...obj, [slotsKey]: scaledSlots, throughputScaleK: scale };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm test -- tests/throughput-calibration.test.mjs 2>&1 | tail -15`
Expected: PASS — 既存 35 + 新規 4 = 39 tests passing。

- [ ] **Step 5: 全体回帰テスト**

Run: `npm test 2>&1 | tail -15`
Expected: PASS — 全件 pass（447 → 451）、fail 0。

- [ ] **Step 6: コミット**

```bash
git add scripts/lib/throughput-calibration.mjs tests/throughput-calibration.test.mjs
git diff --cached --name-only   # この2ファイルのみであることを確認
git commit -m "$(cat <<'EOF'
feat: applyThroughputScale を slotsKey 引数で一般化

既定 'slots'、pattern-match は 'historicalCurve' を渡せる。後方互換。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git pull --rebase --autostash origin main && git push origin main
```

---

## Task 2: `observe-taxi-pool.mjs` の配線

`stall-pattern-match.json` の書き出しを `applyThroughputScale(..., 'historicalCurve')` 経由にする。

**Files:**
- Modify: `scripts/observe-taxi-pool.mjs`

> `observe-taxi-pool.mjs` はネットワーク I/O を伴うため単体テストハーネスを持たない。検証は構文/import チェック + `npm test` 回帰で行う。

- [ ] **Step 1: `stall-pattern-match.json` 書き出しをスケール経由に**

`scripts/observe-taxi-pool.mjs` の現在の:

```js
    patternMatchResult = computePatternMatch(allHistory, holidaysSet, new Date());
    writeFileSync(PATTERN_MATCH_OUTPUT_PATH, JSON.stringify(patternMatchResult, null, 2) + '\n', 'utf8');
```

を、以下に置換:

```js
    patternMatchResult = computePatternMatch(allHistory, holidaysSet, new Date());
    writeFileSync(PATTERN_MATCH_OUTPUT_PATH, JSON.stringify(applyThroughputScale(patternMatchResult, throughputK, 'historicalCurve'), null, 2) + '\n', 'utf8');
```

（`patternMatchResult` 変数自体は未スケールのまま。後段で `computeEnsemble` に `{ historicalCurve: patternMatchResult.historicalCurve }` として渡る `patternMatchResult` は net-diff のまま。`applyThroughputScale` と `throughputK` は G-5 で import 済み・hoist 済み。）

- [ ] **Step 2: 構文・import チェック**

Run: `node --check scripts/observe-taxi-pool.mjs && echo SYNTAX_OK`
Expected: `SYNTAX_OK`

- [ ] **Step 3: 全体回帰テスト**

Run: `npm test 2>&1 | tail -15`
Expected: PASS — 全件 pass（451）、fail 0。

- [ ] **Step 4: コミット**

```bash
git add scripts/observe-taxi-pool.mjs
git diff --cached --name-only   # scripts/observe-taxi-pool.mjs のみ。data/ が混ざっていないこと
git commit -m "$(cat <<'EOF'
feat: stall-pattern-match.json を真値化して書き出す

書き出し時に applyThroughputScale で historicalCurve を k 倍。
in-memory patternMatchResult は net-diff 据え置き (ensemble 入力)。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git pull --rebase --autostash origin main && git push origin main
```

---

## 完了後

- `npm test` 全 pass（約 451 件）。Python テストは不変。
- 次の observe tick（Mac mini）から `stall-pattern-match.json` が `applyThroughputScale` 経由で書き出される。`k=bootstrapping`（=1.0）の間は出力不変、`learning` 到達後に `historicalCurve` の outflow が真の出庫台数になり `throughputScaleK` に適用値が出る。
- これで forecast / ensemble / accuracy / pattern-match の4出力 JSON がすべて真値単位で揃う。
- `computePatternMatch`・`computeEnsemble`・`pattern-matcher.mjs` は不変。

**Mac mini デプロイ:** `~/repos/taxi-ic-helper` で `git pull` のみ（observe-tick が自動実行）。新依存なし、launchd 変更なし。

**ロードマップ残（本 plan のスコープ外）:** C 再測定（`DIST_THRESHOLD` 0.025 適用後の確認）、検出ベース並行 forecast。
