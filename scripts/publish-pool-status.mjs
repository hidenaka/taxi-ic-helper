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

// 号別の実台数 (vehicle-count-history) と列移動 (advance-count-history) で
// stalls / total / activity を実測値に置き換える。
const VEHICLE_COUNT_PATH = './data/vehicle-count-history.jsonl';
const ADVANCE_PATH = './data/advance-count-history.jsonl';
const CAPACITY_PATH = './data/noriba-capacity.json';
const STALL_KEYS = ['stall1', 'stall2', 'stall3', 'stall4'];

function readTail(pathStr, maxBytes = 262144) {
  if (!existsSync(pathStr)) return [];
  const buf = readFileSync(pathStr);
  const s = buf.length > maxBytes ? buf.subarray(buf.length - maxBytes).toString('utf8') : buf.toString('utf8');
  const lines = s.split('\n').filter(Boolean);
  if (buf.length > maxBytes) lines.shift(); // 途中で切れた行を捨てる
  return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function applyVehicleCounts(status) {
  const rows = readTail(VEHICLE_COUNT_PATH).slice(-4);   // 直近~20分
  if (!rows.length) return;
  const newest = Date.parse(rows[rows.length - 1].ts);
  if (!Number.isFinite(newest) || Date.now() - newest > 20 * 60 * 1000) return; // 計測が止まっていたら触らない
  // 直近rowsの中央値(モードごとの揺れを均す)。yolo優先・無ければlantern
  const counts = {};
  for (const k of STALL_KEYS) {
    const vs = rows.map((r) => (r.yolo ?? r.lantern)?.[k]).filter((v) => typeof v === 'number').sort((a, b) => a - b);
    if (vs.length) counts[k] = vs[Math.floor(vs.length / 2)];
  }
  if (!Object.keys(counts).length) return;
  // 容量 = 観測最大(自動で引き上げ・永続化)。fill は容量比
  let cap = {};
  try { cap = JSON.parse(readFileSync(CAPACITY_PATH, 'utf8')); } catch { cap = {}; }
  let capDirty = false;
  for (const k of STALL_KEYS) {
    if (typeof counts[k] !== 'number') continue;
    if (!(cap[k] >= counts[k])) { cap[k] = counts[k]; capDirty = true; }
  }
  if (capDirty) writeFileSync(CAPACITY_PATH, JSON.stringify(cap, null, 1) + '\n', 'utf8');
  // 列移動: 直近60分/その前60分のイベント数(1時間あたりの列移動回数=主指標)
  const adv = readTail(ADVANCE_PATH);
  const nowMs = Date.now();
  const evIn = (k, fromMin, toMin) => adv.reduce((s2, r) => {
    const t = Date.parse(r.ts);
    if (!Number.isFinite(t)) return s2;
    const age = (nowMs - t) / 60000;
    if (age < fromMin || age >= toMin) return s2;
    return s2 + (typeof r.stalls?.[k] === 'number' ? r.stalls[k] : (r.stalls?.[k]?.count ?? 0));
  }, 0);
  status.stalls = status.stalls || {};
  let total = 0;
  for (const k of STALL_KEYS) {
    if (typeof counts[k] !== 'number') continue;
    const st = status.stalls[k] || {};
    st.occ = counts[k];
    total += counts[k];
    st.fillRate = cap[k] > 0 ? Number((counts[k] / cap[k]).toFixed(4)) : null;
    delete st.typicalFillRate;              // 新カメラの「普段」は蓄積後に再導入
    delete st.sameConditionCompare;
    const dep1h = evIn(k, 0, 60);
    const depPrev = evIn(k, 60, 120);
    st.recent1hDep = dep1h;
    st.waitMin = dep1h > 0 ? Math.round((counts[k] * 60) / dep1h) : null;
    st.trend = depPrev === 0 ? (dep1h > 0 ? 'up' : 'flat') : (dep1h / depPrev >= 1.25 ? 'up' : (dep1h / depPrev < 0.75 ? 'down' : 'flat'));
    status.stalls[k] = st;
  }
  const capTotal = STALL_KEYS.reduce((s2, k) => s2 + (cap[k] || 0), 0);
  status.total = { occ: total, level: capTotal > 0 ? (total === 0 ? 'empty' : (total / capTotal < 0.35 ? '空き' : (total / capTotal < 0.65 ? '普通' : (total / capTotal < 0.9 ? '混雑' : '満車')))) : null };
  const dep1hAll = STALL_KEYS.reduce((s2, k) => s2 + evIn(k, 0, 60), 0);
  const depPrevAll = STALL_KEYS.reduce((s2, k) => s2 + evIn(k, 60, 120), 0);
  status.activity = {
    recent1hDepartures: dep1hAll,
    typical1h: null,
    ratio: null,
    level: dep1hAll >= 12 ? 'high' : (dep1hAll >= 5 ? 'mid' : 'low'),
    arrow: depPrevAll === 0 ? (dep1hAll > 0 ? 'up' : 'flat') : (dep1hAll / depPrevAll >= 1.25 ? 'up' : (dep1hAll / depPrevAll < 0.75 ? 'down' : 'flat')),
    sameConditionCompare: null,
  };
  status.countSource = rows[rows.length - 1].mode;   // yolo / lantern / both
}


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
      // ---- 実台数ベースの上書き (2026-08-21 カメラ入れ替え対応) ----------------
      // 旧カメラ凍結で slot-occupancy 系の stalls/total/activity は止まっている。
      // 新カメラの実計測で上書きする:
      //   台数 = vehicle-count-history (昼=タイルYOLO/夜=行灯光点)
      //   fill = 台数 ÷ 観測最大(容量・自動更新)。絶対数が過小でも比率は使える(本人方針)
      //   列移動 = advance-count-history (front_box 実測)。待ち目安・傾向もここから
      try {
        applyVehicleCounts(status);
      } catch (e) { console.error(`[pool-status] vehicle-count override failed: ${e.message}`); }
      // 映像の鮮度は「新カメラのアーカイブが進んでいるか」で判定(旧URL監視は凍結済みで無意味)
      try {
        const st8 = JSON.parse(readFileSync(path.join(ARCHIVE, '.new-cams-state.json'), 'utf8'));
        const at = Date.parse(st8?.real001?.at ?? '');
        const fresh = Number.isFinite(at) && (Date.now() - at) < 10 * 60 * 1000;
        status.sourceStale = !fresh;
        if (!fresh && st8?.real001?.at) status.sourceStaleSince = st8.real001.at;
        else delete status.sourceStaleSince;
      } catch { /* state無し → observe由来のフラグのまま */ }
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
