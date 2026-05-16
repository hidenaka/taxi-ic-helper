import sys
import os
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
from track_vehicles import (
    update_tracks, stall_rois_for_camera, filter_to_rois, state_from_json, camera_state,
)


def _det(x, y):
    return {'cls': 'car', 'conf': 0.8, 'x': x, 'y': y, 'w': 0.05, 'h': 0.05}


def _trk(tid, x, y, missed=0):
    return {'id': tid, 'x': x, 'y': y, 'w': 0.05, 'h': 0.05, 'missed': missed}


SAMPLE_STALL_ROIS = {
    '_meta': {'image_size': [800, 600]},
    'stalls': {
        'stall1': {'source': 'real01_line', 'roi': {'x': 600, 'y': 80, 'width': 200, 'height': 170}},
        'stall2': {'source': 'real01_line', 'roi': {'x': 600, 'y': 250, 'width': 200, 'height': 150}},
        'stall4': {'source': 'real02', 'roi': {'x': 400, 'y': 0, 'width': 400, 'height': 250}},
    },
}


class TestStallRoisForCamera(unittest.TestCase):
    def test_filters_by_source_and_normalizes(self):
        rois = stall_rois_for_camera(SAMPLE_STALL_ROIS, 'real01_line')
        self.assertEqual(len(rois), 2)  # stall1, stall2 のみ (stall4 は real02)
        self.assertAlmostEqual(rois[0]['x'], 600 / 800)
        self.assertAlmostEqual(rois[0]['y'], 80 / 600)
        self.assertAlmostEqual(rois[0]['w'], 200 / 800)
        self.assertAlmostEqual(rois[0]['h'], 170 / 600)

    def test_case_insensitive(self):
        rois = stall_rois_for_camera(SAMPLE_STALL_ROIS, 'Real01_line')
        self.assertEqual(len(rois), 2)

    def test_no_match_returns_empty(self):
        self.assertEqual(stall_rois_for_camera(SAMPLE_STALL_ROIS, 'real99'), [])


class TestFilterToRois(unittest.TestCase):
    def test_keeps_detection_inside_roi(self):
        rois = [{'x': 0.75, 'y': 0.1, 'w': 0.25, 'h': 0.3}]
        dets = [_det(0.8, 0.2)]
        self.assertEqual(filter_to_rois(dets, rois), dets)

    def test_drops_detection_outside_roi(self):
        rois = [{'x': 0.75, 'y': 0.1, 'w': 0.25, 'h': 0.3}]
        self.assertEqual(filter_to_rois([_det(0.1, 0.2)], rois), [])

    def test_union_of_multiple_rois(self):
        rois = [
            {'x': 0.0, 'y': 0.0, 'w': 0.1, 'h': 0.1},
            {'x': 0.75, 'y': 0.1, 'w': 0.25, 'h': 0.3},
        ]
        d = _det(0.8, 0.2)  # 2 つ目の ROI 内
        self.assertEqual(filter_to_rois([d], rois), [d])

    def test_empty_rois_returns_empty(self):
        self.assertEqual(filter_to_rois([_det(0.8, 0.2)], []), [])

    def test_roi_boundary_half_open(self):
        # w=0.2 → rx+rw=0.4 (0.2+0.2 は浮動小数点でも厳密に 0.4)
        rois = [{'x': 0.2, 'y': 0.2, 'w': 0.2, 'h': 0.2}]
        # x == rx (0.2) は含む、x == rx+rw (0.4) は除外
        self.assertEqual(len(filter_to_rois([_det(0.2, 0.25)], rois)), 1)
        self.assertEqual(len(filter_to_rois([_det(0.4, 0.25)], rois)), 0)


