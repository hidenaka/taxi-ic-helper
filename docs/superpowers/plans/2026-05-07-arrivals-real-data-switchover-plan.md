# 到着便ビューワー 実データ切替 実装プラン

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 到着便ビューワーのデータソースを mock から ODPT 実データへ切り替え、フロントに updatedAt 鮮度警告バナーを追加する。

**Architecture:** フロント / 取得スクリプト / Actions の構造は不変。`arrivals-data.js` に `classifyStaleness` 純粋関数を追加し、`arrivals-render.js` に `renderStaleBanner` 描画関数を追加、`arrivals-app.js` で組み合わせる。`arrivals.html` にバナー要素 1 つと CSS を追加。実データ切替は ODPT_TOKEN を GitHub Secrets に登録するだけで Actions が自動的に切り替わる。

**Tech Stack:** ES Modules / `node:test` + `node:assert/strict` / Vanilla JS DOM / GitHub Actions / ODPT API

**設計ドキュメント:** `docs/superpowers/specs/2026-05-07-arrivals-real-data-switchover-design.md`

---

## File Structure

| ファイル | 種別 | 役割 |
|---|---|---|
| `js/arrivals-data.js` | Modify | 既存の集計純粋関数群に `classifyStaleness(updatedAtIso, now)` を追加 |
| `tests/staleness.test.mjs` | Create | `classifyStaleness` のユニットテスト |
| `js/arrivals-render.js` | Modify | 既存の描画関数群に `renderStaleBanner(container, classification)` を追加 |
| `arrivals.html` | Modify | `<div id="stale-banner">` 要素と warn/critical 用 CSS を追加 |
| `js/arrivals-app.js` | Modify | `render()` 内で staleness 分類 → バナー描画呼び出し |
| `.env.example` | Create | `ODPT_TOKEN=your-token-here` のテンプレート |
| `README.md` | Modify | v0.6 表記を v0.7 に更新、mock データ記述を実データ運用に書き換え |

`.gitignore` は既に `.env*` を含むため変更不要 (`grep '.env\*' .gitignore` で確認可能)。

ファイル分割の意図:
- 純粋関数は `arrivals-data.js`、DOM 描画は `arrivals-render.js`、状態と orchestration は `arrivals-app.js` という既存の責務分離パターンを踏襲
- `classifyStaleness` を純粋関数として切り出すことで、DOM なしのユニットテストで境界値を確実に検証できる

---

## Task 1: `classifyStaleness` 純粋関数を追加 (TDD)

**Files:**
- Create: `tests/staleness.test.mjs`
- Modify: `js/arrivals-data.js` (末尾に関数追加)

- [ ] **Step 1.1: テストファイルを作成 (失敗するテスト)**

`tests/staleness.test.mjs` を新規作成:

```javascript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { classifyStaleness } from '../js/arrivals-data.js';

// 固定時刻 (JST 12:00) を基準にする。JST 5:00 抑制条件にはかからない。
const NOON_JST_ISO = '2026-05-07T12:00:00+09:00';
const noon = new Date(NOON_JST_ISO);

function minutesAgoIso(min) {
  return new Date(noon.getTime() - min * 60 * 1000).toISOString();
}

test('classifyStaleness: 0 分前 → fresh', () => {
  const r = classifyStaleness(minutesAgoIso(0), noon);
  assert.equal(r.level, 'fresh');
  assert.equal(r.ageMinutes, 0);
});

test('classifyStaleness: 14 分前 → fresh (境界手前)', () => {
  const r = classifyStaleness(minutesAgoIso(14), noon);
  assert.equal(r.level, 'fresh');
  assert.equal(r.ageMinutes, 14);
});

test('classifyStaleness: 15 分前 → warn (境界)', () => {
  const r = classifyStaleness(minutesAgoIso(15), noon);
  assert.equal(r.level, 'warn');
  assert.equal(r.ageMinutes, 15);
});

test('classifyStaleness: 60 分前 → warn (境界)', () => {
  const r = classifyStaleness(minutesAgoIso(60), noon);
  assert.equal(r.level, 'warn');
  assert.equal(r.ageMinutes, 60);
});

test('classifyStaleness: 61 分前 → critical', () => {
  const r = classifyStaleness(minutesAgoIso(61), noon);
  assert.equal(r.level, 'critical');
  assert.equal(r.ageMinutes, 61);
});

test('classifyStaleness: 180 分前 → critical', () => {
  const r = classifyStaleness(minutesAgoIso(180), noon);
  assert.equal(r.level, 'critical');
  assert.equal(r.ageMinutes, 180);
});

test('classifyStaleness: JST 04:30 時点で 8 時間前 → suppressed (朝5時前は抑制)', () => {
  const earlyMorningJst = new Date('2026-05-07T04:30:00+09:00');
  const r = classifyStaleness(
    new Date(earlyMorningJst.getTime() - 8 * 60 * 60 * 1000).toISOString(),
    earlyMorningJst
  );
  assert.equal(r.level, 'suppressed');
});

test('classifyStaleness: JST 06:00 時点で 8 時間前 → critical (抑制が外れる)', () => {
  const sixAmJst = new Date('2026-05-07T06:00:00+09:00');
  const r = classifyStaleness(
    new Date(sixAmJst.getTime() - 8 * 60 * 60 * 1000).toISOString(),
    sixAmJst
  );
  assert.equal(r.level, 'critical');
});

test('classifyStaleness: updatedAtIso が null/undefined → suppressed', () => {
  const r = classifyStaleness(null, noon);
  assert.equal(r.level, 'suppressed');
});
```

