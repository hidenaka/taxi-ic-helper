# 羽田プール現地案内テキスト取得 (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** タクシーセンターのプール状況サイト(ttc.taxi-inf.jp)の掲示テキストを Mac mini で取得し、末尾規制(入構可否)と遅延便の現地案内を日報アプリの到着便ビューに表示する。

**Architecture:** 取得は Mac mini の新スクリプト `fetch-pool-notice.mjs`(純関数 `lib/pool-notice.mjs`)が index.php/no23.php の `<td>` 掲示を抽出→`data/pool-notice.json` を書き、observe-tick が commit&push、relay が tools/data へ配信。アプリは `pool-notice.json` を読み、現地案内バナーと末尾規制を描画。便→号パーサと「4→3」上書きは Phase 2(実テキスト確保後)で、本プランは表示器(`formatLaneDisplay`)だけ用意する。

**Tech Stack:** Node.js ESM, `node:test`(taxi-ic-helper の既存テスト規約), Vanilla JS ESM(日報アプリ), GitHub Actions(relay), launchd(observe-tick)。

## Global Constraints

- taxi-ic-helper の生履歴 jsonl はローカルのみ保持(git管理外)。`data/pool-notice-history.jsonl` も同様に `.gitignore` する。
- 取得失敗時は前回 `data/pool-notice.json` を保持し、空で上書きしない(fail-safe)。
- 取得は Mac mini で行う(ttc.taxi-inf.jp は国内IP前提。GitHub Actions=米国runnerからは弾かれうる)。
- アプリ表示には裏側ロジック(手法名/しきい値/生数字)を出さない(既存ルール)。現地案内は「タクシーセンターの掲示」として明示。
- ユーザー向け号表示: 確定号があり推定と異なれば「4→3」、同じなら確定号、無ければ推定号。
- 既存の全テスト緑を維持する。

---

## File Structure

**taxi-ic-helper (`~/repos/taxi-ic-helper`, Mac mini, push=git-safe-sync):**
- Create `scripts/lib/pool-notice.mjs` — 掲示テキストの抽出・除去・判定 純関数。
- Create `tests/pool-notice.test.mjs` — 実HTML fixture に対するユニットテスト。
- Create `tests/fixtures/ttc-index.html`, `tests/fixtures/ttc-no23.html` — 取得済み実HTML。
- Create `scripts/fetch-pool-notice.mjs` — 取得→`data/pool-notice.json` 書き出し+履歴追記(fail-safe)。
- Modify `scripts/observe-tick-local.sh` — fetch 呼び出し追加 + git add に `data/pool-notice.json` 追加。
- Modify `.gitignore` — `data/pool-notice-history.jsonl` を追加。
- Modify `.github/workflows/relay-taxi-data.yml` — paths と FILES に `pool-notice.json` 追加。

**taxi-daily-report (`~/work/taxi-dev`, origin=本番/dev=開発):**
- Modify `tools/js/arrivals-data.js` — `loadPoolNotice()` と `formatLaneDisplay()` を追加。
- Create `tools/js/__tests__/arrivals-data.test.mjs` — `formatLaneDisplay` のユニットテスト。
- Modify `tools/js/arrivals-render.js` — `renderPoolNotice(el, notice)` を追加。
- Modify `tools/js/arrivals-app.js` — import + load + render() に配線。
- Modify `tools/arrivals.html` — `#pool-notice-banner` マウント + CSS。

---

## Task 1: 掲示テキストの純関数 (`scripts/lib/pool-notice.mjs`)

**Files:**
- Create: `scripts/lib/pool-notice.mjs`
- Create: `tests/fixtures/ttc-index.html` (取得済み `/tmp/ttc.html` をコピー)
- Create: `tests/fixtures/ttc-no23.html` (取得済み `/tmp/ttc_no23.php.html` をコピー)
- Test: `tests/pool-notice.test.mjs`

