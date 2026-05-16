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


# --- Phase F-2: T1/T2 stall 別カウント ---

from detect_vehicles import count_boxes_per_stall, build_t1t2_stalls


def _box(x, y):
    return {'cls': 'car', 'conf': 0.8, 'x': x, 'y': y, 'w': 0.05, 'h': 0.05}


STALL_ROIS_FIXTURE = {
    '_meta': {'image_size': [800, 600]},
    'stalls': {
        # stall1 正規化: x∈[0.75,1.0) y∈[0.1333,0.4167)
        'stall1': {'source': 'real01_line', 'roi': {'x': 600, 'y': 80, 'width': 200, 'height': 170}},
        # stall4 正規化: x∈[0.5,1.0) y∈[0.0,0.4167)
        'stall4': {'source': 'real02', 'roi': {'x': 400, 'y': 0, 'width': 400, 'height': 250}},
    },
}


class TestCountBoxesPerStall(unittest.TestCase):
    def test_box_inside_roi_counted(self):
        bbi = {'Real01_line': [_box(0.8, 0.2)], 'Real02': []}
        r = count_boxes_per_stall(bbi, STALL_ROIS_FIXTURE)
        self.assertEqual(r['stall1'], 1)
        self.assertEqual(r['stall4'], 0)

    def test_box_outside_roi_not_counted(self):
        bbi = {'Real01_line': [_box(0.1, 0.2)], 'Real02': []}
        r = count_boxes_per_stall(bbi, STALL_ROIS_FIXTURE)
        self.assertEqual(r['stall1'], 0)

    def test_source_isolation(self):
        # Real02 の box は stall1 (source real01_line) に入らない / stall4 (source real02) に入る
        bbi = {'Real01_line': [], 'Real02': [_box(0.8, 0.2)]}
        r = count_boxes_per_stall(bbi, STALL_ROIS_FIXTURE)
        self.assertEqual(r['stall1'], 0)
        self.assertEqual(r['stall4'], 1)

    def test_no_boxes(self):
        r = count_boxes_per_stall({'Real01_line': [], 'Real02': []}, STALL_ROIS_FIXTURE)
        self.assertEqual(r, {'stall1': 0, 'stall4': 0})

    def test_multiple_boxes(self):
        bbi = {'Real01_line': [_box(0.8, 0.2), _box(0.9, 0.3), _box(0.1, 0.1)], 'Real02': []}
        r = count_boxes_per_stall(bbi, STALL_ROIS_FIXTURE)
        self.assertEqual(r['stall1'], 2)  # 2 個が ROI 内、1 個が外


class TestBuildT1t2Stalls(unittest.TestCase):
    def test_diff_from_prev(self):
        counts = {'stall1': 5, 'stall2': 3}
        prev = {'stall1': {'count': 7}, 'stall2': {'count': 3}}
        r = build_t1t2_stalls(counts, prev)
        self.assertEqual(r['stall1'], {'count': 5, 'diff_from_prev': -2})
        self.assertEqual(r['stall2'], {'count': 3, 'diff_from_prev': 0})

    def test_no_prev(self):
        r = build_t1t2_stalls({'stall1': 5}, None)
        self.assertEqual(r['stall1'], {'count': 5, 'diff_from_prev': None})


if __name__ == '__main__':
    unittest.main()
