#!/usr/bin/env node
import { writeFileSync } from 'node:fs';

const CSV_URL = 'https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv';
const OUT_PATH = './data/holidays.json';

function normalizeDate(s) {
  const m = s.trim().match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

function parseCsv(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const [dateStr, name] = line.split(',');
    const ymd = normalizeDate(dateStr ?? '');
    if (ymd) out.push({ date: ymd, name: (name ?? '').trim() });
  }
  return out;
}

function addYearEnd(dates) {
  const set = new Set(dates);
  const years = new Set();
  for (const d of dates) years.add(parseInt(d.slice(0, 4), 10));
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  const ny = now.getFullYear();
  years.add(ny - 1);
  years.add(ny);
  years.add(ny + 1);
  for (const y of years) {
    for (const md of ['12-29', '12-30', '12-31', '01-01', '01-02', '01-03']) {
      set.add(`${y}-${md}`);
    }
  }
  return [...set].sort();
}

const res = await fetch(CSV_URL, { signal: AbortSignal.timeout(20000) });
if (!res.ok) {
  console.error(`HTTP ${res.status} ${res.statusText}`);
  process.exit(1);
}
const buf = await res.arrayBuffer();
const text = new TextDecoder('shift_jis').decode(buf);
const holidays = parseCsv(text);
if (holidays.length === 0) {
  console.error('Parsed 0 holidays. Aborting (would overwrite with empty set).');
  process.exit(1);
}

const dates = addYearEnd(holidays.map(h => h.date));

const out = {
  generatedAt: new Date().toISOString(),
  source: '内閣府 国民の祝日CSV + 年末年始(12/29-1/3)を holiday 扱い',
  count: dates.length,
  dates
};

writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(`Wrote ${dates.length} dates to ${OUT_PATH}`);
