// ttc.taxi-inf.jp の index.php(第1待機所) / no23.php(第3・第4待機所) の掲示テキストを取得し、
// data/pool-notice.json を書く。取得失敗時は前回JSONを保持(空上書きしない)。Mac miniで実行。
import { writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractTdText, buildPoolNotice } from './lib/pool-notice.mjs';
import { parseFlightNotice, summarizeFlightNotice } from './lib/notice-flights.mjs';

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

// 履歴には生テキストだけ残す(lateFlights はパーサ改良時に再生成できる派生データ)。
appendFileSync(HIST, JSON.stringify({ ts: updatedAt, ...notice }) + '\n', 'utf8');

// Phase2: 遅延便テキストを構造化して配信JSONに載せる(号別の未着便・人数・客列)。
if (notice.hasFlightNotice) {
  const parsed = parseFlightNotice(notice.flightNoticeText);
  notice.lateFlights = { ...parsed, summary: summarizeFlightNotice(parsed) };
} else {
  notice.lateFlights = null;
}

writeFileSync(OUT, JSON.stringify(notice, null, 2) + '\n', 'utf8');
console.log(`[pool-notice] wrote pool-notice.json (tail=${notice.tailRegulation} flightNotice=${notice.hasFlightNotice} lateFlights=${notice.lateFlights ? notice.lateFlights.flights.length + '便' : 'なし'})`);