**Interfaces:**
- Produces:
  - `extractTdText(html: string): string` — 最初の `<td>…</td>` をタグ除去・改行保持でプレーン化。
  - `stripBoilerplate(text: string): string` — `【…について】` 見出しと `tokyo-tc.or.jp` URL 行を除去。
  - `parseTailRegulation(text: string): "奇数"|"偶数"|null`
  - `hasFlightNotice(text: string): boolean` — 便名+号/乗り場/待機所+時刻/遅延 が揃えば true。
  - `buildPoolNotice({ no1Text, no34Text, updatedAt }): { updatedAt, tailRegulation, liveText, hasFlightNotice, flightNoticeText }`

- [ ] **Step 1: fixture を保存**

```bash
mkdir -p ~/repos/taxi-ic-helper/tests/fixtures
cp /tmp/ttc.html ~/repos/taxi-ic-helper/tests/fixtures/ttc-index.html
cp /tmp/ttc_no23.php.html ~/repos/taxi-ic-helper/tests/fixtures/ttc-no23.html
```
(/tmp の実HTMLが無い場合は再取得: `curl -s https://ttc.taxi-inf.jp/index.php -o tests/fixtures/ttc-index.html` / `curl -s https://ttc.taxi-inf.jp/no23.php -o tests/fixtures/ttc-no23.html` を Mac mini で実行)

- [ ] **Step 2: 失敗するテストを書く**

`tests/pool-notice.test.mjs`:
```js
import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractTdText, stripBoilerplate, parseTailRegulation, hasFlightNotice, buildPoolNotice } from '../scripts/lib/pool-notice.mjs';

const idx = readFileSync(fileURLToPath(new URL('./fixtures/ttc-index.html', import.meta.url)), 'utf8');
const no23 = readFileSync(fileURLToPath(new URL('./fixtures/ttc-no23.html', import.meta.url)), 'utf8');

test('extractTdText: <td>掲示をプレーン化(改行保持)', () => {
  const t = extractTdText(idx);
  assert.match(t, /末尾規制【奇数】/);
  assert.match(t, /おもてなしレーン/);
  assert.doesNotMatch(t, /<br|<\/td>/);
});

test('stripBoilerplate: 常設お知らせとURL行を落とす', () => {
  const t = stripBoilerplate(extractTdText(idx));
  assert.match(t, /末尾規制【奇数】/);
  assert.doesNotMatch(t, /tokyo-tc\.or\.jp/);
  assert.doesNotMatch(t, /について】/);
});

test('parseTailRegulation: 奇数/偶数を抽出', () => {
  assert.equal(parseTailRegulation(extractTdText(idx)), '奇数');
  assert.equal(parseTailRegulation('末尾規制【偶数】'), '偶数');
  assert.equal(parseTailRegulation('規制なし'), null);
});

test('hasFlightNotice: 通常テキストは false', () => {
  const live = stripBoilerplate(extractTdText(idx));
  assert.equal(hasFlightNotice(live), false);
  assert.equal(hasFlightNotice(stripBoilerplate(extractTdText(no23))), false);
});

test('hasFlightNotice: 便名+号+時刻が揃えば true', () => {
  assert.equal(hasFlightNotice('JL015 23:40着 第3乗り場へ'), true);
  assert.equal(hasFlightNotice('NH84便 第1号'), false); // 時刻も遅延語も無い → false
});

test('buildPoolNotice: 通常運用の現テキストを束ねる', () => {
  const n = buildPoolNotice({ no1Text: extractTdText(idx), no34Text: extractTdText(no23), updatedAt: '2026-06-17T10:00:00+09:00' });
  assert.equal(n.tailRegulation, '奇数');
  assert.equal(n.hasFlightNotice, false);
  assert.equal(n.flightNoticeText, '');
  assert.match(n.liveText, /末尾規制【奇数】/);
});
```

- [ ] **Step 3: テストが落ちることを確認**

Run: `cd ~/repos/taxi-ic-helper && node --test tests/pool-notice.test.mjs`
Expected: FAIL(`Cannot find module '../scripts/lib/pool-notice.mjs'`)

- [ ] **Step 4: 純関数を実装**

