#!/usr/bin/env node
// t3-front-flow-report — t3-front-flow-history.jsonl を読み、上昇/下降の両極性で
// 15分窓のイベント数を併記する Phase 2 検証用オフラインレポート。
// 極性・閾値は未確定のため、複数の absThreshold を並べて感度も見せる。
// CLI: node scripts/t3-front-flow-report.mjs [--window 900] [--thresholds 10,20,30]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { summarizeBothPolarities, toJstIso } from './lib/t3-front-flow.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HISTORY_PATH = join(ROOT, 'data/t3-front-flow-history.jsonl');
const REPORT_PATH = join(ROOT, 'data/t3-front-flow-report.json');

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

function main() {
  if (!existsSync(HISTORY_PATH)) {
    console.log('[t3-flow-report] history なし。tick 稼働後に実行する');
    return;
  }
  const rows = readFileSync(HISTORY_PATH, 'utf8').trim().split('\n')
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => a.frame_ts.localeCompare(b.frame_ts));
  if (rows.length < 10) {
    console.log(`[t3-flow-report] データ不足 (${rows.length} 行)。もう少し溜めてから`);
    return;
  }
  const values = rows.map((r) => r.front_density);
  const times = rows.map((r) => Date.parse(r.frame_ts) / 1000);
  const windowSec = Number(arg('window', '900'));
  const thresholds = arg('thresholds', '10,20,30').split(',').map(Number);

  const byThreshold = {};
  for (const th of thresholds) {
    const { rising, falling } = summarizeBothPolarities(values, times, {
      absThreshold: th, windowSec,
    });
    const toList = (binned) => Object.entries(binned)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([start, count]) => ({
        windowStart: toJstIso(new Date(Number(start) * 1000)),
        count,
      }));
    byThreshold[th] = { rising: toList(rising), falling: toList(falling) };
  }

  const report = {
    schemaVersion: 1,
    generatedAt: toJstIso(new Date()),
    rowCount: rows.length,
    span: { from: rows[0].frame_ts, to: rows[rows.length - 1].frame_ts },
    windowSec,
    byThreshold,
  };
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  for (const th of thresholds) {
    const r = byThreshold[th];
    const sum = (l) => l.reduce((a, b) => a + b.count, 0);
    console.log(`[t3-flow-report] th=${th}: rising=${sum(r.rising)} falling=${sum(r.falling)}`);
  }
  console.log(`[t3-flow-report] -> ${REPORT_PATH}`);
}

main();
