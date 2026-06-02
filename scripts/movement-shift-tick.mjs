#!/usr/bin/env node
// movement-shift-tick — b3(列のシフト量)方式のシャドウ観測。
//
// 現行の占有/出庫パイプライン(slot-occupancy / pool-status)には一切触れず、
// 同じカメラ画像から「乗り場ごとのレーン輝度プロファイル」を作り、前 tick との
// クロス相関でシフト量(lag)とスコアを算出して data/movement-shift-history.jsonl に
// 追記するだけの並行ログ。前進方向(forwardSign)の解釈と積算は後段の分析で行う
// (生データを残し、判定基準は後から変えられるようにするため)。
//
// observe-taxi-pool.mjs が data/pool-cam-real0{1,2}.jpg を更新した直後に走らせる想定。
// 単独実行で完結し、失敗しても exit 0(本流の tick を止めない)。

import { Jimp } from 'jimp';
import { readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { profileForSlots, bestShift } from './lib/movement-shift.mjs';
import { frontBox, meanGrayInBox } from './lib/advance-counter.mjs';
import { archivePath, defaultArchiveDir } from './lib/slot-archive.mjs';

const N_FRONT = 6; // 先頭エリアとみなすスロット数(乗車ポール側)

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SLOTS_PATH = join(ROOT, 'scripts/lib/stall-slots.json');
const STATE_PATH = join(ROOT, 'data/movement-shift-state.json');
const HISTORY_PATH = join(ROOT, 'data/movement-shift-history.jsonl');
const OVERSAMPLE = 3;
const RADIUS = 1;
const MAX_LAG = 3;

function jstTimestamp(d = new Date()) {
  const z = (n) => String(n).padStart(2, '0');
  const j = new Date(d.getTime() + 9 * 3600 * 1000);
  return `${j.getUTCFullYear()}-${z(j.getUTCMonth() + 1)}-${z(j.getUTCDate())}T` +
    `${z(j.getUTCHours())}:${z(j.getUTCMinutes())}:${z(j.getUTCSeconds())}+09:00`;
}

// 30秒トラックループが保存している最新アーカイブフレームを使う(60秒ジョブでも鮮度を確保)。
// 追加のネット取得はしない。アーカイブが無ければ observe の5分スナップショットにフォールバック。
function imagePathForSource(source) {
  const camera = String(source).includes('real02') ? 'real02' : 'real01_line';
  try {
    const dir = dirname(archivePath(camera, new Date(), defaultArchiveDir()));
    const files = readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort();
    if (files.length) return join(dir, files[files.length - 1]);
  } catch { /* 当日ディレクトリ未作成など → フォールバック */ }
  return join(ROOT, camera === 'real02' ? 'data/pool-cam-real02.jpg' : 'data/pool-cam-real01.jpg');
}

async function main() {
  const cfg = JSON.parse(readFileSync(SLOTS_PATH, 'utf8'));
  const prevState = existsSync(STATE_PATH)
    ? JSON.parse(readFileSync(STATE_PATH, 'utf8'))
    : { stalls: {} };

  const imgCache = new Map();
  async function loadImage(path) {
    if (!imgCache.has(path)) imgCache.set(path, await Jimp.read(path));
    return imgCache.get(path);
  }

  const ts = jstTimestamp();
  const outStalls = {};
  const newState = { ts, stalls: {} };

  for (const [name, def] of Object.entries(cfg.stalls)) {
    if (!Array.isArray(def.slots) || def.slots.length < 3) continue;
    let profile;
    let frontDensity = null;
    try {
      const img = await loadImage(imagePathForSource(def.source));
      profile = profileForSlots(img, def.slots, { oversample: OVERSAMPLE, radius: RADIUS });
      // b5: 先頭エリア(面)の平均輝度。後段で detectAdvances により前進カウントへ。
      frontDensity = Number(meanGrayInBox(img, frontBox(def.slots, N_FRONT), 3).toFixed(2));
    } catch (e) {
      continue; // 画像欠損などはこの stall を飛ばす
    }
    newState.stalls[name] = profile;

    const prev = prevState.stalls?.[name];
    if (Array.isArray(prev) && prev.length === profile.length) {
      const { lag, score } = bestShift(prev, profile, MAX_LAG);
      outStalls[name] = { lag, score: Number(score.toFixed(3)), n: profile.length, frontDensity };
    } else {
      outStalls[name] = { lag: null, score: null, n: profile.length, frontDensity }; // 初回 or 形状変化
    }
  }

  writeFileSync(STATE_PATH, JSON.stringify(newState));
  appendFileSync(HISTORY_PATH, JSON.stringify({ schema_version: 2, ts, stalls: outStalls }) + '\n');

  const summary = Object.entries(outStalls)
    .map(([k, v]) => `${k}=${v.frontDensity ?? '-'}`)
    .join(' ');
  console.log(`[movement-shift] ${ts} ${summary}`);
}

main().catch((e) => {
  console.warn(`[movement-shift] skip: ${e.message}`);
  process.exit(0);
});