`scripts/lib/pool-notice.mjs`:
```js
// 羽田プール現地案内テキスト(ttc.taxi-inf.jp index.php / no23.php の <td> 掲示)の
// 抽出・除去・判定を行う純関数。fetch-pool-notice.mjs から使う。

// 最初の <td>…</td> をタグ除去・改行保持でプレーン化。
export function extractTdText(html) {
  if (typeof html !== 'string') return '';
  const m = html.match(/<td>([\s\S]*?)<\/td>/i);
  if (!m) return '';
  return m[1]
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 常設お知らせ(【…について】見出し と tokyo-tc.or.jp URL 行)を落として運用テキストだけ残す。
export function stripBoilerplate(text) {
  if (!text) return '';
  return text
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (t === '') return true;
      if (/tokyo-tc\.or\.jp/.test(t)) return false;
      if (/^【.*について】$/.test(t)) return false;
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 末尾規制【奇数|偶数】を抽出。
export function parseTailRegulation(text) {
  if (!text) return null;
  const m = text.match(/末尾規制[【\[]?\s*(奇数|偶数)\s*[】\]]?/);
  return m ? m[1] : null;
}

// 便名 + 号/乗り場/待機所 + 時刻/遅延 が揃えば、遅延便の現地案内が出ていると判定。
export function hasFlightNotice(text) {
  if (!text) return false;
  const hasFlight = /[A-Z]{2}\d{2,4}|便|航空/.test(text);
  const hasPool = /第?[1-4１-４]\s*(号|乗り場|乗場|待機所)/.test(text);
  const hasTimeOrDelay = /\d{1,2}:\d{2}|遅延|遅れ/.test(text);
  return hasFlight && hasPool && hasTimeOrDelay;
}

// 取得した各ソースのテキストから pool-notice 本体を組む。
export function buildPoolNotice({ no1Text = '', no34Text = '', updatedAt }) {
  const live1 = stripBoilerplate(no1Text);
  const live34 = stripBoilerplate(no34Text);
  const liveText = [live1, live34].filter(Boolean).join('\n---\n');
  const tailRegulation = parseTailRegulation(no1Text) || parseTailRegulation(no34Text);
  const flagged = hasFlightNotice(liveText);
  return {
    updatedAt,
    tailRegulation,
    liveText,
    hasFlightNotice: flagged,
    flightNoticeText: flagged ? liveText : '',
  };
}
```

- [ ] **Step 5: テストが通ることを確認**

Run: `cd ~/repos/taxi-ic-helper && node --test tests/pool-notice.test.mjs`
Expected: PASS(6 tests)。続けて全体回帰 `node --test` も緑を確認。

- [ ] **Step 6: コミット**

```bash
cd ~/repos/taxi-ic-helper
git add scripts/lib/pool-notice.mjs tests/pool-notice.test.mjs tests/fixtures/ttc-index.html tests/fixtures/ttc-no23.html
git commit -m "feat(pool-notice): 掲示テキスト抽出/除去/末尾規制/遅延判定の純関数+テスト"
```

---

## Task 2: 取得スクリプト (`scripts/fetch-pool-notice.mjs`)

**Files:**
- Create: `scripts/fetch-pool-notice.mjs`
- Modify: `.gitignore`(末尾に1行追加)

**Interfaces:**
- Consumes: `extractTdText`, `buildPoolNotice`(Task 1)。
- Produces: `data/pool-notice.json`(tracked・配信対象) と `data/pool-notice-history.jsonl`(ローカルのみ)。

- [ ] **Step 1: .gitignore に履歴を追加**

`.gitignore` 末尾に追記:
```
data/pool-notice-history.jsonl
```

- [ ] **Step 2: 取得スクリプトを書く**

