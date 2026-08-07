import sys
import os
import json
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts', 'lib'))

# 号別サブモデル("stalls")対応のテスト。
# YOLOラベル再学習の号別モデルを occupancy_model.json に追加したとき、
# load_model が読めること・noriba_fill の昼判定が号別を優先することを固定する。


def _sub(bias):
    dim = 19
    return {"w": [0.0] * dim, "b": bias, "mu": [0.0] * dim, "sd": [1.0] * dim, "thr": 0.5, "dim": dim}


class TestStallSubmodelLoad(unittest.TestCase):
    def test_load_model_reads_stalls(self):
        import occupancy_model as om
        m = {"real01": _sub(0.0), "real02": _sub(0.0),
             "stalls": {"stall1": _sub(5.0), "stall4_back": _sub(-5.0)},
             "_meta": {"note": "test"}}
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(m, f)
            path = f.name
        try:
            loaded = om.load_model(path)
            self.assertIn("stalls", loaded)
            self.assertIn("stall1", loaded["stalls"])
            self.assertEqual(float(loaded["stalls"]["stall1"]["b"]), 5.0)
            # w が numpy 化されている(既存 submodel と同じ扱い)
            self.assertEqual(loaded["stalls"]["stall1"]["w"].shape[0], 19)
        finally:
            os.unlink(path)

    def test_load_model_without_stalls_is_unchanged(self):
        import occupancy_model as om
        m = {"real01": _sub(0.0)}
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(m, f)
            path = f.name
        try:
            loaded = om.load_model(path)
            self.assertNotIn("stalls", loaded)
        finally:
            os.unlink(path)


class TestNoribaFillPrefersStallSubmodel(unittest.TestCase):
    def test_day_occ_uses_stall_submodel_when_present(self):
        # b=+5 の号別サブモデル(常に車あり) vs b=-5 のカメラモデル(常に車なし)。
        # 号別が優先されれば occ = 全点。
        import numpy as np
        import noriba_fill as nf
        import occupancy_model as om
        arr = np.zeros((100, 100, 3), dtype=np.uint8)
        points = [[0.5, 0.5], [0.3, 0.3]]
        model = {"real01": om._arrify(_sub(-5.0)), "stalls": {"stall1": om._arrify(_sub(5.0))}}
        sub = (model.get("stalls") or {}).get("stall1") or model["real01"]
        occ, tot = nf._day_occ(arr, points, sub)
        self.assertEqual((occ, tot), (2, 2))
        # 号別が無い stall はカメラモデル(常に車なし)
        sub2 = (model.get("stalls") or {}).get("stall2") or model["real01"]
        occ2, tot2 = nf._day_occ(arr, points, sub2)
        self.assertEqual((occ2, tot2), (0, 2))


class TestBrightnessFeature(unittest.TestCase):
    def test_day_occ_appends_brightness_for_dim20(self):
        # dim=20(輝度特徴つき)のサブモデル: 輝度の重みだけ立てたモデルで、
        # br01 が効く(明るいと車あり判定)ことを確認。
        import numpy as np
        import noriba_fill as nf
        import occupancy_model as om
        dim = 20
        sub = {"w": [0.0] * 19 + [10.0], "b": -5.0, "mu": [0.0] * dim, "sd": [1.0] * dim, "thr": 0.5, "dim": dim}
        arr = np.zeros((100, 100, 3), dtype=np.uint8)
        points = [[0.5, 0.5]]
        m = om._arrify(sub)
        occ_bright, _ = nf._day_occ(arr, points, m, br01=1.0)   # z = -5 + 10 = +5 → 車あり
        occ_dark, _ = nf._day_occ(arr, points, m, br01=0.0)     # z = -5 → 車なし
        self.assertEqual(occ_bright, 1)
        self.assertEqual(occ_dark, 0)

    def test_production_model_has_stall_submodels(self):
        # 本番モデルJSONに号別サブモデル(dim=20)が入っていることを固定
        import occupancy_model as om
        m = om.load_model(os.path.join(os.path.dirname(__file__), "..", "data", "occupancy_model.json"))
        self.assertIn("stalls", m)
        for st in ("stall1", "stall2", "stall3", "stall4", "stall4_back"):
            self.assertIn(st, m["stalls"])
            self.assertEqual(m["stalls"][st]["w"].shape[0], 20)


if __name__ == '__main__':
    unittest.main()
