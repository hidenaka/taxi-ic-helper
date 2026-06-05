#!/usr/bin/env node
// publish-advance-forecast — 前進カウント履歴からモデルを作り、乗り場別・15分ごとの
// 予測前進回数カーブを data/advance-forecast.json に出力する。
// 表示(日報tools)が「次の15分: 予測◯回」を読むためのソース。台数とは別物・少なめに出る。

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildAdvanceModel, predictAdvance, predictAdvanceWithFlights, flightFactorByStall, arrivalDemandByStall, recentActualCount, lastCompletedBinRow } from './lib/advance-forecast.mjs';

const THR = 8; // 列移動検出の絶対しきい値。コモンモード除去で照明/夜明け/行灯フリッカを
               // 別途相殺するため、しきい値は感度重視で8に下げる(15は過小検出=予測が低すぎた)。

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HIST = join(ROOT, 'data/advance-count-history.jsonl');
const MS_HIST = join(ROOT, 'data/movement-shift-history.jsonl');
const OCC_HIST = join(ROOT, 'data/slot-occupancy-history.jsonl'); // 空レーンのゲート用
const OUT = join(ROOT, 'data/advance-forecast.json');
const ARRIVALS = join(ROOT, 'data/arrivals.json');
const COEFFS = join(ROOT, 'data/arrival-advance-coeffs.json');     // 段階B学習結果(任意)
const DEMAND_HIST = join(ROOT, 'data/arrival-demand-history.jsonl'); // 段階B学習用ログ
const ROW_WIDTH = join(ROOT, 'data/noriba-row-width.json'); // 号別 横台数(列移動回数×これ=出庫台数)
const STALLS = ['stall1', 'stall2', 'stall3', 'stall4'];

// 号別 横台数(1列の補充で動く台数)。出庫台数 = 列移動回数 × 横台数。
// ファイルが無ければ既定値(1号8/2号7/3号8/4号8)。
function loadRowWidth() {
  const fallback = { stall1: 8, stall2: 7, stall3: 8, stall4: 8 };
  try {
    if (existsSync(ROW_WIDTH)) {
      const j = JSON.parse(readFileSync(ROW_WIDTH, 'utf8'));
      const out = {};
      for (const s of STALLS) out[s] = typeof j?.[s] === 'number' ? j[s] : fallback[s];
      return out;
    }
  } catch { /* 不正は既定にフォールバック */ }
  return fallback;
}

function jstNowIso() {
  const z = (n) => String(n).padStart(2, '0');
  const j = new Date(Date.now() + 9 * 3600 * 1000);
  return `${j.getUTCFullYear()}-${z(j.getUTCMonth() + 1)}-${z(j.getUTCDate())}T${z(j.getUTCHours())}:${z(j.getUTCMinutes())}:00+09:00`;
}

// 直近15分の実測前進回数(ライブfrontDensityから)。履歴が無ければ全て null。
function currentActuals(model, nowIso, msRows, factorByStall, occRows) {
  const out = {};
  const nowEpoch = Math.floor(Date.now() / 1000);
  for (const s of STALLS) {
    const actual = msRows.length
      ? recentActualCount(msRows, s, nowEpoch, { windowMin: 15, absThreshold: THR, debounceSec: 120, occRows })
      : null;
    out[s] = { actual, forecast: Number(predictAdvanceWithFlights(model, nowIso, s, factorByStall).toFixed(1)) };
  }
  return out;
}

if (!existsSync(HIST)) { console.error('履歴なし(backfill未実行?)'); process.exit(1); }
const rows = readFileSync(HIST, 'utf8').trim().split('\n')
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

