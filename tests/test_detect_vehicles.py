import sys
import os
import unittest
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
from detect_vehicles import iou, nms, decode_yolo_output


class TestIou(unittest.TestCase):
    def test_no_overlap(self):
        self.assertEqual(iou((0, 0, 10, 10), (20, 20, 30, 30)), 0.0)

    def test_identical(self):
        self.assertEqual(iou((0, 0, 10, 10), (0, 0, 10, 10)), 1.0)

    def test_half_overlap(self):
        # a=(0,0,10,10) area100, b=(5,0,15,10) area100, inter=5*10=50, union=150
        self.assertAlmostEqual(iou((0, 0, 10, 10), (5, 0, 15, 10)), 50 / 150)


class TestNms(unittest.TestCase):
    def test_suppresses_overlap(self):
        dets = [(0, 0, 10, 10, 0.9, 2), (1, 1, 11, 11, 0.8, 2)]  # 高 IoU
        kept = nms(dets, 0.45)
        self.assertEqual(len(kept), 1)
        self.assertEqual(kept[0][4], 0.9)  # 高 conf が残る

    def test_keeps_distinct(self):
        dets = [(0, 0, 10, 10, 0.9, 2), (50, 50, 60, 60, 0.8, 2)]
        kept = nms(dets, 0.45)
        self.assertEqual(len(kept), 2)


class TestDecode(unittest.TestCase):
    def test_threshold_filters(self):
        # output [1,84,2]: anchor0 はクラス2 を 0.9、anchor1 は 0.1 (しきい値未満)
        out = np.zeros((1, 84, 2), dtype=np.float32)
        out[0, 0:4, 0] = [100, 100, 20, 20]
        out[0, 4 + 2, 0] = 0.9
        out[0, 0:4, 1] = [200, 200, 20, 20]
        out[0, 4 + 2, 1] = 0.1
        dets = decode_yolo_output(out, 0.30)
        self.assertEqual(len(dets), 1)
        self.assertEqual(dets[0][5], 2)  # cls_id
        self.assertAlmostEqual(dets[0][4], 0.9, places=5)  # conf
        self.assertEqual(dets[0][0], 100.0)  # cx


if __name__ == '__main__':
    unittest.main()
