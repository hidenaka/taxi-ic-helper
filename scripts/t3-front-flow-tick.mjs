#!/usr/bin/env node
// t3-front-flow-tick — T3 前方プール(Real108)の gate ROI 面密度を記録する 60秒 tick。
//
// 設計: docs/superpowers/specs/2026-06-10-t3-front-flow-movement-shift-design.md (Phase 1)
// - ttc の Real108 を直接 fetch し、Last-Modified/ETag(無ければ md5)で前回と同じフレームなら skip
//   (実更新は約1〜2分。60秒 tick の同一フレーム連打を防ぐ = R4)
// - 計数の時刻軸に使う frame_ts はフレームの実時刻(Last-Modified)を記録する
// - 予測には未接続。data/t3-front-flow-history.jsonl への追記専用。git は触らない
//   (commit/push は5分の observe ループが担う = movement-shift と同じ構造)
// - 失敗しても exit 0 (本流の tick を止めない)

import { Jimp } from 'jimp';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { meanGrayInBox, brightPixelRatio, pickFrontSignal } from './lib/advance-counter.mjs';
import {
  parseT3FrontFlowRois, gateToBox, isSameFrame, toJstIso, buildFlowRow,
} from './lib/t3-front-flow.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROIS_PATH = join(ROOT, 'data/t3-front-flow-rois.json');
const STATE_PATH = join(ROOT, 'data/t3-front-flow-state.json');
const HISTORY_PATH = join(ROOT, 'data/t3-front-flow-history.jsonl');
const TIMEOUT_MS = 15000;

async function main() {
  const cfg = parseT3FrontFlowRois(JSON.parse(readFileSync(ROIS_PATH, 'utf8')));
  if (!cfg.calibrated) {
    console.log('[t3-front-flow] gate ROI 未校正のため skip');
    return;
  }

  const res = await fetch(`https://ttc.taxi-inf.jp/${cfg.camera}.jpg`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const lastModified = res.headers.get('last-modified');
  const buffer = Buffer.from(await res.arrayBuffer());
  const hash = createHash('md5').update(buffer).digest('hex');

  const prevState = existsSync(STATE_PATH)
    ? JSON.parse(readFileSync(STATE_PATH, 'utf8'))
    : null;
  if (isSameFrame(prevState, { lastModified, hash })) {
    console.log(`[t3-front-flow] 同一フレーム skip (${lastModified ?? hash.slice(0, 7)})`);
    return;
  }

  const img = await Jimp.read(buffer);
  const box = gateToBox(cfg.gate);
  const { nightLum, lanternK, lanternT } = cfg.params;
  const mean = meanGrayInBox(img, box, 3);
  const isNight = mean < nightLum;
  const ratio = isNight ? brightPixelRatio(img, box, lanternT, 3) : 0;
  const frontDensity = pickFrontSignal(mean, ratio, { nightLum, lanternK });

  const frameTs = lastModified ? toJstIso(new Date(lastModified)) : toJstIso(new Date());
  const tickTs = toJstIso(new Date());
  const row = buildFlowRow({
    frameTs, tickTs, camera: cfg.camera, isNight, frontDensity, frameHash: hash,
  });

  appendFileSync(HISTORY_PATH, JSON.stringify(row) + '\n');
  writeFileSync(STATE_PATH, JSON.stringify({
    last_modified: lastModified, frame_hash: hash, frame_ts: frameTs,
  }));
  console.log(`[t3-front-flow] ${frameTs} density=${row.front_density} night=${isNight}`);
}

main().catch((e) => {
  console.warn(`[t3-front-flow] skip: ${e.message}`);
  process.exit(0);
});
