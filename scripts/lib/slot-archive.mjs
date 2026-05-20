// カメラ生画像をローカルアーカイブに保存するための補助。
// archivePath は純関数（テスト用）。saveArchive は I/O 付き。
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/**
 * JST 基準で <archiveDir>/<camera>/YYYY-MM-DD/HHMMSS.jpg のパスを組む純関数。
 * @param {string} camera 例 'real01_line'
 * @param {Date} now 現在時刻（UTC 任意。JST へ変換）
 * @param {string} archiveDir アーカイブのルート
 * @returns {string}
 */
export function archivePath(camera, now, archiveDir) {
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  const yyyy = jst.getUTCFullYear();
  const mm = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(jst.getUTCDate()).padStart(2, '0');
  const hh = String(jst.getUTCHours()).padStart(2, '0');
  const mi = String(jst.getUTCMinutes()).padStart(2, '0');
  const ss = String(jst.getUTCSeconds()).padStart(2, '0');
  return path.join(archiveDir, camera, `${yyyy}-${mm}-${dd}`, `${hh}${mi}${ss}.jpg`);
}

/** 既定のアーカイブルート。環境変数 TAXI_IMAGE_ARCHIVE_DIR があればそれ、無ければ ~/taxi-image-archive */
export function defaultArchiveDir() {
  return process.env.TAXI_IMAGE_ARCHIVE_DIR || path.join(os.homedir(), 'taxi-image-archive');
}

/**
 * 生 jpg buffer をアーカイブに書き出す。失敗は warn だけで例外を投げない。
 * @param {string} camera 'real01_line' 等
 * @param {Buffer} buf 生 jpg バイト列
 * @param {Date} now
 * @param {string} [archiveDir] 省略時は defaultArchiveDir()
 */
export async function saveArchive(camera, buf, now, archiveDir = defaultArchiveDir()) {
  try {
    const p = archivePath(camera, now, archiveDir);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, buf);
  } catch (e) {
    console.warn(`[slot] archive write failed: ${e.message}`);
  }
}
