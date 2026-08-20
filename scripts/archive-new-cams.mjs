#!/usr/bin/env node
// 羽田TPシステムの新カメラ(2026-08-20 切替)を取得して画像アーカイブへ保存する。
//
// 旧 Real01_line.jpg / Real02.jpg は 2026-08-20 11:26 / 12:25 を最後に更新が止まり、
// サイトは 1024px 系の新カメラへ移行した。ROI 再校正が済むまで既存パイプラインは
// 触らず、まず「撮り溜め」だけ先に始める(校正には昼の実フレームが要るため)。
//
// 保存先: ~/taxi-image-archive/<cam>/YYYY-MM-DD/HHMMSS.jpg
// 前回と同じ画像(sha256一致)は保存しない = 止まったカメラでディスクを食わない。

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const BASE = 'https://ttc.taxi-inf.jp/';
const ARCHIVE = process.env.TAXI_IMAGE_ARCHIVE_DIR || join(os.homedir(), 'taxi-image-archive');
const STATE = join(ARCHIVE, '.new-cams-state.json');

// 待機所・乗場ごとの新カメラ。第1待機所南側(index.php)が既存の1〜4号の観測対象。
const CAMS = [
  { name: 'real001', file: 'Real001.jpg', page: '第1待機所南側' },
  { name: 'real002', file: 'Real002.jpg', page: '第1待機所南側' },
  { name: 'real03',  file: 'Real03.jpg',  page: '第3/第4待機所' },
  { name: 'real04',  file: 'Real04.jpg',  page: '第3/第4待機所' },
  { name: 'real109', file: 'Real109.jpg', page: '第3/第4待機所' },
  { name: 'real104_line', file: 'Real104_line.jpg', page: '第4乗場' },
  { name: 'real105_line', file: 'Real105_line.jpg', page: '第4乗場' },
  { name: 'real106', file: 'Real106.jpg', page: '第5乗場' },
  { name: 'real107', file: 'Real107.jpg', page: '第5乗場' },
];

const jst = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString();
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};

async function grab(cam) {
  const res = await fetch(BASE + cam.file, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 2000) throw new Error(`too small (${buf.length}B)`);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  if (state[cam.name]?.sha === sha) return { skipped: true, sha };
  const iso = jst();
  const day = iso.slice(0, 10);
  const hms = iso.slice(11, 19).replace(/:/g, '');
  const dir = join(ARCHIVE, cam.name, day);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${hms}.jpg`), buf);
  state[cam.name] = { sha, at: iso, bytes: buf.length };
  return { skipped: false, sha, path: join(dir, `${hms}.jpg`) };
}

let saved = 0, stale = 0, failed = 0;
for (const cam of CAMS) {
  try {
    const r = await grab(cam);
    if (r.skipped) { stale += 1; } else { saved += 1; }
  } catch (e) {
    failed += 1;
    console.error(`[new-cams] ${cam.name}: ${e.message}`);
  }
}
writeFileSync(STATE, JSON.stringify(state, null, 2));
console.log(`[new-cams] ${jst().slice(0, 19)} 保存${saved} 更新なし${stale} 失敗${failed}`);