`scripts/fetch-pool-notice.mjs`:
```js
// ttc.taxi-inf.jp の index.php(第1待機所) / no23.php(第3・第4待機所) の掲示テキストを取得し、
// data/pool-notice.json を書く。取得失敗時は前回JSONを保持(空上書きしない)。Mac miniで実行。
import { writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractTdText, buildPoolNotice } from './lib/pool-notice.mjs';

const ROOT = process.cwd();
const OUT = join(ROOT, 'data/pool-notice.json');
const HIST = join(ROOT, 'data/pool-notice-history.jsonl');
const BASE = 'https://ttc.taxi-inf.jp';

async function fetchText(path) {
  const res = await fetch(`${BASE}/${path}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}`);
  return await res.text();
}

const updatedAt =
  new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }).replace(' ', 'T') + '+09:00';

let no1Html = '';
let no34Html = '';
let ok1 = false;
let ok34 = false;
try { no1Html = await fetchText('index.php'); ok1 = true; } catch (e) { console.error(`[pool-notice] index.php: ${e.message}`); }
try { no34Html = await fetchText('no23.php'); ok34 = true; } catch (e) { console.error(`[pool-notice] no23.php: ${e.message}`); }

if (!ok1 && !ok34) {
  console.error('[pool-notice] both sources failed, keep previous JSON');
  process.exit(0);
}

const notice = buildPoolNotice({
  no1Text: extractTdText(no1Html),
  no34Text: extractTdText(no34Html),
  updatedAt,
});
notice.sources = { no1: { ok: ok1 }, no34: { ok: ok34 } };

writeFileSync(OUT, JSON.stringify(notice, null, 2) + '\n', 'utf8');
appendFileSync(HIST, JSON.stringify({ ts: updatedAt, ...notice }) + '\n', 'utf8');
console.log(`[pool-notice] wrote pool-notice.json (tail=${notice.tailRegulation} flightNotice=${notice.hasFlightNotice})`);
```

- [ ] **Step 3: 実行して出力を確認**

Run: `cd ~/repos/taxi-ic-helper && node scripts/fetch-pool-notice.mjs && cat data/pool-notice.json`
Expected: `tailRegulation:"奇数"`, `hasFlightNotice:false`, `liveText` に「末尾規制【奇数】」が入る。`data/pool-notice-history.jsonl` に1行追記される。

- [ ] **Step 4: コミット**

```bash
cd ~/repos/taxi-ic-helper
git add scripts/fetch-pool-notice.mjs .gitignore data/pool-notice.json
git commit -m "feat(pool-notice): ttc掲示テキスト取得スクリプト(fail-safe)+履歴局所保持"
```

---

## Task 3: observe-tick と relay への配線

**Files:**
- Modify: `scripts/observe-tick-local.sh`
- Modify: `.github/workflows/relay-taxi-data.yml`

**Interfaces:**
- Consumes: `scripts/fetch-pool-notice.mjs`(Task 2)。
- Produces: 5分ごとに `data/pool-notice.json` が commit&push され、relay が tools/data へ配信。

- [ ] **Step 1: observe-tick に取得呼び出しを追加**

`scripts/observe-tick-local.sh` の `node scripts/learn-arrival-advance.mjs || true` の直後に追加:
```bash
# 羽田プール現地案内テキスト取得 (fail-safe・Phase1)
node scripts/fetch-pool-notice.mjs || true
```

- [ ] **Step 2: git add リストに pool-notice.json を追加**

`scripts/observe-tick-local.sh` の `git add data/stall-forecast.json …` の行末(`data/advance-forecast.json` の後)に ` data/pool-notice.json` を加える。
変更後の該当行(完全形):
```bash
git add data/stall-forecast.json data/stall-pattern-match.json data/forecast-accuracy.json data/stall-ensemble.json data/stall-actuals.json data/coefficient-corrections.json data/throughput-calibration.json data/t3-pool-fill.json data/pool-status.json data/pool-cam-real01.jpg data/pool-cam-real02.jpg data/advance-forecast.json data/pool-notice.json 2>/dev/null || true
```

- [ ] **Step 3: 構文チェック**

Run: `cd ~/repos/taxi-ic-helper && bash -n scripts/observe-tick-local.sh && echo OK`
Expected: `OK`

- [ ] **Step 4: relay の paths と FILES に追加**

`.github/workflows/relay-taxi-data.yml`:
- `on.push.paths` に1行追加(`data/advance-forecast.json` の下):
```yaml
      - 'data/pool-notice.json'
```
- `FILES=` の文字列末尾に ` pool-notice.json` を追加。変更後(完全形):
```bash
          FILES="arrivals.json stall-ensemble.json stall-actuals.json t3-pool-fill.json pool-status.json pool-cam-real01.jpg pool-cam-real02.jpg advance-forecast.json pool-notice.json"
```

