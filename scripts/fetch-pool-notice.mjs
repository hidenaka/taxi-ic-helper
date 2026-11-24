// ttc.taxi-inf.jp の index.php(第1待機所) / no23.php(第3・第4待機所) の掲示テキストを取得し、
// data/pool-notice.json を書く。取得失敗時は前回JSONを保持(空上書きしない)。Mac miniで実行。
import { writeFileSync, appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

// 元のページもそのまま残す(2026-11-24)。読み取りの規則が壊れると、上の履歴には空の文章しか
// 残らず、あとから読み直せなかった(10/14〜11/24 の6週間ぶんを失った)。時刻と画像の番号だけ
// 毎回変わるので、それを除いた中身が前回と違うときだけ1行足す。
const RAW_DIR = join(ROOT, 'data/pool-notice-raw');
const RAW_LAST = join(RAW_DIR, '.last-hash.json');
function saveRawIfChanged(pages) {
  try {
    mkdirSync(RAW_DIR, { recursive: true });
    const last = existsSync(RAW_LAST) ? JSON.parse(readFileSync(RAW_LAST, 'utf8')) : {};
    const day = updatedAt.slice(0, 10);
    for (const [name, html] of Object.entries(pages)) {
      if (!html) continue;
      const stable = html.replace(/\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}|\?\d{14}/g, '');
      const hash = createHash('sha1').update(stable).digest('hex');
      if (last[name] === hash) continue;
      appendFileSync(join(RAW_DIR, `${day}.jsonl`), JSON.stringify({ ts: updatedAt, page: name, html }) + '\n', 'utf8');
      last[name] = hash;
    }
    writeFileSync(RAW_LAST, JSON.stringify(last), 'utf8');
  } catch (e) { console.error(`[pool-notice] raw save failed: ${e.message}`); }
}
saveRawIfChanged({ 'index.php': no1Html, 'no23.php': no34Html });

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
