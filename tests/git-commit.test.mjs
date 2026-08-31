// scripts/git-commit.sh と git_with_lock のテスト。
//
// 守りたいこと (2026-08-31 の実害): observe-tick が数分ごとに
// `git pull --rebase --autostash` を回すため、手作業の add と commit の間に
// 割り込まれるとステージが巻き取られて変更が消える。
//   1. add と commit が 1 プロセスで完結すること
//   2. tick と同じロックを取り、同時に git を触らないこと
import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB = fileURLToPath(new URL('../scripts/lib/git-safe-sync.sh', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../scripts/git-commit.sh', import.meta.url));

function sh(script, { cwd, env = {} } = {}) {
  return spawnSync('bash', ['-c', `source "${LIB}"; ${script}`], {
    cwd, encoding: 'utf8',
    env: { ...process.env, GIT_SAFE_SYNC_NO_NOTIFY: '1', ...env },
  });
}

// --- git_with_lock ---

test('git_with_lock: 空いていればコマンドを実行する', () => {
  const lock = join(mkdtempSync(join(tmpdir(), 'gl-')), 'a.lock');
  const r = sh('git_with_lock echo ran', { env: { GIT_LOCK_FILE: lock } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /ran/);
});

test('git_with_lock: 実行後はロックを解放する', () => {
  const lock = join(mkdtempSync(join(tmpdir(), 'gl-')), 'b.lock');
  sh('git_with_lock true', { env: { GIT_LOCK_FILE: lock } });
  assert.equal(existsSync(lock), false, '解放されていない');
});

test('git_with_lock: 生きているプロセスが握っていたら待って諦める(75)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gl-'));
  const lock = join(dir, 'c.lock');
  // 自分自身(このテストプロセス)のPIDでロックを作る = 生きているので破棄されない
  writeFileSync(lock, String(process.pid).padStart(10) + '\n');
  const r = sh('git_with_lock echo should-not-run', {
    env: { GIT_LOCK_FILE: lock, GIT_LOCK_WAIT_SEC: '2', GIT_LOCK_POLL_SEC: '1' },
  });
  assert.equal(r.status, 75, '取れなかったら75を返す');
  assert.doesNotMatch(r.stdout, /should-not-run/, 'コマンドを実行してはいけない');
});

test('git_with_lock: 死んだプロセスのロックは自動で破棄される', () => {
  const lock = join(mkdtempSync(join(tmpdir(), 'gl-')), 'd.lock');
  writeFileSync(lock, '     99998\n');   // 存在しないPID
  const r = sh('git_with_lock echo ran', {
    env: { GIT_LOCK_FILE: lock, GIT_LOCK_WAIT_SEC: '2', GIT_LOCK_POLL_SEC: '1' },
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /ran/);
});

test('git_with_lock: コマンドの終了コードをそのまま返す', () => {
  const lock = join(mkdtempSync(join(tmpdir(), 'gl-')), 'e.lock');
  const r = sh('git_with_lock bash -c "exit 42"', { env: { GIT_LOCK_FILE: lock } });
  assert.equal(r.status, 42);
});

// --- git-commit.sh ---

function newRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'gc-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'test');
  writeFileSync(join(dir, 'seed.txt'), 'seed\n');
  g('add', 'seed.txt');
  g('commit', '-q', '-m', 'seed');
  return { dir, g };
}

function runScript(args, { cwd, env = {} }) {
  return spawnSync('bash', [SCRIPT, ...args], {
    cwd, encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('git-commit.sh: 指定したパスだけを1プロセスで add してコミットする', () => {
  const { dir, g } = newRepo();
  writeFileSync(join(dir, 'want.txt'), 'a\n');
  writeFileSync(join(dir, 'other.txt'), 'b\n');
  const lock = join(dir, 'g.lock');
  const r = runScript(['-m', 'add want only', 'want.txt'], {
    cwd: dir, env: { GIT_LOCK_FILE: lock, GIT_COMMIT_REPO: dir },
  });
  assert.equal(r.status, 0, r.stderr);
  const files = g('show', '--name-only', '--format=', 'HEAD');
  assert.match(files, /want\.txt/);
  assert.doesNotMatch(files, /other\.txt/, '指定していないファイルを巻き込まない');
});

test('git-commit.sh: 変更が無ければコミットせず3を返し、ステージも残さない', () => {
  const { dir, g } = newRepo();
  const lock = join(dir, 'g.lock');
  const r = runScript(['-m', 'nothing', 'seed.txt'], {
    cwd: dir, env: { GIT_LOCK_FILE: lock },
  });
  assert.equal(r.status, 3);
  assert.equal(g('diff', '--cached', '--name-only').trim(), '', 'ステージを残してはいけない');
});

test('git-commit.sh: --dry-run はコミットせずステージも残さない', () => {
  const { dir, g } = newRepo();
  writeFileSync(join(dir, 'x.txt'), 'x\n');
  const before = g('rev-parse', 'HEAD').trim();
  const r = runScript(['--dry-run', '-m', 'preview', 'x.txt'], {
    cwd: dir, env: { GIT_LOCK_FILE: join(dir, 'g.lock') },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(g('rev-parse', 'HEAD').trim(), before, 'コミットしてはいけない');
  assert.equal(g('diff', '--cached', '--name-only').trim(), '', 'ステージを残してはいけない');
});

test('git-commit.sh: メッセージが無ければ実行しない', () => {
  const { dir } = newRepo();
  const r = runScript(['x.txt'], { cwd: dir, env: { GIT_LOCK_FILE: join(dir, 'g.lock') } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /メッセージ/);
});

test('git-commit.sh: tick が git を使用中なら何もせず75で戻る', () => {
  const { dir, g } = newRepo();
  writeFileSync(join(dir, 'y.txt'), 'y\n');
  const lock = join(dir, 'busy.lock');
  writeFileSync(lock, String(process.pid).padStart(10) + '\n');   // 生きているPIDが保持
  const before = g('rev-parse', 'HEAD').trim();
  const r = runScript(['-m', 'blocked', 'y.txt'], {
    cwd: dir,
    env: { GIT_LOCK_FILE: lock, GIT_LOCK_WAIT_SEC: '2', GIT_LOCK_POLL_SEC: '1' },
  });
  assert.equal(r.status, 75);
  assert.equal(g('rev-parse', 'HEAD').trim(), before);
  assert.equal(g('diff', '--cached', '--name-only').trim(), '', 'ステージも触らない');
  rmSync(lock, { force: true });
});
