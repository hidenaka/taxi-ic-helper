import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { isSourceStale } from '../scripts/lib/image-pool-analyzer.mjs';

// 元ページ(ttc.taxi-inf.jp)の画像が更新されていない(右下タイムスタンプが進まない)場合の
// stale 判定。両カメラの sha256 が前 tick と同一なら stale = 計測スキップ。

test('両カメラとも前tickと同一sha256 → stale (true)', () => {
  assert.equal(isSourceStale('aaa', 'bbb', 'aaa', 'bbb'), true);
});

test('Real01だけ変化(新フレーム) → 非stale (false)', () => {
  assert.equal(isSourceStale('aaa', 'bbb', 'XXX', 'bbb'), false);
});

test('Real02だけ変化 → 非stale (false)', () => {
  assert.equal(isSourceStale('aaa', 'bbb', 'aaa', 'YYY'), false);
});

test('両方とも新フレーム → 非stale (false)', () => {
  assert.equal(isSourceStale('aaa', 'bbb', 'XXX', 'YYY'), false);
});

test('初回tick(前sha無し) → stale扱いしない (false)', () => {
  assert.equal(isSourceStale(null, null, 'aaa', 'bbb'), false);
  assert.equal(isSourceStale(undefined, undefined, 'aaa', 'bbb'), false);
});

test('片方の前shaのみ欠損 → stale扱いしない (false)', () => {
  assert.equal(isSourceStale('aaa', null, 'aaa', 'bbb'), false);
});
