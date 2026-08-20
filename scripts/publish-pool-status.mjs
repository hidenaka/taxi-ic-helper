#!/usr/bin/env node
// 現況バンドルを data/ に書き出す: pool-status.json + pool-cam-real01/02.jpg。
// observe-tick-local.sh から5分毎に呼ぶ。fail-safe（失敗してもexit 0）。
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Jimp } from 'jimp';
import { buildPoolStatus } from './lib/pool-status.mjs';

const OCC_PATH = './data/slot-occupancy-history.jsonl';
const SLOT_TEX_PATH = './data/slot-texture-occupancy.jsonl';
const FILL_PATH = './data/noriba-fill-history.jsonl';
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

// 表示用ライブ画像の取得元。2026-08-20 に配信元が新カメラへ切替わり、旧 real01_line /
// real02 は同日 11:26 / 12:25 を最後に更新が止まった(URLは生きたまま同じ画像を返す)。
// 新カメラを先に見て、無いときだけ旧カメラへ落とす。
const THUMB_SOURCES = {
  'pool-cam-real01.jpg': ['real001', 'real01_line'],
  'pool-cam-real02.jpg': ['real002', 'real02'],
};

// 取れた画像の撮影時刻(JST ISO)。アーカイブの日付ディレクトリとファイル名 HHMMSS から起こす。
function frameTakenAt(src) {
  const m = String(src).match(/(\d{4}-\d{2}-\d{2})[/\\](\d{2})(\d{2})(\d{2})\.jpg$/);
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}+09:00` : null;
}

async function writeThumb(cams, outName) {
  let src = null;
  for (const cam of cams) {
    src = latestArchiveFrame(cam);
    if (src) break;
  }
  if (!src) { console.error(`[pool-status] no frame ${cams.join('/')}`); return null; }
  const img = await Jimp.read(src);
  img.resize({ w: THUMB_W });
  await img.write(`./data/${outName}`);
  return frameTakenAt(src);
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
      let texRows = null;
      try {
        if (existsSync(SLOT_TEX_PATH)) {
          texRows = readFileSync(SLOT_TEX_PATH, 'utf8').trim().split('\n')
            .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        }
      } catch { texRows = null; }
      let fillRows = null;
      try {
        if (existsSync(FILL_PATH)) {
          fillRows = readFileSync(FILL_PATH, 'utf8').trim().split('\n')
            .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        }
      } catch { fillRows = null; }
      const status = buildPoolStatus(rows, new Date(), arrivals, holidays, texRows, fillRows);
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
    const cam1At = await writeThumb(THUMB_SOURCES['pool-cam-real01.jpg'], 'pool-cam-real01.jpg');
    const cam2At = await writeThumb(THUMB_SOURCES['pool-cam-real02.jpg'], 'pool-cam-real02.jpg');
    // 写真そのものは新カメラで最新。数値(待機車両・列移動)は区画の作り直しが済むまで
    // 旧カメラ基準で止まっているので、アプリが文言を分けられるよう別項目で持たせる。
    try {
      const sp = './data/pool-status.json';
      if (existsSync(sp)) {
        const st = JSON.parse(readFileSync(sp, 'utf8'));
        st.cameraLiveAt = cam1At || cam2At || null;
        writeFileSync(sp, JSON.stringify(st, null, 2) + '\n', 'utf8');
      }
    } catch (e) { console.error(`[pool-status] cameraLiveAt write failed: ${e.message}`); }
  } catch (e) {
    console.error(`[pool-status] failed: ${e.message}`);
  }
}
main();
