#!/usr/bin/env node
// T3 校正用サンプル画像取得スクリプト。
// Real106 / Real107 を取得して data/calibration/t3/<YYYY-MM-DDTHH-MM-SS>/<name>.jpg に保存。
// CLI: `node scripts/snapshot-t3-cameras.mjs`
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TTC_BASE = 'https://ttc.taxi-inf.jp';
const TARGETS = ['Real106', 'Real107'];
const OUTPUT_ROOT = './data/calibration/t3';

function tsForPath() {
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  return jst.toISOString().replace('Z', '').replace(/[:T]/g, '-').replace(/\..+/, '');
}

async function fetchBuffer(name) {
  const res = await fetch(`${TTC_BASE}/${name}.jpg`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const ts = tsForPath();
  const outDir = join(OUTPUT_ROOT, ts);
  mkdirSync(outDir, { recursive: true });
  for (const name of TARGETS) {
    try {
      const buf = await fetchBuffer(name);
      const out = join(outDir, `${name}.jpg`);
      writeFileSync(out, buf);
      console.log(`[snapshot] saved: ${out} (${buf.length} bytes)`);
    } catch (e) {
      console.error(`[snapshot] failed ${name}: ${e.message}`);
    }
  }
  console.log(`[snapshot] done: ${outDir}`);
}

main().catch(e => { console.error(`[snapshot] fatal: ${e.message}`); process.exit(1); });
