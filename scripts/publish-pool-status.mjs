#!/usr/bin/env node
// 現況バンドルを data/ に書き出す: pool-status.json + pool-cam-real01/02.jpg。
// observe-tick-local.sh から5分毎に呼ぶ。fail-safe（失敗してもexit 0）。
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Jimp } from 'jimp';
import { buildPoolStatus } from './lib/pool-status.mjs';

const OCC_PATH = './data/slot-occupancy-history.jsonl';
const YOLO_OCC_PATH = './data/yolo-occupancy-history.jsonl';
const ARCHIVE = process.env.TAXI_IMAGE_ARCHIVE_DIR || path.join(os.homedir(), 'taxi-image-archive');
const THUMB_W = 480;

function latestArchiveFrame(cam) {
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  const day = `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, '0')}-${String(jst.getUTCDate()).padStart(2, '0')}`;
  const dir = path.join(ARCHIVE, cam, day);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter(f => f.endsWith('.jpg')).sort();
  return files.length ? path.join(dir, files[files.length - 1]) : null;
}

async function writeThumb(cam, outName) {
  const src = latestArchiveFrame(cam);
  if (!src) { console.error(`[pool-status] no frame ${cam}`); return; }
  const img = await Jimp.read(src);
  img.resize({ w: THUMB_W });
  await img.write(`./data/${outName}`);
}

async function main() {
  try {
    if (existsSync(OCC_PATH)) {
      const rows = readFileSync(OCC_PATH, 'utf8').trim().split('\n')
        .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      let arrivals = null;
      try {
        if (existsSync('./data/arrivals.json')) {
          arrivals = JSON.parse(readFileSync('./data/arrivals.json', 'utf8'));
        }
      } catch (e) { console.error(`[pool-status] arrivals read failed: ${e.message}`); }
      let holidays = null;
      try {
        if (existsSync('./data/jp-holidays.json')) {
          holidays = JSON.parse(readFileSync('./data/jp-holidays.json', 'utf8'));
        }
      } catch (e) { console.error(`[pool-status] holidays read failed: ${e.message}`); }
      let yoloRows = null;
      try {
        if (existsSync(YOLO_OCC_PATH)) {
          yoloRows = readFileSync(YOLO_OCC_PATH, 'utf8').trim().split('\n')
            .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        }
      } catch { yoloRows = null; }
      const status = buildPoolStatus(rows, new Date(), arrivals, holidays, yoloRows);
      // observe が書いた映像ソースの stale 状態をマージ(本番UIの注意喚起用)。
      // generatedAt は毎 tick 進む(publish は stale 時も走る)ため経年判定では映像エラーを検知できない。
      // observe の明示フラグを載せて、日報アプリ側で専用の注意文を出せるようにする。
      try {
        if (existsSync('./data/pool-source-status.json')) {
          const ss = JSON.parse(readFileSync('./data/pool-source-status.json', 'utf8'));
          status.sourceStale = ss.sourceStale === true;
          if (ss.lastFreshAt) status.sourceStaleSince = ss.lastFreshAt;
        }
      } catch (e) { console.error(`[pool-status] source-status read failed: ${e.message}`); }
      writeFileSync('./data/pool-status.json', JSON.stringify(status, null, 2) + '\n', 'utf8');
      console.log(`[pool-status] ok total.occ=${status.total.occ} level=${status.total.level} activity=${status.activity.level}`);
    }
    await writeThumb('real01_line', 'pool-cam-real01.jpg');
    await writeThumb('real02', 'pool-cam-real02.jpg');
  } catch (e) {
    console.error(`[pool-status] failed: ${e.message}`);
  }
}
main();
