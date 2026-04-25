#!/usr/bin/env node
/**
 * 過去乗務履歴 (data/_private/history.csv) を分析し、時間帯別の
 * 件数密度・休憩時間比率を集計して、現在の transit-share.json と
 * 整合チェックする。
 *
 * 使い方: node scripts/analyze-history.mjs
 *
 * 必須前提:
 *   data/_private/history.csv が存在すること（gitignore対象）
 */
import { readFileSync } from 'node:fs';

const CSV_PATH = './data/_private/history.csv';
const SHARE_PATH = './data/transit-share.json';

// 時間帯定義（日報CSV準拠）
const SLOTS = [
  { id: 'morning',  label: '朝（〜13時）',   spanHours: 5, fromHHMM: '08:00', toHHMM: '13:00' },
  { id: 'noon',     label: '昼（13-18時）',  spanHours: 5, fromHHMM: '13:00', toHHMM: '18:00' },
  { id: 'evening',  label: '夜（18-23時）',  spanHours: 5, fromHHMM: '18:00', toHHMM: '23:00' },
  { id: 'midnight', label: '深夜（23時〜）', spanHours: 4, fromHHMM: '23:00', toHHMM: '03:00' }
];

// CSV パーサ（簡易版、引用符内のカンマを保護）
function parseCsvLine(line) {
  const cells = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQ = !inQ;
    } else if (c === ',' && !inQ) {
      cells.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  cells.push(cur);
  return cells.map(s => s.trim());
}

function parseHhmm(s) {
  if (!s || s === '0:00') return 0;
  const m = s.match(/^(\d+):(\d{2})$/);
  if (!m) return 0;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function parseInt0(s) {
  if (!s) return 0;
  const cleaned = s.replace(/[",\s]/g, '');
  const n = parseInt(cleaned, 10);
  return isNaN(n) ? 0 : n;
}

const csv = readFileSync(CSV_PATH, 'utf8');
const lines = csv.split(/\r?\n/);

// 各「日付行」を抽出: 列C(index 2) が日付っぽく、列G(index 6) に件数があり、列H(index 7) に休憩時間
// 列構成（5行目ヘッダー基準）:
//   0:メモA, 1:メモB, 2:日付, 3:曜日, 4:税抜, 5:税込, 6:回数合計, 7:休憩時間,
//   8-11: 時間帯別 営収（朝/昼/夜/深夜）,
//   12-15: 時間帯別 件数,
//   16-19: 時間帯別 休憩時間

const dataRows = [];
for (const line of lines) {
  if (!line.trim()) continue;
  const c = parseCsvLine(line);
  if (c.length < 20) continue;
  const date = c[2];
  const total = parseInt0(c[6]);
  if (!date || total === 0) continue; // 出庫なし日はスキップ
  // 月内ヘッダー行や合計行は曜日が「合計」「平均」など
  if (['合計', '平均', '税抜', '月収', '手取り', '予想手取り', '目標'].includes(c[3])) continue;
  if (!/(\d+月\d+日|\d+\/\d+)/.test(date) && !/^\d/.test(date)) continue;

  dataRows.push({
    date,
    weekday: c[3],
    totalCount: total,
    breakRest: parseHhmm(c[7]),
    counts:   [parseInt0(c[12]), parseInt0(c[13]), parseInt0(c[14]), parseInt0(c[15])],
    rests:    [parseHhmm(c[16]),  parseHhmm(c[17]),  parseHhmm(c[18]),  parseHhmm(c[19])]
  });
}

console.log(`抽出した日数: ${dataRows.length}`);
console.log('---');

// 時間帯別に集計
const slotAgg = SLOTS.map((s, idx) => ({
  ...s,
  totalCount: 0,
  totalRestMin: 0,
  daysCounted: 0
}));

for (const row of dataRows) {
  for (let i = 0; i < 4; i++) {
    if (row.counts[i] > 0 || row.rests[i] > 0) {
      slotAgg[i].totalCount += row.counts[i];
      slotAgg[i].totalRestMin += row.rests[i];
      slotAgg[i].daysCounted += 1;
    }
  }
}

console.log('=== 時間帯別 件数密度・休憩比率（合計値ベース）===');
console.log('時間帯              | 集計日数 | 件数合計 | 休憩合計   | 件数/h | 休憩比率');
for (const s of slotAgg) {
  const totalSlotMin = s.spanHours * 60 * s.daysCounted;
  const workMin = totalSlotMin - s.totalRestMin;
  const countsPerHour = workMin > 0 ? (s.totalCount / (workMin / 60)) : 0;
  const restRatio = totalSlotMin > 0 ? (s.totalRestMin / totalSlotMin) : 0;
  console.log(
    `${s.label.padEnd(20, '　')}| ${String(s.daysCounted).padStart(4)}日   | ${String(s.totalCount).padStart(4)}件  | ${String(s.totalRestMin).padStart(4)}分     | ${countsPerHour.toFixed(2)}件 | ${(restRatio * 100).toFixed(1)}%`
  );
}

console.log('\n=== 相対需要密度（夜=18-23 を1.00 とした比率）===');
const eveningPerHour = (() => {
  const s = slotAgg[2];
  const work = (s.spanHours * 60 * s.daysCounted) - s.totalRestMin;
  return work > 0 ? (s.totalCount / (work / 60)) : 1;
})();
for (const s of slotAgg) {
  const totalSlotMin = s.spanHours * 60 * s.daysCounted;
  const workMin = totalSlotMin - s.totalRestMin;
  const countsPerHour = workMin > 0 ? (s.totalCount / (workMin / 60)) : 0;
  const ratio = eveningPerHour > 0 ? (countsPerHour / eveningPerHour) : 0;
  console.log(`  ${s.label}: ${ratio.toFixed(2)}`);
}

// 現在の transit-share.json を表示
console.log('\n=== 現在の transit-share.json base rate（参考） ===');
const share = JSON.parse(readFileSync(SHARE_PATH, 'utf8'));
console.log('Bucket           | Range          | T1   | T2   | T3');
for (const b of share.buckets) {
  console.log(
    `${b.id.padEnd(16)} | ${b.fromHHMM}-${b.toHHMM}    | ${b.rates.T1.toFixed(2)} | ${b.rates.T2.toFixed(2)} | ${b.rates.T3.toFixed(2)}`
  );
}

console.log('\n=== 朝細分化のための参考（朝7-9 vs 9-12 の比較は履歴では不可） ===');
console.log('履歴の「朝」は出庫〜13時で5時間ひとまとめ。base rate は朝7-9と9-12に分かれている。');
console.log('朝全体の需要密度を朝7-9と9-12で按分する場合、経験則「9時以降に増える」を維持するのが妥当。');
