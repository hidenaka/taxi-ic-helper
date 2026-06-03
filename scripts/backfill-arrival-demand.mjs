#!/usr/bin/env node
// backfill-arrival-demand — 段階B を過去データで即学習するためのバックフィル。
// 羽田公式 API は searchDt で過去日も返し、完成便は出口がほぼ全便埋まっている。
// 過去の到着便(国内+国際)から「乗り場号×15分ビンの到着需要(estimatedPax)」を再構成し、
// data/arrival-demand-history.jsonl に追記する(既存tsはスキップ)。
// 実行後、learn-arrival-advance.mjs が実測列移動(advance-count-history)とのラグを学習できる。
//
// 使い方: node scripts/backfill-arrival-demand.mjs [startYYYYMMDD endYYYYMMDD]
//   省略時は (今日-7日) 〜 (今日-1日)。

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { flightWing, poolLane } from './lib/haneda-exits.mjs';
import { estimatePax } from './lib/pax-estimator.mjs';
import { computeLobbyExitTime } from './lib/route-reachability.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data/arrival-demand-history.jsonl');
const STALLS = ['stall1', 'stall2', 'stall3', 'stall4'];
const ENDPOINT = 'https://tokyo-haneda.com/app/api/v2/flight/search';
const PAX_FALLBACK = 100; // 機材不明便の暫定pax

const wingTable = JSON.parse(readFileSync(join(ROOT, 'data/haneda-exit-wing.json'), 'utf8')).wing;
const seatsMaster = JSON.parse(readFileSync(join(ROOT, 'data/aircraft-seats.json'), 'utf8'));
const factorsMaster = JSON.parse(readFileSync(join(ROOT, 'data/load-factors.json'), 'utf8'));
const egress = JSON.parse(readFileSync(join(ROOT, 'data/terminal-egress.json'), 'utf8'));
let aircraftFallback = null;
try {
  const byFn = JSON.parse(readFileSync(join(ROOT, 'data/aircraft-by-flight-number.json'), 'utf8'));
  const byRt = JSON.parse(readFileSync(join(ROOT, 'data/aircraft-by-route.json'), 'utf8'));
  aircraftFallback = { byFlightNumber: byFn.flights ?? {}, byRoute: byRt.routes ?? {} };
} catch { aircraftFallback = null; }

function ymd(d) { const z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}`; }
function epochToJstIso(ep) {
  const z = (n) => String(n).padStart(2, '0');
  const j = new Date((ep + 9 * 3600) * 1000);
  return `${j.getUTCFullYear()}-${z(j.getUTCMonth() + 1)}-${z(j.getUTCDate())}T${z(j.getUTCHours())}:${z(j.getUTCMinutes())}:00+09:00`;
}
function datesRange(start, end) {
  const out = [];
  const s = new Date(`${start.slice(0, 4)}-${start.slice(4, 6)}-${start.slice(6, 8)}T00:00:00+09:00`);
  const e = new Date(`${end.slice(0, 4)}-${end.slice(4, 6)}-${end.slice(6, 8)}T00:00:00+09:00`);
  for (let t = s; t <= e; t = new Date(t.getTime() + 86400000)) out.push(ymd(t));
  return out;
}

async function fetchDay(searchDt, flightType) {
  const body = { flightType, arrivalType: 2, searchDt, airportCodes: [], airlineCodes: [], flightNumber: '', status: [] };
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (taxi-ic-helper backfill)' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// arrivalsJson(公式API) の1便 → {stall, lobbyHHMM, pax} or null
function flightToDemand(f, isIntl, dateKey) {
  const terminal = f?.terminal?.terminal ?? null;
  if (!terminal) return null;
  const eg = (f.options || []).find((o) => o.type === 'exitGate');
  const exits = eg && Array.isArray(eg.items) ? eg.items.map((i) => i.name).filter((v) => v != null) : [];
  const wing = flightWing(terminal, exits, wingTable);
  const lane = poolLane(terminal, wing, isIntl);
  if (!lane) return null;
  const stall = 'stall' + lane;
  // 時刻: 変更後(change_time)優先、無ければ予定(on_time)
  const at = (f.change_time && f.change_time !== '-') ? f.change_time : f.on_time;
  if (typeof at !== 'string' || at.length < 4) return null;
  const lobby = computeLobbyExitTime(at, terminal, isIntl, egress); // "HH:MM"
  if (!lobby) return null;
  const fn = f.airlines?.[0]?.flightNumber ?? null;
  let pax = estimatePax({ aircraftCode: null, flightNumber: fn, from: null }, seatsMaster, factorsMaster, aircraftFallback);
  if (!(typeof pax === 'number' && pax > 0)) pax = PAX_FALLBACK;
  return { stall, lobby, pax, dateKey };
}

async function main() {
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  const args = process.argv.slice(2);
  const end = args[1] || ymd(new Date(now.getTime() - 86400000));
  const start = args[0] || ymd(new Date(now.getTime() - 7 * 86400000));
  const dates = datesRange(start, end);

  // 既存ts集合(重複追記防止)
  const existing = new Set();
  if (existsSync(OUT)) {
    for (const l of readFileSync(OUT, 'utf8').trim().split('\n')) {
      try { existing.add(JSON.parse(l).ts); } catch { /* skip */ }
    }
  }

  const rowsByTs = new Map(); // ts -> {stall: pax}
  for (const dt of dates) {
    for (const ft of [1, 2]) { // 1=国内, 2=国際
      let json;
      try { json = await fetchDay(dt, ft); } catch (e) { console.error(`[backfill] ${dt} ft${ft}: ${e.message}`); continue; }
      const fl = Array.isArray(json.flightlists) ? json.flightlists : [];
      for (const f of fl) {
        const d = flightToDemand(f, ft === 2, dt);
        if (!d) continue;
        const hh = parseInt(d.lobby.slice(0, 2), 10), mm = parseInt(d.lobby.slice(3, 5), 10);
        if (Number.isNaN(hh) || Number.isNaN(mm)) continue;
        // 日付0時の epoch + ロビー分 を 15分ビンに丸める(24:xx は翌日へ正しく繰り上がる)
        const dayEpoch = Math.floor(Date.parse(`${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}T00:00:00+09:00`) / 1000);
        const bucketEpoch = Math.floor((dayEpoch + (hh * 60 + mm) * 60) / 900) * 900;
        const ts = epochToJstIso(bucketEpoch);
        const row = rowsByTs.get(ts) || {};
        row[d.stall] = (row[d.stall] || 0) + d.pax;
        rowsByTs.set(ts, row);
      }
    }
  }

  // ts昇順で、未記録のものだけ追記
  const sorted = [...rowsByTs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  let appended = 0;
  const lines = [];
  for (const [ts, stalls] of sorted) {
    if (existing.has(ts)) continue;
    lines.push(JSON.stringify({ ts, stalls: Object.fromEntries(STALLS.map((s) => [s, stalls[s] || 0])) }));
    appended++;
  }
  if (lines.length) {
    const prev = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
    writeFileSync(OUT, prev + (prev && !prev.endsWith('\n') ? '\n' : '') + lines.join('\n') + '\n');
  }
  console.log(`[backfill] dates ${start}..${end}: appended ${appended} bins (skipped ${sorted.length - appended} existing)`);
}

main().catch((e) => { console.error('[backfill] fatal', e.message); process.exit(1); });
