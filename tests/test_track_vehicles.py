import sys
import os
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
from track_vehicles import update_tracks


def _det(x, y):
    return {'cls': 'car', 'conf': 0.8, 'x': x, 'y': y, 'w': 0.05, 'h': 0.05}


def _trk(tid, x, y, missed=0):
    return {'id': tid, 'x': x, 'y': y, 'w': 0.05, 'h': 0.05, 'missed': missed}


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


if __name__ == '__main__':
    unittest.main()
