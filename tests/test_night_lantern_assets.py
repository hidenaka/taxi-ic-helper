import sys
import os
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts', 'lib'))

# 2026-08-07 の事故: night_lantern の基準フレームが ~/taxi-image-archive の固定パスを
# 指しており、7日 retention の掃除で削除されて夜の埋まり率計測が停止した。
# 基準フレームは repo 内 data/calibration/night-bg に置き、参照がそこへ解決されること・
# 実在することをここで固定する。


class TestNightBackgroundAssets(unittest.TestCase):
    def test_background_frames_resolve_to_repo_files(self):
        import night_lantern as nl
        for source, frames in nl.BACKGROUND_FRAMES.items():
            for p in frames:
                self.assertTrue(
                    str(p).find('data/calibration/night-bg') >= 0,
                    f'{source}: {p} が repo 内の基準フレームを指していない'
                )
                self.assertTrue(p.exists(), f'{source}: {p} が存在しない')

    def test_full_empty_reference_frames_exist(self):
        import night_lantern as nl
        for p in (nl.REAL01_FULL, nl.REAL01_EMPTY, nl.REAL02_FULL, nl.REAL02_EMPTY):
            self.assertTrue(p.exists(), f'{p} が存在しない')


if __name__ == '__main__':
    unittest.main()
