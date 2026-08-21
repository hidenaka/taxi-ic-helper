#!/usr/bin/env node
// publish-lane-patterns — 現地掲示の実績を lane-actuals.jsonl へ追記し、
// A(便別) と B(パターン別) の学習結果を data/lane-patterns.json に出力する。
//
// 「遅延便が通常と違う号に着くパターンを明確にしたい」(2026-08-14 本人要望) の学習側。
// 実績の出所は現地掲示 (毎晩そのとき限りで消えるので貯めないと学習できない)。
// observe ループから毎 tick 呼ぶ (掲示が無い時間帯は追記ゼロで即終了)。

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseFlightNotice } from './lib/notice-flights.mjs';
import { extractLaneActuals, dedupeActuals, learnByFlight, learnByFlightBand, learnByPattern } from './lib/lane-actuals.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOTICE = join(ROOT, 'data/pool-notice.json');
const ACTUALS = join(ROOT, 'data/lane-actuals.jsonl');
const OUT = join(ROOT, 'data/lane-patterns.json');

function readJsonl(path) {
  if (!existsSync(path)) return [];
  const t = readFileSync(path, 'utf8').trim();
  if (!t) return [];
  return t.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// 1. 今の掲示から実績を抽出し、未記録ぶんだけ追記する
let added = 0;
try {
  if (existsSync(NOTICE)) {
    const notice = JSON.parse(readFileSync(NOTICE, 'utf8'));
    if (notice.hasFlightNotice && notice.flightNoticeText) {
      const parsed = notice.lateFlights ?? parseFlightNotice(notice.flightNoticeText);
      const rows = extractLaneActuals({ ts: notice.updatedAt ?? new Date().toISOString() }, parsed);
      const existing = readJsonl(ACTUALS);
      const seen = new Set(existing.map((r) => `${r.date}|${r.flightNumber}|${r.stall}`));
      for (const r of rows) {
        const k = `${r.date}|${r.flightNumber}|${r.stall}`;
        if (seen.has(k)) continue;   // 同じ号での重複掲示は記録しない
        appendFileSync(ACTUALS, JSON.stringify(r) + '\n');
        seen.add(k);
        added += 1;
      }
      // 掲示テキストはあるのに号付き実績が0件 = 新書式の疑い。アラートに残す
      // (書式は指導員の手打ちで突然変わる。2026-08-21「最終便情報」型を2日間取りこぼした教訓)
      if (rows.length === 0) {
        const ALERTS = join(ROOT, 'data/notice-parse-alerts.jsonl');
        const prev = readJsonl(ALERTS);
        const day = String(notice.updatedAt ?? '').slice(0, 10);
        if (!prev.some((a) => a.date === day)) {
          appendFileSync(ALERTS, JSON.stringify({
            date: day, ts: notice.updatedAt,
            reason: 'hasFlightNotice=true だが号付き実績を1件も抽出できない(新書式の疑い)',
            head: String(notice.flightNoticeText).slice(0, 120),
          }) + '\n');
          console.error('[lane-patterns] 警告: 掲示を号付きで読めていない(新書式?) data/notice-parse-alerts.jsonl 参照');
        }
      }
    }
  }
} catch (e) {
  console.error(`[lane-patterns] 実績の追記に失敗: ${e.message}`);
}

// 2. 蓄積された実績から学習してモデルを書く
const actuals = dedupeActuals(readJsonl(ACTUALS));
if (actuals.length === 0) {
  console.log('[lane-patterns] 実績がまだ無い(掲示待ち)');
  process.exit(0);
}
const byFlight = learnByFlight(actuals);
const byFlightBand = learnByFlightBand(actuals);
const byPattern = learnByPattern(actuals);
const model = {
  schema_version: 1,
  generatedAt: new Date(Date.now() + 9 * 3600 * 1000).toISOString().replace('Z', '+09:00'),
  note: '現地掲示で確定した「実際に着いた号」の実績。A=便別 / B=時間帯×航空会社。件数が少ない項目は出さない。',
  samples: actuals.length,
  span: { from: actuals[0].date, to: actuals[actuals.length - 1].date },
  byFlight,
  byFlightBand,
  byPattern,
};
writeFileSync(OUT, JSON.stringify(model, null, 2) + '\n');
console.log(`[lane-patterns] +${added}件 / 実績${actuals.length}件 → 便別${Object.keys(byFlight).length} 便×時間帯${Object.keys(byFlightBand).length} パターン別${Object.keys(byPattern).length}`);
