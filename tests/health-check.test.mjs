// health-check.sh のテスト。
// 「計測停止・バックアップ不全に誰も気づけない」の再発防止 (2026-08-08)。
// git-safe-sync.test.mjs と同じ流儀で bash 関数を直接叩く。
import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB = fileURLToPath(new URL('../scripts/lib/health-check.sh', import.meta.url));

function run(cwd, script, env = {}) {
  return execFileSync('bash', ['-c', `source "${LIB}"; ${script}`], {
    cwd, encoding: 'utf8',
    env: { ...process.env, HEALTH_NO_NOTIFY: '1', ...env },
  });
}

const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000);
const isoJst = (d) => d.toISOString().slice(0, 19).replace(/\.\d+$/, '') + '+09:00';

test('fill鮮度: 新しい行なら正常・古い行ならアラート', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hc-'));
  mkdirSync(join(dir, '.local'), { recursive: true });
  const hist = join(dir, 'fill.jsonl');

  // 5分前の行 → 正常 (アラートなし)
  const fresh = new Date(jstNow().getTime() - 5 * 60000);
  writeFileSync(hist, JSON.stringify({ ts: isoJst(fresh), mode: 'day', fill: { 1: 0.5 } }) + '\n');
  run(dir, `health_check_fill_freshness "${hist}"`);
  assert.equal(existsSync(join(dir, '.local/health-alert.flag')), false, '新鮮なら通知しない');

  // 90分前の行 → アラート
  const stale = new Date(jstNow().getTime() - 90 * 60000);
  writeFileSync(hist, JSON.stringify({ ts: isoJst(stale), mode: 'day', fill: { 1: 0.5 } }) + '\n');
  try { run(dir, `health_check_fill_freshness "${hist}"`); } catch { /* 戻り値1でもよい */ }
  const flag = readFileSync(join(dir, '.local/health-alert.flag'), 'utf8');
  assert.match(flag, /fill_stale/);
  assert.match(flag, /止まっている/);
});

test('バックアップ: TCC失敗痕跡と未転送件数を検出する', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hc-'));
  mkdirSync(join(dir, '.local'), { recursive: true });
  const log = join(dir, 'sync.log');
  const ts = '2026-08-08T04:15:00+0900';

  // TCC 失敗
  writeFileSync(log, `[${ts}] === sync start ===\n[${ts}]   rsync: error: /Volumes/X: open: Operation not permitted\n[${ts}] === sync end ===\n`);
  try { run(dir, `health_check_backup "${log}"`); } catch { /* */ }
  assert.match(readFileSync(join(dir, '.local/health-alert.flag'), 'utf8'), /backup_tcc/);

  // 未転送あり
  const dir2 = mkdtempSync(join(tmpdir(), 'hc-'));
  mkdirSync(join(dir2, '.local'), { recursive: true });
  const log2 = join(dir2, 'sync.log');
  writeFileSync(log2, `[${ts}] === sync start ===\n[${ts}] checked=100 deleted=0 size_mismatch=0 missing_on_ext=42\n[${ts}] === sync end ===\n`);
  try { run(dir2, `health_check_backup "${log2}"`); } catch { /* */ }
  assert.match(readFileSync(join(dir2, '.local/health-alert.flag'), 'utf8'), /42 件/);
});

test('バックアップ: 成功ログ(直近)ならアラートしない', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hc-'));
  mkdirSync(join(dir, '.local'), { recursive: true });
  const log = join(dir, 'sync.log');
  const d = jstNow();
  const ts = `${d.toISOString().slice(0, 19).replace('T', 'T')}+0900`.replace(/\.\d+/, '');
  writeFileSync(log, `[${ts}] === sync start ===\n[${ts}] checked=100 deleted=100 size_mismatch=0 missing_on_ext=0\n[${ts}] === sync end ===\n`);
  run(dir, `health_check_backup "${log}"`);
  assert.equal(existsSync(join(dir, '.local/health-alert.flag')), false);
});

test('通知抑制: 同一keyはHEALTH_RENOTIFY_MIN内で1回だけstamp更新', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hc-'));
  mkdirSync(join(dir, '.local'), { recursive: true });
  run(dir, 'health_alert testkey "一回目"', { HEALTH_NOW_EPOCH: '1000000000' });
  run(dir, 'health_alert testkey "二回目(抑制)"', { HEALTH_NOW_EPOCH: '1000000060' });
  const flag = readFileSync(join(dir, '.local/health-alert.flag'), 'utf8');
  assert.match(flag, /一回目/);
  assert.doesNotMatch(flag, /二回目/);
  // 抑制窓を超えたら再通知
  run(dir, 'health_alert testkey "三回目"', { HEALTH_NOW_EPOCH: String(1000000000 + 121 * 60) });
  assert.match(readFileSync(join(dir, '.local/health-alert.flag'), 'utf8'), /三回目/);
});
