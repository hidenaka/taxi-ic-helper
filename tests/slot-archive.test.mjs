import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import { archivePath } from '../scripts/lib/slot-archive.mjs';

test('archivePath: JST 日付/時刻でカメラ別ディレクトリにパスを組む', () => {
  // UTC 2026-05-19T22:45:51Z = JST 2026-05-20T07:45:51
  const now = new Date('2026-05-19T22:45:51Z');
  const p = archivePath('real01_line', now, '/var/archive');
  assert.equal(p, '/var/archive/real01_line/2026-05-20/074551.jpg');
});

test('archivePath: 別カメラ・別時刻', () => {
  const now = new Date('2026-05-20T00:00:05+09:00');  // JST 00:00:05
  const p = archivePath('real02', now, '/tmp/arch');
  assert.equal(p, '/tmp/arch/real02/2026-05-20/000005.jpg');
});

test('archivePath: 1桁時刻もゼロパディング', () => {
  const now = new Date('2026-05-20T09:08:07+09:00');
  const p = archivePath('real01_line', now, '/x');
  assert.equal(p, '/x/real01_line/2026-05-20/090807.jpg');
});