- [ ] **Step 5: コミット & 安全push**

```bash
cd ~/repos/taxi-ic-helper
git add scripts/observe-tick-local.sh .github/workflows/relay-taxi-data.yml
git commit -m "feat(pool-notice): observe-tickで5分取得+relay配信に追加"
source scripts/lib/git-safe-sync.sh; git_safe_sync_and_push "$PWD" main 6
```

- [ ] **Step 6: 配信を確認(end-to-end)**

Run(MacBook): `gh run list -R hidenaka/taxi-ic-helper --workflow=relay-taxi-data.yml -L 2` で relay 発火を確認 → `curl -s "https://app.taxicabis.com/tools/data/pool-notice.json?_cb=$(date +%s)" | head` で本番に配信されたことを確認。
Expected: `tailRegulation` と `liveText` が本番に届く。

---

## Task 4: アプリのデータ層 (`tools/js/arrivals-data.js`)

**Files:**
- Modify: `~/work/taxi-dev/tools/js/arrivals-data.js`
- Test: `~/work/taxi-dev/tools/js/__tests__/arrivals-data.test.mjs`

**Interfaces:**
- Produces:
  - `loadPoolNotice(): Promise<object|null>` — `./data/pool-notice.json` を取得(失敗時 null)。
  - `formatLaneDisplay(estimate, confirmed): string` — 確定号があり推定と異なれば `"4→3"`、同じなら `"3"`、確定無しなら推定号、推定も無しなら `""`。

- [ ] **Step 1: 失敗するテストを書く**