- [ ] **Step 1.2: テストを実行して失敗を確認**

```bash
cd 乗務地図関係
node --test tests/staleness.test.mjs
```

期待: `Cannot find module '../js/arrivals-data.js'` ではなく、`SyntaxError: The requested module ... does not provide an export named 'classifyStaleness'` で失敗 (関数が未定義のため)。

- [ ] **Step 1.3: 実装を追加**

`js/arrivals-data.js` の末尾に追加:

```javascript
const STALENESS_WARN_MIN = 15;
const STALENESS_CRITICAL_MIN = 60;
const SUPPRESS_BEFORE_JST_HOUR = 5;

function jstHour(date) {
  const jstStr = date.toLocaleString('en-US', { timeZone: 'Asia/Tokyo', hour: 'numeric', hour12: false });
  return parseInt(jstStr, 10);
}

export function classifyStaleness(updatedAtIso, now) {
  if (!updatedAtIso) return { level: 'suppressed', ageMinutes: null };
  if (jstHour(now) < SUPPRESS_BEFORE_JST_HOUR) {
    return { level: 'suppressed', ageMinutes: null };
  }
  const ageMinutes = Math.floor((now.getTime() - new Date(updatedAtIso).getTime()) / 60000);
  if (ageMinutes < STALENESS_WARN_MIN) return { level: 'fresh', ageMinutes };
  if (ageMinutes <= STALENESS_CRITICAL_MIN) return { level: 'warn', ageMinutes };
  return { level: 'critical', ageMinutes };
}
```

- [ ] **Step 1.4: テストを再実行してパスを確認**

```bash
node --test tests/staleness.test.mjs
```

期待: 9 件すべてパス。

- [ ] **Step 1.5: 全テストスイートを実行 (回帰がないことを確認)**

```bash
npm test
```

期待: 既存の 219 件 + 新規 9 件 = 228 件すべてパス。

- [ ] **Step 1.6: コミット**

```bash
git add tests/staleness.test.mjs js/arrivals-data.js
git commit -m "feat(arrivals): add classifyStaleness pure function with tests"
```

---

## Task 2: `renderStaleBanner` 描画関数を追加

**Files:**
- Modify: `js/arrivals-render.js` (既存 `renderWeatherBanner` の直後に追加)

- [ ] **Step 2.1: 描画関数を追加**

`js/arrivals-render.js` の `renderWeatherBanner` 関数の直後 (165 行目あたり) に追加:

```javascript
export function renderStaleBanner(container, classification) {
  if (!container) return;
  if (!classification || classification.level === 'fresh' || classification.level === 'suppressed') {
    container.innerHTML = '';
    container.hidden = true;
    container.classList.remove('is-warn', 'is-critical');
    return;
  }
  const { level, ageMinutes } = classification;
  container.hidden = false;
  if (level === 'warn') {
    container.classList.add('is-warn');
    container.classList.remove('is-critical');
    container.innerHTML = `
      <span class="stale-icon">⚠</span>
      <span class="stale-msg">データが <strong>${ageMinutes}分前</strong>。更新が遅延している可能性があります。</span>
    `;
    return;
  }
  // critical
  container.classList.add('is-critical');
  container.classList.remove('is-warn');
  container.innerHTML = `
    <span class="stale-icon">⚠</span>
    <span class="stale-msg">データが <strong>${ageMinutes}分前</strong>。API 停止の可能性があるため参考程度にしてください。</span>
  `;
}
```

- [ ] **Step 2.2: 関数が syntax error を起こしていないことを確認**

```bash
node --check js/arrivals-render.js
```

期待: 何も出力されない (構文 OK)。

- [ ] **Step 2.3: 全テストスイートを再実行 (既存テストへの影響なしを確認)**

```bash
npm test
```

期待: すべてパス (228 件)。

- [ ] **Step 2.4: コミット**

```bash
git add js/arrivals-render.js
git commit -m "feat(arrivals): add renderStaleBanner DOM render function"
```

---

## Task 3: `arrivals.html` に DOM 要素 + CSS を追加

**Files:**
- Modify: `arrivals.html` (CSS は 102 行目付近、DOM は 130 行目付近)

- [ ] **Step 3.1: CSS スタイルを追加**

`arrivals.html` の 102 行目 (`#weather-banner strong { color: #fff; font-weight: 700; }`) の直後に追加:

```html
    #stale-banner { padding: 10px 12px; font-size: 13px; display: flex; align-items: center; gap: 8px; border-bottom: 1px solid #2a2a35; }
    #stale-banner.is-warn { background: linear-gradient(90deg, #3a3208, #4a3f10); color: #ffe88a; border-color: #6b5a20; }
    #stale-banner.is-critical { background: linear-gradient(90deg, #4a2010, #5a2818); color: #ffc89a; border-color: #6b3520; }
    #stale-banner .stale-icon { font-size: 18px; }
    #stale-banner strong { color: #fff; font-weight: 700; }
```

- [ ] **Step 3.2: DOM 要素を追加**

`arrivals.html` の 130 行目 (`<div id="weather-banner" hidden></div>`) の直後に追加:

```html
  <div id="stale-banner" hidden></div>
```

挿入後の構造:

```html
  <div id="arrivals-error" hidden></div>

  <div id="weather-banner" hidden></div>

  <div id="stale-banner" hidden></div>

  <div id="topics" hidden></div>
```

- [ ] **Step 3.3: HTML が壊れていないことを確認**

```bash
npm run serve &
SERVER_PID=$!
sleep 2
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8000/arrivals.html
kill $SERVER_PID
```

期待: `200`。

- [ ] **Step 3.4: コミット**

```bash
git add arrivals.html
git commit -m "feat(arrivals): add stale banner DOM and CSS"
```

---

## Task 4: `arrivals-app.js` で staleness 分類と描画を統合

**Files:**
- Modify: `js/arrivals-app.js` (import 文 + render 関数)

- [ ] **Step 4.1: import 文を更新**

`js/arrivals-app.js` の 1〜2 行目を以下に置き換える:

```javascript
import { loadArrivals, filterByTerminals, filterByTimeWindow, aggregateHeatmapClient, summarizeFlights, detectTopics, classifyStaleness } from './arrivals-data.js';
import { renderHeatmap, renderFlightList, renderUpdatedAt, renderSummary, renderLegend, renderTopics, renderWeatherBanner, renderStaleBanner } from './arrivals-render.js';
```

- [ ] **Step 4.2: `render()` 関数に staleness 描画を追加**

`render()` 関数内、`renderWeatherBanner(...)` の呼び出し直後 (現状の 33 行目) に追加:

```javascript
  renderStaleBanner(
    document.getElementById('stale-banner'),
    classifyStaleness(state.arrivals.updatedAt, new Date())
  );
```

挿入後の該当部分:

```javascript
  renderWeatherBanner(document.getElementById('weather-banner'), state.arrivals.weather ?? null);
  renderStaleBanner(
    document.getElementById('stale-banner'),
    classifyStaleness(state.arrivals.updatedAt, new Date())
  );
  renderTopics(document.getElementById('topics'), topics);
```