class TestUpdateTracks(unittest.TestCase):
    def test_match_same_position(self):
        r = update_tracks([_trk(1, 0.5, 0.3)], [_det(0.5, 0.3)], 2, 2, 0.06)
        self.assertEqual(len(r['tracks']), 1)
        self.assertEqual(r['tracks'][0]['id'], 1)
        self.assertEqual(r['tracks'][0]['missed'], 0)
        self.assertEqual(r['arrived'], 0)
        self.assertEqual(r['departed'], 0)

    def test_new_detection_new_track(self):
        r = update_tracks([], [_det(0.2, 0.2)], 5, 2, 0.06)
        self.assertEqual(len(r['tracks']), 1)
        self.assertEqual(r['tracks'][0]['id'], 5)
        self.assertEqual(r['next_id'], 6)
        self.assertEqual(r['arrived'], 1)

    def test_unmatched_track_missed_increments(self):
        r = update_tracks([_trk(1, 0.5, 0.3, missed=0)], [], 2, 2, 0.06)
        self.assertEqual(len(r['tracks']), 1)
        self.assertEqual(r['tracks'][0]['missed'], 1)
        self.assertEqual(r['departed'], 0)

    def test_track_departs_after_max_missed(self):
        # missed=2、未マッチで 3 になり max_missed=2 超 → departed
        r = update_tracks([_trk(1, 0.5, 0.3, missed=2)], [], 2, 2, 0.06)
        self.assertEqual(len(r['tracks']), 0)
        self.assertEqual(r['departed'], 1)

    def test_far_detection_not_matched(self):
        # track (0.5,0.3) と detection (0.9,0.9) は距離 > 0.06 → 別物扱い
        r = update_tracks([_trk(1, 0.5, 0.3)], [_det(0.9, 0.9)], 2, 2, 0.06)
        ids = sorted(t['id'] for t in r['tracks'])
        self.assertEqual(ids, [1, 2])  # track 1 は missed で残り、det は新 track 2
        self.assertEqual(r['arrived'], 1)

    def test_no_detections_all_increment(self):
        r = update_tracks([_trk(1, 0.1, 0.1), _trk(2, 0.9, 0.9)], [], 3, 2, 0.06)
        self.assertEqual(len(r['tracks']), 2)
        self.assertTrue(all(t['missed'] == 1 for t in r['tracks']))


class TestStateFromJson(unittest.TestCase):
    def test_schema_match_returns_cameras(self):
        cams = {'real01_line': {'tracks': [_trk(1, 0.5, 0.3)], 'next_id': 7}}
        s = {'schema': 3, 'cameras': cams}
        self.assertEqual(state_from_json(s), cams)

    def test_old_v2_schema_resets(self):
        # 旧 v2 形式 (schema 2、cameras 無し) → {}
        s = {'schema': 2, 'tracks': [_trk(1, 0.5, 0.3)], 'next_id': 7}
        self.assertEqual(state_from_json(s), {})

    def test_missing_schema_resets(self):
        s = {'cameras': {'real01_line': {'tracks': [], 'next_id': 1}}}
        self.assertEqual(state_from_json(s), {})

    def test_non_dict_resets(self):
        self.assertEqual(state_from_json([]), {})
        self.assertEqual(state_from_json('x'), {})

    def test_cameras_not_dict_resets(self):
        s = {'schema': 3, 'cameras': 'oops'}
        self.assertEqual(state_from_json(s), {})


class TestCameraState(unittest.TestCase):
    def test_extracts_camera_state(self):
        cams = {'real01_line': {'tracks': [_trk(1, 0.5, 0.3)], 'next_id': 7}}
        tracks, next_id = camera_state(cams, 'real01_line')
        self.assertEqual(len(tracks), 1)
        self.assertEqual(tracks[0]['id'], 1)
        self.assertEqual(next_id, 7)

    def test_missing_camera_resets(self):
        cams = {'real01_line': {'tracks': [], 'next_id': 3}}
        self.assertEqual(camera_state(cams, 'real02'), ([], 1))

    def test_non_dict_cameras_resets(self):
        self.assertEqual(camera_state({}, 'real01_line'), ([], 1))
        self.assertEqual(camera_state('x', 'real01_line'), ([], 1))

    def test_malformed_camera_resets(self):
        # tracks が list でない / next_id が int でない / camera 値が dict でない
        self.assertEqual(camera_state({'c': {'tracks': 'x', 'next_id': 1}}, 'c'), ([], 1))
        self.assertEqual(camera_state({'c': {'tracks': [], 'next_id': 'x'}}, 'c'), ([], 1))
        self.assertEqual(camera_state({'c': 5}, 'c'), ([], 1))


if __name__ == '__main__':
    unittest.main()
