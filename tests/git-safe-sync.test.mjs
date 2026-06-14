import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB = fileURLToPath(new URL('../scripts/lib/git-safe-sync.sh', import.meta.url));

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  GIT_SAFE_SYNC_NO_NOTIFY: '1',   // テスト中はデスクトップ通知を出さない
  GIT_SAFE_SYNC_FAST: '1',        // リトライ sleep を無効化
};

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim();
}

// LIB を source して関数を実行。終了コードを投げる (失敗テスト用に status を拾える)。
function callSync(cwd, max) {
  return execFileSync('bash', ['-c', `source "${LIB}"; git_safe_sync_and_push "${cwd}" main ${max}`],
    { cwd, encoding: 'utf8', env: GIT_ENV });
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'gss-'));
  const origin = join(root, 'origin.git');
  mkdirSync(origin);
  git(origin, ['init', '--bare', '-b', 'main']);
  git(root, ['clone', '-q', origin, 'work']);
  const work = join(root, 'work');
  writeFileSync(join(work, 'pool.txt'), '0\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'base']);
  git(work, ['push', '-q', 'origin', 'main']);
  return { root, origin, work };
}

test('孤立 rebase-merge 残骸 + 分岐があっても掃除して push できる (事故の再現)', () => {
  const { root, origin, work } = setup();
  try {
    // 別クローン (= weather bot) が別ファイルを origin に commit して分岐させる
    git(root, ['clone', '-q', origin, 'bot']);
    const bot = join(root, 'bot');
    writeFileSync(join(bot, 'weather.txt'), 'sunny\n');
    git(bot, ['add', '-A']); git(bot, ['commit', '-q', '-m', 'weather']);
    git(bot, ['push', '-q', 'origin', 'main']);

    // work 側はローカル commit を積む (別ファイル = disjoint)
    writeFileSync(join(work, 'pool.txt'), '1\n');
    git(work, ['add', '-A']); git(work, ['commit', '-q', '-m', 'tick1']);

    // 孤立 rebase-merge 残骸を作る (21h フリーズの直接原因を再現)
    mkdirSync(join(work, '.git', 'rebase-merge'));

    // 前提確認: 素の pull --rebase はこの残骸で失敗する
    let plainFailed = false;
    try { git(work, ['pull', '--rebase', 'origin', 'main']); } catch { plainFailed = true; }
    assert.ok(plainFailed, '孤立残骸があれば素の pull --rebase は失敗するはず');

    // 本体: 同期 + push
    callSync(work, 5);

    // origin に tick1 と weather の両方が乗っている
    const log = git(origin, ['log', '--format=%s']);
    assert.match(log, /tick1/, 'ローカルコミットが origin に届く');
    assert.match(log, /weather/, 'リモートコミットも保持される');
    // 残骸が消えている / stuck フラグ無し
    assert.ok(!existsSync(join(work, '.git', 'rebase-merge')), '孤立残骸が除去される');
    assert.ok(!existsSync(join(work, '.local', 'push-stuck.flag')), '成功時は stuck フラグ無し');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('push できない時は stuck フラグを残して非ゼロで返す (無音にしない)', () => {
  const { root, origin, work } = setup();
  try {
    writeFileSync(join(work, 'pool.txt'), '2\n');
    git(work, ['add', '-A']); git(work, ['commit', '-q', '-m', 'tick2']);

    // origin を破壊して push を不可能にする
    rmSync(origin, { recursive: true, force: true });

    let rc = 0;
    try { callSync(work, 2); } catch (e) { rc = e.status || 1; }
    assert.notEqual(rc, 0, 'push 不能時は非ゼロで返す');
    assert.ok(existsSync(join(work, '.local', 'push-stuck.flag')), 'stuck フラグが残る');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('既に同期済み (ahead=0) なら push せず 0 で返す', () => {
  const { root, work } = setup();
  try {
    // base は push 済み。何も積まずに呼ぶ → ahead=0
    const out = execFileSync('bash',
      ['-c', `source "${LIB}"; git_safe_sync_and_push "${work}" main 3; echo "rc=$?"`],
      { cwd: work, encoding: 'utf8', env: GIT_ENV });
    assert.match(out, /rc=0/, '同期済みなら 0');
    assert.ok(!existsSync(join(work, '.local', 'push-stuck.flag')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