- [ ] **Step 4.3: 構文チェック**

```bash
node --check js/arrivals-app.js
```

期待: 何も出力されない。

- [ ] **Step 4.4: 全テストスイート再実行**

```bash
npm test
```

期待: すべてパス。

- [ ] **Step 4.5: ブラウザで目視確認 (mock データ + 古い updatedAt で warn/critical を出す)**

mock データの `updatedAt` を手で書き換えて検証:

```bash
# arrivals.json の updatedAt を JST 30 分前に置き換える
node -e '
  const fs = require("fs");
  const j = JSON.parse(fs.readFileSync("./data/arrivals.json", "utf8"));
  const past = new Date(Date.now() - 30 * 60 * 1000).toISOString().replace("Z", "+09:00").replace(/\.\d+/, "");
  j.updatedAt = past;
  fs.writeFileSync("./data/arrivals.json", JSON.stringify(j, null, 2));
  console.log("updatedAt set to 30 minutes ago:", past);
'
npm run serve
# ブラウザで http://localhost:8000/arrivals.html を開く
```

期待: 黄色 `warn` バナーが「データが 30分前。更新が遅延している可能性があります。」と表示される。

次に 90 分前で critical を確認:

```bash
node -e '
  const fs = require("fs");
  const j = JSON.parse(fs.readFileSync("./data/arrivals.json", "utf8"));
  const past = new Date(Date.now() - 90 * 60 * 1000).toISOString().replace("Z", "+09:00").replace(/\.\d+/, "");
  j.updatedAt = past;
  fs.writeFileSync("./data/arrivals.json", JSON.stringify(j, null, 2));
  console.log("updatedAt set to 90 minutes ago:", past);
'
# ブラウザでリロード
```

期待: 橙 `critical` バナーが「データが 90分前。API 停止の可能性があるため参考程度にしてください。」と表示される。

確認後、mock データを正常に再生成して元に戻す:

```bash
node scripts/generate-mock-arrivals.mjs
# ブラウザでリロード → バナーが消える (fresh)
```

- [ ] **Step 4.6: コミット**

```bash
git add js/arrivals-app.js
git commit -m "feat(arrivals): wire classifyStaleness and stale banner into render loop"
```

---

## Task 5: `.env.example` 作成と README 更新

**Files:**
- Create: `.env.example`
- Modify: `README.md`

- [ ] **Step 5.1: `.env.example` を新規作成**

`.env.example` を以下の内容で作成:

```
# 公共交通オープンデータセンター (ODPT) のアクセストークン
# 取得: https://developer.odpt.org/
# このファイルはテンプレート。実値は .env に記述（.env は .gitignore 済み）。
ODPT_TOKEN=your-token-here
```

- [ ] **Step 5.2: `.gitignore` に `.env*` が含まれていることを確認**

```bash
grep -E '^\.env' .gitignore
```

期待: `.env*` が出力される (既に含まれている)。

- [ ] **Step 5.3: `README.md` の v0.6 セクションを v0.7 に更新**

`README.md` の最終セクション「版数」を以下に書き換える (該当箇所は 132〜138 行目):

旧:
```markdown
## 版数

- v0.1: 手動入力、判定ロジック、全方面データ、一時保存機能
- **v0.2**: GPS 連動 (`watchPosition`、精度 ±100m フィルタ)、入口IC を初回サンプルで最寄ICに自動初期設定、最寄IC 上位4件をチップ表示
- v0.3: PWA 化、オフライン対応 / SVG 路線図 + パン/ズーム
- **v0.4**: 羽田到着便ビューワー（ODPT API + 国交省統計、GitHub Actions 5分更新）
- **v0.5**: タクシー候補数推定（経験則ベース時間帯×ターミナル分担率＋終電到達率＋遅延ブースト＋ODPT京急/モノレール運行情報リアルタイム連携）
- **v0.6**: 雷解除ブースト（Open-Meteo で羽田上空の雷活動を検出、解除から60分の滞留便ラッシュ需要を補正。深夜帯は対象外）
```