`tools/js/__tests__/arrivals-data.test.mjs`:
```js
import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import { formatLaneDisplay } from '../arrivals-data.js';

test('formatLaneDisplay: 確定なしは推定号', () => {
  assert.equal(formatLaneDisplay(4, null), '4');
  assert.equal(formatLaneDisplay(null, null), '');
});
test('formatLaneDisplay: 確定=推定は確定号のみ', () => {
  assert.equal(formatLaneDisplay(3, 3), '3');
});
test('formatLaneDisplay: 確定≠推定は 4→3', () => {
  assert.equal(formatLaneDisplay(4, 3), '4→3');
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `cd ~/work/taxi-dev && node --test tools/js/__tests__/arrivals-data.test.mjs`
Expected: FAIL(`formatLaneDisplay is not a function` もしくは import エラー)

- [ ] **Step 3: 関数を実装**

`tools/js/arrivals-data.js` の末尾に追加:
```js
// 羽田プール現地案内(pool-notice.json)を取得。失敗時は null(バナー非表示で安全劣化)。
export async function loadPoolNotice() {
  try {
    const res = await fetch(`./data/pool-notice.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// 号(乗り場)の表示文字列。確定号があり推定と異なれば "4→3"、同じなら確定号、確定なしは推定号。
export function formatLaneDisplay(estimate, confirmed) {
  if (confirmed == null) return estimate != null ? String(estimate) : '';
  if (estimate != null && Number(estimate) !== Number(confirmed)) return `${estimate}→${confirmed}`;
  return `${confirmed}`;
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd ~/work/taxi-dev && node --test tools/js/__tests__/arrivals-data.test.mjs`
Expected: PASS(3 tests)

- [ ] **Step 5: コミット**

```bash
cd ~/work/taxi-dev
git add tools/js/arrivals-data.js tools/js/__tests__/arrivals-data.test.mjs
git commit -m "feat(arrivals): loadPoolNotice + formatLaneDisplay(4→3表示器)"
```

---

## Task 5: 現地案内バナーの描画と配線

**Files:**
- Modify: `~/work/taxi-dev/tools/js/arrivals-render.js`
- Modify: `~/work/taxi-dev/tools/js/arrivals-app.js`
- Modify: `~/work/taxi-dev/tools/arrivals.html`

**Interfaces:**
- Consumes: `loadPoolNotice`(Task 4), `renderPoolNotice`(本タスク)。
- Produces: 到着便ビュー上部に「タクシーセンター現地案内」バナー(末尾規制 + 遅延案内テキスト)。

- [ ] **Step 1: renderPoolNotice を追加**

`tools/js/arrivals-render.js` の末尾に追加:
```js
// タクシーセンターの現地案内(末尾規制 + 遅延便案内)を描画。
// notice が無い/案内が無ければ非表示(普段は邪魔しない)。
export function renderPoolNotice(el, notice) {
  if (!el) return;
  if (!notice || (!notice.tailRegulation && !notice.hasFlightNotice)) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const parts = [];
  if (notice.tailRegulation) {
    parts.push(`<div class="pn-tail">🚧 末尾規制：<b>${esc(notice.tailRegulation)}</b>（この末尾のみ入構可）</div>`);
  }
  if (notice.hasFlightNotice && notice.flightNoticeText) {
    parts.push(`<div class="pn-flight"><div class="pn-h">🚖 タクシーセンター現地案内</div><pre class="pn-text">${esc(notice.flightNoticeText)}</pre></div>`);
  }
  el.innerHTML = parts.join('');
  el.hidden = false;
}
```

- [ ] **Step 2: arrivals-app.js に配線**

`tools/js/arrivals-app.js`:
- 1行目の import に `loadPoolNotice` を追加(`loadArrivals,` の隣)。
- 2行目の import に `renderPoolNotice` を追加(`renderWeatherBanner,` の隣)。
- 初期化(`state.arrivals = await loadArrivals();` 付近、Line 28)の直後に追加:
```js
  state.poolNotice = await loadPoolNotice();
```
- `render()`(Line 37〜)の中、`renderWeatherBanner(...)` の直前に追加:
```js
  renderPoolNotice(document.getElementById('pool-notice-banner'), state.poolNotice);
```

- [ ] **Step 3: arrivals.html にマウントとCSSを追加**

`tools/arrivals.html`:
- `<div id="weather-banner" hidden></div>`(Line 287 付近)の直後に追加:
```html
  <div id="pool-notice-banner" class="pool-notice" hidden></div>
```
- `<style>` 内(`#arrivals-error` 定義の近く)に追加:
```css
    .pool-notice { margin: 8px 12px; display: flex; flex-direction: column; gap: 8px; }
    .pool-notice .pn-tail { background: #4a3a1a; color: #ffe; padding: 8px 10px; border-radius: 6px; font-size: 14px; }
    .pool-notice .pn-flight { background: #1a3a2a; color: #eafff0; padding: 8px 10px; border-radius: 6px; }
    .pool-notice .pn-h { font-weight: 700; margin-bottom: 4px; }
    .pool-notice .pn-text { margin: 0; white-space: pre-wrap; font-family: inherit; font-size: 13px; line-height: 1.5; }
```

- [ ] **Step 4: dev で実機スモーク**

Run: dev へ反映(`!~/work/taxi-dev/dpush.sh`)後、dev URL の arrivals ページを kimi-webbridge(実ブラウザ)で開く。
Expected: 末尾規制バナー(🚧 末尾規制：奇数)が表示される。JSエラー0。遅延案内が無い時間帯なので現地案内バナーは非表示でよい。

- [ ] **Step 5: コミット**

```bash
cd ~/work/taxi-dev
git add tools/js/arrivals-render.js tools/js/arrivals-app.js tools/arrivals.html
git commit -m "feat(arrivals): タクシーセンター現地案内バナー(末尾規制+遅延案内)を表示"
```

---

## 完了条件 (Phase 1)
- Mac mini が5分ごとに `data/pool-notice.json` を生成・push し、relay が本番 tools/data へ配信。
- 本番 arrivals ページに末尾規制(入構可否)が表示される。
- 遅延便の現地案内が出た時は `hasFlightNotice` が立ち、現地案内バナーに生テキストが出る。
- `data/pool-notice-history.jsonl`(ローカル)に実テキストが蓄積され、Phase 2(便→号パーサ + 4→3 上書き)の教師データになる。
- 既存の全テスト緑を維持。

## Phase 2 (本プラン外・実テキスト確保後)
`scripts/lib/pool-notice-parser.mjs` を蓄積した実テキストに対し TDD で実装 → arrivals 各便に `poolLaneConfirmed`/`poolLaneSource` を join → `formatLaneDisplay` に確定号を渡して「4→3」を発火。