// ライブ frontDensity を読み込む
let msRows = [];
if (existsSync(MS_HIST)) {
  const all = readFileSync(MS_HIST, 'utf8').trim().split('\n');
  msRows = all.slice(-60).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// 占有履歴(空レーンのゲート用)。直近ぶんだけ読む。
let occRows = [];
if (existsSync(OCC_HIST)) {
  const all = readFileSync(OCC_HIST, 'utf8').trim().split('\n');
  occRows = all.slice(-90).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// ① 履歴を育てる: 直前に完成した15分ビンを学習データへ追記(重複なし)。次回以降の予測精度が上がる。
const grown = msRows.length
  ? lastCompletedBinRow(rows, msRows, Math.floor(Date.now() / 1000), { stalls: STALLS, absThreshold: THR, debounceSec: 120, occRows })
  : null;
if (grown) {
  appendFileSync(HIST, JSON.stringify(grown) + '\n');
  rows.push(grown);
  console.log(`[advance-forecast] grew history: ${grown.ts}`);
}

const model = buildAdvanceModel(rows);

// --- 段階A: 到着便(乗り場号)を予測に効かせる(best-effort, 失敗時は係数なし=従来動作) ---
let factorByStall = null;
let flightApplied = false;
let learnedLag = null; // 段階B 学習結果の可視化(relay先で確認用)
try {
  if (existsSync(ARRIVALS)) {
    const arrivals = JSON.parse(readFileSync(ARRIVALS, 'utf8'));
    let lagByStall = {};
    if (existsSync(COEFFS)) {
      try {
        const c = JSON.parse(readFileSync(COEFFS, 'utf8'));
        for (const s of STALLS) if (c?.coeffs?.[s] && Number.isInteger(c.coeffs[s].lag)) lagByStall[s] = c.coeffs[s].lag;
        learnedLag = Object.fromEntries(STALLS.map((s) => [s, c?.coeffs?.[s] ? { lag: c.coeffs[s].lag, corr: c.coeffs[s].corr, n: c.coeffs[s].n, applied: c.coeffs[s].applied } : null]));
      } catch { /* coeffs 不正は無視 */ }
    }
    factorByStall = flightFactorByStall(arrivals, { stalls: STALLS, lagByStall });
    flightApplied = true;
    // 段階B 学習用: 直前に完成した15分ビンの到着需要をログ(後で実測列移動と突き合わせる)。
    // field=estimatedPax(過去バックフィルと単位を揃える。lagは生データとして残すため未適用で記録)。
    if (grown) {
      const demand = arrivalDemandByStall(arrivals, { stalls: STALLS, field: 'estimatedPax' });
      const b = parseInt(grown.ts.slice(11, 13), 10) * 4 + Math.floor(parseInt(grown.ts.slice(14, 16), 10) / 15);
      const demandRow = { ts: grown.ts, stalls: Object.fromEntries(STALLS.map((s) => [s, demand[s][b] || 0])) };
      appendFileSync(DEMAND_HIST, JSON.stringify(demandRow) + '\n');
    }
  }
} catch (e) {
  console.error(`[advance-forecast] flight factor skipped: ${e.message}`);
  factorByStall = null;
}

// 96 バケット分の予測カーブ。観測のある時間帯のみ出力(夜明け前の空白は省く)。
const slots = [];
for (let b = 0; b < 96; b++) {
  const bk = model.buckets?.[b];
  if (!bk || bk.rows === 0) continue;
  const hh = String(Math.floor(b / 4)).padStart(2, '0');
  const mm = String((b % 4) * 15).padStart(2, '0');
  const ts = `2026-01-01T${hh}:${mm}:00+09:00`;
  const stalls = {};
  for (const s of STALLS) stalls[s] = Number(predictAdvanceWithFlights(model, ts, s, factorByStall).toFixed(1));
  slots.push({ time: `${hh}:${mm}`, stalls });
}

const nowIso = jstNowIso();
const todayJst = nowIso.slice(0, 10);
// 今日の実測列移動カーブ(15分・乗り場別)。学習履歴の今日分を整形(育てるロジックで随時増える)。
const actualsToday = rows
  .filter((r) => r.ts.slice(0, 10) === todayJst)
  .map((r) => ({
    time: r.ts.slice(11, 16),
    stalls: Object.fromEntries(STALLS.map((s) => [s, r.stalls?.[s] || 0])),
  }));

const rowWidth = loadRowWidth(); // 号別 横台数。表示側で 回数×横台数=出庫台数 に切替できる。
const out = {
  schema_version: 3,
  generatedAt: nowIso,
  note: '15分あたりの列移動回数(相対指標)。計測の都合で実際より少なめに出る。出庫台数=列移動回数×横台数(rowWidth)。',
  trainedRows: rows.length,
  flightApplied,
  learnedLag,
  rowWidth,
  current: { time: nowIso.slice(11, 16), stalls: currentActuals(model, nowIso, msRows, factorByStall, occRows) },
  actualsToday,
  slots,
};
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`[advance-forecast] trained=${rows.length}rows slots=${slots.length} -> ${OUT}`);
// 妥当性サンプル: 代表的な時間帯の予測
for (const t of ['08:00', '13:00', '18:00', '22:00']) {
  const s = slots.find((x) => x.time === t);
  if (s) console.log(`  ${t}: ` + STALLS.map((n) => `${n}=${s.stalls[n]}`).join(' '));
}