新:
```markdown
## 版数

- v0.1: 手動入力、判定ロジック、全方面データ、一時保存機能
- **v0.2**: GPS 連動 (`watchPosition`、精度 ±100m フィルタ)、入口IC を初回サンプルで最寄ICに自動初期設定、最寄IC 上位4件をチップ表示
- v0.3: PWA 化、オフライン対応 / SVG 路線図 + パン/ズーム
- **v0.4**: 羽田到着便ビューワー（ODPT API + 国交省統計、GitHub Actions 5分更新）
- **v0.5**: タクシー候補数推定（経験則ベース時間帯×ターミナル分担率＋終電到達率＋遅延ブースト＋ODPT京急/モノレール運行情報リアルタイム連携）
- **v0.6**: 雷解除ブースト（Open-Meteo で羽田上空の雷活動を検出、解除から60分の滞留便ラッシュ需要を補正。深夜帯は対象外）
- **v0.7**: ODPT 実データ運用切替（`ODPT_TOKEN` Secrets 経由）+ updatedAt 鮮度警告バナー（15分超で warn / 60分超で critical）。`generate-mock-arrivals.mjs` はオフライン開発・テスト用フィクスチャに役割変更
```

- [ ] **Step 5.4: README の「データソース」セクションの mock 言及を確認**

```bash
grep -n "mock\|モック" README.md
```

`README.md` 内で「mock」「モック」と書かれている箇所があれば、文脈を確認して更新が必要か判断。`README.md` 本文中で実データ運用が前提として書かれている箇所 (84 行目付近 `データソース` 以下) は既に ODPT 前提なので、変更不要のはず。

- [ ] **Step 5.5: コミット**

```bash
git add .env.example README.md
git commit -m "docs: add .env.example and bump README to v0.7 (real ODPT data + stale banner)"
```

---

## Task 6: ローカル検証 (実データで 1 回叩く)

**Files:** 変更なし (検証のみ)

- [ ] **Step 6.1: `.env` ファイルを作成しトークンを記入**

```bash
cp .env.example .env
# エディタで .env を開いて ODPT_TOKEN=xxx の xxx を実際のトークンに置き換える
```

- [ ] **Step 6.2: トークンが gitignore で守られていることを確認**

```bash
git status --porcelain | grep -E '^\?\? \.env$' || echo "WARN: .env not detected as untracked"
git check-ignore -v .env
```

期待: `git check-ignore -v .env` が `.gitignore:6:.env*    .env` のような出力を返す (パターンマッチ確認)。

- [ ] **Step 6.3: `.env` を読み込んで fetch-arrivals.mjs を実行**

```bash
set -a && source .env && set +a
node scripts/fetch-arrivals.mjs
```

期待: `Wrote N flights to ./data/arrivals.json` のログ。N は 100 〜 300 程度の範囲が現実的 (mock の 48 便より多い)。

エラー時の切り分け:
- `ODPT_TOKEN env var is required` → `set -a && source .env && set +a` を再実行
- `[odpt-client] JAL HTTP 401` 等が全オペレータで出る → トークン誤り
- `[odpt-client] JAL error: ...` がネットワーク系 → 通信を確認
- `No arrival data fetched. Skipping write` → ODPT 側で当該時間帯にデータなし (JST 5:00 前なら正常)

- [ ] **Step 6.4: ブラウザで実データを目視確認**

```bash
npm run serve
# ブラウザで http://localhost:8000/arrivals.html
```

確認項目:
- 便数が mock (48 便) より顕著に多い
- T1 / T2 / T1+T2 / T3 タブ切替が動く
- ヒートマップが表示される (空・崩れ・要素被りがない)
- reachTier (🟢🟡🔴) が便ごとに表示
- タクシー候補数が表示
- トピックスセクションが表示 (該当便があれば)
- updatedAt が今しがた (footer)
- staleness バナーが**表示されていない** (fresh)

- [ ] **Step 6.5: staleness バナーの表示テスト (実データに対して)**

`updatedAt` を手で 30 分前にずらして再読み込み:

```bash
node -e '
  const fs = require("fs");
  const j = JSON.parse(fs.readFileSync("./data/arrivals.json", "utf8"));
  const past = new Date(Date.now() - 30 * 60 * 1000).toISOString().replace("Z", "+09:00").replace(/\.\d+/, "");
  j.updatedAt = past;
  fs.writeFileSync("./data/arrivals.json", JSON.stringify(j, null, 2));
'
# ブラウザでリロード
```

期待: 黄色 `warn` バナー表示。

- [ ] **Step 6.6: ローカルの実データ `arrivals.json` を破棄 (commit を防ぐ)**

```bash
git restore data/arrivals.json
```

期待: `git status` に `data/arrivals.json` が出ない (mock 状態に戻る)。

または明示的に mock を再生成:

```bash
node scripts/generate-mock-arrivals.mjs
```

---

## Task 7: 残り変更を push、Secrets 登録、本番反映確認

**Files:** 変更なし (運用のみ)

- [ ] **Step 7.1: ローカルの commit を確認**

```bash
git log --oneline origin/main..HEAD
```

期待: 設計ドキュメント (Task 0 相当) + Task 1〜5 の合計 6 個程度の commit が並ぶ。それ以外の commit (実データの `arrivals.json` など) が混じっていないことを確認。

- [ ] **Step 7.2: push**

```bash
git push origin main
```

期待: GitHub に変更が反映される。

- [ ] **Step 7.3: GitHub Secrets に `ODPT_TOKEN` を登録**

ブラウザ操作:
1. GitHub リポジトリ (`hidenaka/taxi-ic-helper`) を開く
2. Settings → Secrets and variables → Actions
3. "New repository secret"
4. Name: `ODPT_TOKEN`
5. Value: 入手したトークン文字列
6. "Add secret" を押す

- [ ] **Step 7.4: Actions の次回実行を待つ (最大 5 分)**

ブラウザで Actions タブを開き、`Update Haneda Arrivals` の最新実行を確認:
- "Skip if token not configured" ステップで `skip=false`
- "Fetch arrivals" ステップが実行され、`Wrote N flights to ./data/arrivals.json` が出ている
- "Commit if changed" で `chore(arrivals): auto-update YYYY-MM-DD HH:MM JST` がコミットされている

トリガが待てない場合は手動実行:
- Actions タブ → `Update Haneda Arrivals` → "Run workflow" → main ブランチで実行

- [ ] **Step 7.5: 本番 URL で動作確認**

`https://hidenaka.github.io/taxi-ic-helper/arrivals.html` をブラウザで開く (GitHub Pages の URL は `pages.yml` ワークフローと README から推定。実際の URL はリポジトリの Settings → Pages で確認)。

確認:
- mock より顕著に多い便数
- 各タブ切替が機能
- updatedAt が直近 5 分以内
- staleness バナーが出ていない (fresh)
- ヒートマップ・reachTier・タクシー候補・トピックスが破綻していない

- [ ] **Step 7.6: 完了**

期待: 本番で実データが流れ、Actions が 5 分間隔で `data/arrivals.json` を自動更新。staleness 警告は通常時は出ず、Actions 失敗時のみ自動的に表示される。

---

## ロールバック (問題発生時)

完全に元に戻す手順:

```bash
# 1. Secrets を削除して Actions を mock 状態に戻す
# GitHub Settings → Secrets and variables → Actions → ODPT_TOKEN を Delete

# 2. mock データを再生成して push
node scripts/generate-mock-arrivals.mjs
git add data/arrivals.json
git commit -m "revert(arrivals): regenerate mock data"
git push origin main

# 3. 必要なら staleness バナー追加分の commit を revert
git revert <Task 1〜5 の commit hash>
git push origin main
```

`docs/superpowers/specs/2026-05-07-arrivals-real-data-switchover-design.md` の "ロールバック" セクションも参照。

---

## 検証コマンド一覧 (チートシート)

```bash
# 全テスト実行
npm test

# 特定テストのみ
node --test tests/staleness.test.mjs

# 構文チェック
node --check js/arrivals-data.js
node --check js/arrivals-render.js
node --check js/arrivals-app.js

# ローカルサーブ
npm run serve

# mock データ再生成
node scripts/generate-mock-arrivals.mjs

# 実データ取得 (ODPT_TOKEN を export 済みの状態で)
node scripts/fetch-arrivals.mjs

# .env 経由
set -a && source .env && set +a && node scripts/fetch-arrivals.mjs
```
