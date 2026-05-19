# 乗り場ROIの台形補正（ホモグラフィ）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 乗り場別出庫計測のROI判定を、ホモグラフィ（台形補正）で真上視点座標へ変換してから行うようにし、斜め撮影による透視ゆがみでROIが実車位置とズレる問題を解消する。

**Architecture:** カメラごとに「地面の基準4点→真上視点」のホモグラフィを持たせる。検出車の接地点（bbox下端中央）をホモグラフィで真上座標へ変換し、真上座標系の長方形ROIで乗り場を判定する。画像自体は変形しない（検出は元画像のまま）。`stall-rois.json` をスキーマv2（カメラ別ホモグラフィ＋真上視点ROI）に変える。

**Tech Stack:** Python（`unittest`、OpenCV `cv2`・`numpy` は環境導入済み）。

設計書: `docs/superpowers/specs/2026-05-19-stall-roi-perspective-correction-design.md`

---

## 前提知識

- **リポジトリ**: taxi-ic-helper（`乗務地図関係/`）。**実装は git worktree で行う**（ライブ観測が走る `乗務地図関係/` 本体を壊さないため）。最終Task でコード＋校正データを揃えて1回で `origin/main` に push する。
- commit メッセージ末尾に `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`。commit 前に `git diff --cached --name-only` で観測データ混入なしを確認。
- **`scripts/track_vehicles.py`** の現状（全ステップで前提）:
  - 純関数 `stall_rois_for_camera(json, camera)` → 旧v1の正規化矩形 list。**本計画で削除**。
  - `filter_to_rois(detections, rois)` → ROI内の検出のみ返す。**本計画で署名変更**。
  - `stall_of_point(x, y, rois)` → 点を含むROIの stall 名。**本計画で署名変更**。
  - `update_tracks(prev, dets, next_id, max_missed, dist)` → `{tracks,next_id,arrived,departedTracks,matched_dists}`。**変更なし**。
  - `main()` の per-camera ループ（`for image_name, camera_key in TRACK_CAMERAS:`）が `stall_rois_for_camera`→`filter_to_rois`→`update_tracks`→`stall_of_point` で `row_cameras[camera]['departedByStall']` を作り schema v4 行を出力。
  - 検出 `detect_image` の戻りは `[{cls,conf,x,y,w,h}, ...]`（x,y は中心、w,h は箱サイズ、すべて0-1正規化）。
- **`tests/test_track_vehicles.py`**: ヘルパ `_det(x,y)`（`{cls,conf,x,y,w:0.05,h:0.05}`）・`_trk(tid,x,y,missed=0)`。stall関連テストクラス `TestStallRoisForCamera`・`TestFilterToRois`・`TestStallOfPoint`・`TestStallRoisHaveStallName` と `SAMPLE_STALL_ROIS`（v1）。`update_tracks`/`state` 系テストは stall 無関係。
- **新スキーマ v2**（設計書§1）: `cameras.<camera>` に `image_size`・`reference_points`（元画像ピクセル4点）・`rectified_size`・`rectified_corners`。`stalls.<name>` に `source`・`rect`（真上視点座標の `{x,y,width,height}`）。
- ホモグラフィの入力は**正規化済み元画像座標**（0-1）。`reference_points` は `image_size` で割って正規化してから変換を作る。

## ファイル構成

| ファイル | 変更 |
|---|---|
| `scripts/track_vehicles.py` | `to_rectified`/`build_homography`/`camera_calibration`/`to_ground_point` 追加、`stall_of_point`/`filter_to_rois` 署名変更、`stall_rois_for_camera` 削除、`main()` 配線 |
| `tests/test_track_vehicles.py` | homography/v2 テスト追加、旧 stall テストクラス置換、import 行更新 |
| `scripts/calibrate-perspective.py` | 新規。校正支援スクリプト |
| `scripts/lib/stall-rois.json` | v1 → v2（Task 5 校正で確定） |

---

## Task 1: ホモグラフィの中核 — to_rectified・build_homography

**作業ディレクトリ:** taxi-ic-helper worktree

**Files:**
- Modify: `scripts/track_vehicles.py`
- Test: `tests/test_track_vehicles.py`

- [ ] **Step 1: 失敗するテストを書く**

`tests/test_track_vehicles.py` の import 行に `to_rectified, build_homography` を追加する:
```python
from track_vehicles import (
    update_tracks, stall_rois_for_camera, stall_of_point, filter_to_rois, state_from_json, camera_state,
    to_rectified, build_homography,
)
```

ファイル末尾（`if __name__` の直前）に追加:
```python
class TestHomography(unittest.TestCase):
    def test_to_rectified_identity_scale(self):
        # 画像全体の四隅 → 1000x1000 真上視点。透視なしの純スケール。
        h = build_homography([[0, 0], [800, 0], [800, 600], [0, 600]],
                             [[0, 0], [1000, 0], [1000, 1000], [0, 1000]], [800, 600])
        rx, ry = to_rectified(0.8, 0.2, h)
        self.assertAlmostEqual(rx, 800.0, places=2)
        self.assertAlmostEqual(ry, 200.0, places=2)

    def test_to_rectified_trapezoid_corners_roundtrip(self):
        # 台形の基準点（斜め撮影を模擬）→ 真上視点の四隅へ写ることを確認。
        ref = [[200, 0], [600, 0], [800, 600], [0, 600]]
        corners = [[0, 0], [1000, 0], [1000, 1000], [0, 1000]]
        h = build_homography(ref, corners, [800, 600])
        for (px, py), (cx, cy) in zip(ref, corners):
            rx, ry = to_rectified(px / 800, py / 600, h)
            self.assertAlmostEqual(rx, cx, places=2)
            self.assertAlmostEqual(ry, cy, places=2)

    def test_to_rectified_trapezoid_top_midpoint(self):
        # 台形上辺の中点（正規化 x=0.5,y=0）は真上視点で上辺中央へ。
        ref = [[200, 0], [600, 0], [800, 600], [0, 600]]
        corners = [[0, 0], [1000, 0], [1000, 1000], [0, 1000]]
        h = build_homography(ref, corners, [800, 600])
        rx, ry = to_rectified(0.5, 0.0, h)
        self.assertAlmostEqual(rx, 500.0, places=2)
        self.assertAlmostEqual(ry, 0.0, places=2)
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `python3 -m unittest tests.test_track_vehicles -v 2>&1 | tail -20`
Expected: FAIL — `cannot import name 'to_rectified'` / `'build_homography'`。

- [ ] **Step 3: 実装**

`scripts/track_vehicles.py` の `stall_rois_for_camera` 定義の直前に追加:
```python
def to_rectified(x, y, h_matrix):
    """正規化元画像座標の点 (x,y) をホモグラフィ h_matrix で真上視点座標へ変換する純関数。

    h_matrix: 3x3 のネスト list（行優先）。
    戻り値: (rx, ry) のタプル。射影が退化（分母≈0）した場合は (nan, nan)。
    """
    m = h_matrix
    wx = m[0][0] * x + m[0][1] * y + m[0][2]
    wy = m[1][0] * x + m[1][1] * y + m[1][2]
    w = m[2][0] * x + m[2][1] * y + m[2][2]
    if abs(w) < 1e-12:
        return (float('nan'), float('nan'))
    return (wx / w, wy / w)


def build_homography(reference_points, rectified_corners, image_size):
    """基準4点（元画像ピクセル座標）→ 真上視点4隅 のホモグラフィ 3x3 を返す。

    reference_points は image_size で正規化してから変換を作る
    （実行時に渡す点が正規化座標のため）。
    reference_points / rectified_corners: それぞれ [[x,y], ...] の4点。順序は対応。
    戻り値: 3x3 の list of list（float）。
    """
    import numpy as np
    import cv2
    iw, ih = image_size[0], image_size[1]
    src = np.array([[p[0] / iw, p[1] / ih] for p in reference_points], dtype=np.float32)
    dst = np.array([[c[0], c[1]] for c in rectified_corners], dtype=np.float32)
    return cv2.getPerspectiveTransform(src, dst).tolist()
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `python3 -m unittest tests.test_track_vehicles -v 2>&1 | tail -20`
Expected: PASS — `TestHomography` 3件を含め全件パス（旧テストは未変更で影響なし）。

- [ ] **Step 5: コミット**

```bash
git add scripts/track_vehicles.py tests/test_track_vehicles.py
git diff --cached --name-only
git commit -m "$(cat <<'EOF'
feat(track): ホモグラフィ中核 to_rectified・build_homography 追加

正規化元画像座標の点を真上視点座標へ写す純関数 to_rectified と、
基準4点から 3x3 ホモグラフィを構築する build_homography を追加。
乗り場ROIの台形補正の土台。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: v2スキーマ読込とROI判定 — camera_calibration・to_ground_point・新 stall_of_point/filter_to_rois

**作業ディレクトリ:** taxi-ic-helper worktree

**Files:**
- Modify: `scripts/track_vehicles.py`
- Test: `tests/test_track_vehicles.py`

このタスクは乗り場ROI処理の中核入れ替え。旧 `stall_rois_for_camera` と旧署名の
`stall_of_point`/`filter_to_rois` を廃し、ホモグラフィベースに統一する。

- [ ] **Step 1: テストを更新する（失敗させる）**

`tests/test_track_vehicles.py`:

(a) import 行から `stall_rois_for_camera` を削除し、`camera_calibration, to_ground_point` を追加:
```python
from track_vehicles import (
    update_tracks, stall_of_point, filter_to_rois, state_from_json, camera_state,
    to_rectified, build_homography, camera_calibration, to_ground_point,
)
```

(b) `SAMPLE_STALL_ROIS`（v1）の定義全体を、v2 サンプルに置き換える:
```python
SAMPLE_STALL_ROIS = {
    '_meta': {},
    'schema_version': 2,
    'cameras': {
        'real01_line': {
            'image_size': [800, 600],
            'reference_points': [[0, 0], [800, 0], [800, 600], [0, 600]],
            'rectified_size': [1000, 1000],
            'rectified_corners': [[0, 0], [1000, 0], [1000, 1000], [0, 1000]],
        },
        'real02': {
            'image_size': [800, 600],
            'reference_points': [[0, 0], [800, 0], [800, 600], [0, 600]],
            'rectified_size': [1000, 1000],
            'rectified_corners': [[0, 0], [1000, 0], [1000, 1000], [0, 1000]],
        },
    },
    'stalls': {
        'stall1': {'source': 'real01_line', 'rect': {'x': 0, 'y': 0, 'width': 1000, 'height': 300}},
        'stall2': {'source': 'real01_line', 'rect': {'x': 0, 'y': 300, 'width': 1000, 'height': 300}},
        'stall4': {'source': 'real02', 'rect': {'x': 0, 'y': 0, 'width': 1000, 'height': 1000}},
    },
}
```
（real01_line の基準点が画像全体の四隅なので、ホモグラフィは正規化座標 [0,1]² →
[0,1000]² の純スケール。`to_rectified(0.8,0.2)` = (800,200)。stall1=真上y0-300、
stall2=真上y300-600。）

(c) 旧テストクラス `TestStallRoisForCamera`・`TestFilterToRois`・`TestStallOfPoint`・
`TestStallRoisHaveStallName` の**4クラスを丸ごと削除**し、以下に置き換える:
```python
class TestCameraCalibration(unittest.TestCase):
    def test_returns_homography_and_stalls(self):
        calib = camera_calibration(SAMPLE_STALL_ROIS, 'real01_line')
        self.assertIsNotNone(calib)
        self.assertEqual(len(calib['h_matrix']), 3)
        names = {s['stall'] for s in calib['stalls']}
        self.assertEqual(names, {'stall1', 'stall2'})  # real02 の stall4 は除外

    def test_unknown_camera_returns_none(self):
        self.assertIsNone(camera_calibration(SAMPLE_STALL_ROIS, 'real99'))

    def test_stall_rect_carried(self):
        calib = camera_calibration(SAMPLE_STALL_ROIS, 'real01_line')
        s1 = next(s for s in calib['stalls'] if s['stall'] == 'stall1')
        self.assertEqual(s1['rect'], {'x': 0, 'y': 0, 'w': 1000, 'h': 300})


class TestToGroundPoint(unittest.TestCase):
    def test_y_moves_to_bottom_center(self):
        g = to_ground_point({'x': 0.5, 'y': 0.40, 'w': 0.06, 'h': 0.10})
        self.assertAlmostEqual(g['x'], 0.5)
        self.assertAlmostEqual(g['y'], 0.45)  # 0.40 + 0.10/2

    def test_does_not_mutate_input(self):
        d = {'x': 0.5, 'y': 0.40, 'w': 0.06, 'h': 0.10}
        to_ground_point(d)
        self.assertEqual(d['y'], 0.40)


class TestStallOfPoint(unittest.TestCase):
    def test_point_inside_rect_returns_stall(self):
        calib = camera_calibration(SAMPLE_STALL_ROIS, 'real01_line')
        # 正規化 (0.8,0.2) → 真上 (800,200) → stall1 (y0-300)
        self.assertEqual(stall_of_point(0.8, 0.2, calib), 'stall1')
        # 正規化 (0.8,0.45) → 真上 (800,450) → stall2 (y300-600)
        self.assertEqual(stall_of_point(0.8, 0.45, calib), 'stall2')

    def test_point_outside_all_rects_returns_none(self):
        calib = camera_calibration(SAMPLE_STALL_ROIS, 'real01_line')
        # 正規化 (0.8,0.9) → 真上 (800,900) → どの rect 外
        self.assertIsNone(stall_of_point(0.8, 0.9, calib))

    def test_none_calib_returns_none(self):
        self.assertIsNone(stall_of_point(0.5, 0.5, None))


class TestFilterToRois(unittest.TestCase):
    def test_keeps_detection_inside_roi(self):
        calib = camera_calibration(SAMPLE_STALL_ROIS, 'real01_line')
        dets = [_det(0.8, 0.2)]
        self.assertEqual(filter_to_rois(dets, calib), dets)

    def test_drops_detection_outside_roi(self):
        calib = camera_calibration(SAMPLE_STALL_ROIS, 'real01_line')
        self.assertEqual(filter_to_rois([_det(0.8, 0.9)], calib), [])

    def test_none_calib_returns_empty(self):
        self.assertEqual(filter_to_rois([_det(0.8, 0.2)], None), [])

    def test_returns_original_detection_objects(self):
        calib = camera_calibration(SAMPLE_STALL_ROIS, 'real01_line')
        d = _det(0.8, 0.2)
        out = filter_to_rois([d], calib)
        self.assertIs(out[0], d)  # 変換前の元 detection をそのまま返す
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `python3 -m unittest tests.test_track_vehicles -v 2>&1 | tail -20`
Expected: FAIL — `camera_calibration`/`to_ground_point` 未定義、`stall_of_point`/`filter_to_rois` が旧署名。

- [ ] **Step 3: 実装**

`scripts/track_vehicles.py`:

(a) `stall_rois_for_camera` 関数の定義全体を**削除**する。

(b) 削除した場所に、`camera_calibration` と `to_ground_point` を追加:
```python
def camera_calibration(stall_rois_json, camera):
    """stall-rois.json (v2) から指定カメラの校正情報を返す純関数。

    戻り値: {'h_matrix': 3x3 list, 'stalls': [{'stall', 'rect':{x,y,w,h}}, ...]}
            該当カメラが cameras に無ければ None。rect は真上視点座標。
    """
    cams = stall_rois_json.get('cameras') or {}
    cam = cams.get(camera)
    if not cam:
        return None
    h = build_homography(cam['reference_points'], cam['rectified_corners'], cam['image_size'])
    stalls = []
    for name, st in (stall_rois_json.get('stalls') or {}).items():
        if str(st.get('source', '')).lower() != camera.lower():
            continue
        r = st.get('rect') or {}
        stalls.append({'stall': name, 'rect': {
            'x': r.get('x', 0), 'y': r.get('y', 0),
            'w': r.get('width', 0), 'h': r.get('height', 0),
        }})
    return {'h_matrix': h, 'stalls': stalls}


def to_ground_point(detection):
    """検出 {x,y,w,h}（中心座標）の接地点（下端中央）を持つ新 dict を返す純関数。

    x はそのまま、y は y + h/2（バウンディングボックス下端）。入力は破壊しない。
    ホモグラフィは地面平面上の点で正確なため、車体中心でなく接地点を使う。
    """
    d = dict(detection)
    d['y'] = detection.get('y', 0) + detection.get('h', 0) / 2.0
    return d
```

(c) 旧 `filter_to_rois` と 旧 `stall_of_point` の定義全体を、以下に置き換える:
```python
def stall_of_point(x, y, calib):
    """点 (x,y)（正規化元画像座標）を真上視点へ変換し、含む乗り場ROIの名を返す純関数。

    calib: camera_calibration の戻り。どの rect にも入らない / calib が None なら None。
    判定は半開区間 rx <= X < rx+rw かつ ry <= Y < ry+rh。
    """
    if x is None or y is None or calib is None:
        return None
    rx, ry = to_rectified(x, y, calib['h_matrix'])
    if rx != rx or ry != ry:  # nan チェック
        return None
    for s in calib['stalls']:
        r = s['rect']
        if r['x'] <= rx < r['x'] + r['w'] and r['y'] <= ry < r['y'] + r['h']:
            return s['stall']
    return None


def filter_to_rois(detections, calib):
    """接地点がいずれかの乗り場ROI内にある detection だけを返す純関数。

    detections: [{x,y,...}, ...]（x/y は接地点の0-1正規化座標＝to_ground_point 適用済み）。
    戻り値は元の detection オブジェクトをそのまま（変換せず）。
    calib が None / stalls が空なら [] を返す（ROI不明時に全車を通さない fail-safe）。
    """
    if calib is None or not calib['stalls']:
        return []
    out = []
    for d in detections:
        if stall_of_point(d.get('x'), d.get('y'), calib) is not None:
            out.append(d)
    return out
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `python3 -m unittest tests.test_track_vehicles -v 2>&1 | tail -20`
Expected: PASS — 新クラス（`TestCameraCalibration`/`TestToGroundPoint`/`TestStallOfPoint`/`TestFilterToRois`）と既存 `update_tracks`/`state` 系・`TestHomography` 全件パス。

- [ ] **Step 5: コミット**

```bash
git add scripts/track_vehicles.py tests/test_track_vehicles.py
git diff --cached --name-only
git commit -m "$(cat <<'EOF'
feat(track): 乗り場ROI判定をホモグラフィベースに置換

stall-rois.json v2（カメラ別ホモグラフィ＋真上視点ROI）を読む
camera_calibration、接地点を取る to_ground_point を追加。
stall_of_point/filter_to_rois を「真上視点へ変換→長方形判定」に変更。
旧 stall_rois_for_camera（歪んだ縦帯の軸並行矩形）を削除。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: main() の配線

**作業ディレクトリ:** taxi-ic-helper worktree

**Files:**
- Modify: `scripts/track_vehicles.py`（`main()` の per-camera ループ）

`main()` はファイルI/Oを伴うため単体テスト対象外。構文チェック＋Python全回帰で担保。

- [ ] **Step 1: 実装**

`scripts/track_vehicles.py` の `main()`、`for image_name, camera_key in TRACK_CAMERAS:` ループ内。

変更前:
```python
        for image_name, camera_key in TRACK_CAMERAS:
            tracks, next_id = camera_state(cameras, camera_key)
            img = fetch_image(image_name)
            raw_detections = detect_image(session, img)
            rois = stall_rois_for_camera(stall_rois_json, camera_key)
            detections = filter_to_rois(raw_detections, rois)
            result = update_tracks(tracks, detections, next_id, MAX_MISSED, DIST_THRESHOLD)
            new_cameras[camera_key] = {
                'tracks': result['tracks'], 'next_id': result['next_id'],
            }
            # 消失トラックを最後位置の乗り場 ROI へ振り分ける
            departed_by_stall = {}
            for dt in result['departedTracks']:
                stall = stall_of_point(dt['x'], dt['y'], rois)
                if stall is not None:
                    departed_by_stall[stall] = departed_by_stall.get(stall, 0) + 1
```

変更後:
```python
        for image_name, camera_key in TRACK_CAMERAS:
            tracks, next_id = camera_state(cameras, camera_key)
            img = fetch_image(image_name)
            raw_detections = detect_image(session, img)
            calib = camera_calibration(stall_rois_json, camera_key)
            # 検出を接地点（bbox下端中央）に直してから ROI 判定・追跡する
            ground_dets = [to_ground_point(d) for d in raw_detections]
            detections = filter_to_rois(ground_dets, calib)
            result = update_tracks(tracks, detections, next_id, MAX_MISSED, DIST_THRESHOLD)
            new_cameras[camera_key] = {
                'tracks': result['tracks'], 'next_id': result['next_id'],
            }
            # 消失トラックを最後位置（真上視点）の乗り場 ROI へ振り分ける
            departed_by_stall = {}
            for dt in result['departedTracks']:
                stall = stall_of_point(dt['x'], dt['y'], calib)
                if stall is not None:
                    departed_by_stall[stall] = departed_by_stall.get(stall, 0) + 1
```

`row_cameras[camera_key]` の構築・`schema_version: 4`・サマリ print は**変更しない**。

- [ ] **Step 2: 構文チェック**

Run: `python3 -c "import ast; ast.parse(open('scripts/track_vehicles.py').read())"`
Expected: エラーなし。

Run: `cd scripts && python3 -c "import ast; ast.parse(open('track_vehicles.py').read()); print('no stall_rois_for_camera:', 'stall_rois_for_camera' not in open('track_vehicles.py').read())"`
Expected: `no stall_rois_for_camera: True`（旧関数の参照が残っていない）。

- [ ] **Step 3: Python全テスト回帰**

Run: `python3 -m unittest tests.test_track_vehicles tests.test_detect_vehicles 2>&1 | tail -8`
Expected: PASS — 全件。失敗したら停止して報告。

- [ ] **Step 4: コミット**

```bash
git add scripts/track_vehicles.py
git diff --cached --name-only
git commit -m "$(cat <<'EOF'
feat(track): main を接地点＋ホモグラフィROI判定に配線

per-camera ループで検出を接地点に直し、camera_calibration の
ホモグラフィで真上視点ROI判定する。departedByStall(schema v4)は不変。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: 校正支援スクリプト calibrate-perspective.py

**作業ディレクトリ:** taxi-ic-helper worktree

**Files:**
- Create: `scripts/calibrate-perspective.py`

校正は対話・目視で行うためスクリプトは自動テスト対象外。`/tmp/calib-input.json` を
入力に、(a) 真上視点プレビュー画像、(b) 元画像にROIを逆投影した確認画像、を出力し、
確定後に `stall-rois.json` v2 を書き出す。`build_homography`/`to_rectified` は
`track_vehicles` から import して再利用する。

- [ ] **Step 1: スクリプトを作成**

`scripts/calibrate-perspective.py` を新規作成（内容全文）:
```python
#!/usr/bin/env python3
"""乗り場ROIの台形補正・校正支援スクリプト。

入力 /tmp/calib-input.json（カメラごとに reference_points / rectified_size / rois）を
読み、各カメラについて:
  - /tmp/calib-<camera>-rectified.png : 真上視点ワープ画像＋グリッド＋ROI
  - /tmp/calib-<camera>-original.png  : 元画像＋基準点＋ROIを逆投影した四角形
を出力する。--write 指定時は scripts/lib/stall-rois.json を v2 で書き出す。

使い方:
  python3 scripts/calibrate-perspective.py            # プレビュー画像のみ
  python3 scripts/calibrate-perspective.py --write    # 上記＋stall-rois.json書出し

/tmp/calib-input.json の形:
{
  "cameras": {
    "real01_line": {
      "image_name": "Real01_line",
      "image_size": [800, 600],
      "reference_points": [[x1,y1],[x2,y2],[x3,y3],[x4,y4]],
      "rectified_size": [1000, 1000],
      "rois": { "stall1": [x,y,w,h], "stall2": [x,y,w,h], "stall3": [x,y,w,h] }
    },
    "real02": { "...": "同様。rois は stall4 のみ" }
  }
}
"""
import json
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__)))
from track_vehicles import build_homography, to_rectified  # noqa: E402

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STALL_ROIS_PATH = os.path.join(REPO_ROOT, 'scripts', 'lib', 'stall-rois.json')
INPUT_PATH = '/tmp/calib-input.json'
TTC_BASE = 'https://ttc.taxi-inf.jp'
STALL_LABELS = {
    'stall1': '第1乗り場 (JAL 2番ポール T1)',
    'stall2': '第2乗り場 (JAL 18番ポール T1)',
    'stall3': '第3乗り場 (ANA 3番ポール T2)',
    'stall4': '第4乗り場 (ANA 19番ポール T2)',
}
STALL_CAPACITY = {'stall1': 8, 'stall2': 7, 'stall3': 8, 'stall4': 8}


def fetch_frame(image_name):
    """ttc から現在フレームを取得し OpenCV BGR 画像で返す。"""
    import urllib.request
    req = urllib.request.Request(f'{TTC_BASE}/{image_name}.jpg',
                                 headers={'User-Agent': 'taxi-ic-helper calibrate'})
    data = urllib.request.urlopen(req, timeout=15).read()
    arr = np.frombuffer(data, dtype=np.uint8)
    return cv2.imdecode(arr, cv2.IMREAD_COLOR)


def rectified_corners(rect_size):
    rw, rh = rect_size
    return [[0, 0], [rw, 0], [rw, rh], [0, rh]]


def h_pixel(reference_points, rect_size, image_size):
    """ピクセル元画像座標 → 真上視点座標 のホモグラフィ（3x3 numpy）。"""
    src = np.array(reference_points, dtype=np.float32)
    dst = np.array(rectified_corners(rect_size), dtype=np.float32)
    return cv2.getPerspectiveTransform(src, dst)


def draw_grid(img, step=100):
    h, w = img.shape[:2]
    for x in range(0, w, step):
        cv2.line(img, (x, 0), (x, h), (0, 255, 255), 1)
        cv2.putText(img, str(x), (x + 2, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1)
    for y in range(0, h, step):
        cv2.line(img, (0, y), (w, y), (0, 255, 255), 1)
        cv2.putText(img, str(y), (2, y + 16), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1)


def render_camera(camera, cfg):
    """1カメラぶんのプレビュー画像2枚を /tmp に書き出す。"""
    img = fetch_frame(cfg['image_name'])
    ref = cfg['reference_points']
    rect_size = cfg['rectified_size']
    h_px = h_pixel(ref, rect_size, cfg['image_size'])

    # (a) 真上視点ワープ＋グリッド＋ROI
    warped = cv2.warpPerspective(img, h_px, tuple(rect_size))
    draw_grid(warped, 100)
    for name, (x, y, w, hh) in cfg.get('rois', {}).items():
        cv2.rectangle(warped, (x, y), (x + w, y + hh), (0, 0, 255), 2)
        cv2.putText(warped, name, (x + 4, y + 22), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2)
    cv2.imwrite(f'/tmp/calib-{camera}-rectified.png', warped)

    # (b) 元画像＋基準点＋ROIを逆投影した四角形
    orig = img.copy()
    for i, (px, py) in enumerate(ref):
        cv2.circle(orig, (int(px), int(py)), 6, (0, 255, 0), -1)
        cv2.putText(orig, f'P{i+1}', (int(px) + 6, int(py)), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)
    h_inv = np.linalg.inv(h_px)
    for name, (x, y, w, hh) in cfg.get('rois', {}).items():
        quad = np.array([[[x, y]], [[x + w, y]], [[x + w, y + hh]], [[x, y + hh]]], dtype=np.float32)
        back = cv2.perspectiveTransform(quad, h_inv).reshape(-1, 2).astype(int)
        cv2.polylines(orig, [back], True, (0, 0, 255), 2)
        cv2.putText(orig, name, tuple(back[0] + [4, 18]), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 255), 2)
    cv2.imwrite(f'/tmp/calib-{camera}-original.png', orig)
    print(f'[calibrate] {camera}: /tmp/calib-{camera}-rectified.png /tmp/calib-{camera}-original.png')


def write_stall_rois(inp):
    """/tmp/calib-input.json の内容を stall-rois.json v2 として書き出す。"""
    out = {
        '_meta': {
            'source': 'calibrate-perspective.py によるホモグラフィ校正',
            'note': '台形補正。reference_points は元画像ピクセル、rect は真上視点座標。',
        },
        'schema_version': 2,
        'cameras': {},
        'stalls': {},
    }
    for camera, cfg in inp['cameras'].items():
        out['cameras'][camera] = {
            'image_size': cfg['image_size'],
            'reference_points': cfg['reference_points'],
            'rectified_size': cfg['rectified_size'],
            'rectified_corners': rectified_corners(cfg['rectified_size']),
        }
        for name, (x, y, w, hh) in cfg.get('rois', {}).items():
            out['stalls'][name] = {
                'source': camera,
                'capacity': STALL_CAPACITY.get(name, 0),
                'label': STALL_LABELS.get(name, name),
                'rect': {'x': x, 'y': y, 'width': w, 'height': hh},
            }
    with open(STALL_ROIS_PATH, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
        f.write('\n')
    print(f'[calibrate] wrote {STALL_ROIS_PATH}')


def main():
    with open(INPUT_PATH, 'r', encoding='utf-8') as f:
        inp = json.load(f)
    for camera, cfg in inp['cameras'].items():
        render_camera(camera, cfg)
    if '--write' in sys.argv:
        write_stall_rois(inp)


if __name__ == '__main__':
    main()
```

- [ ] **Step 2: 構文チェック**

Run: `python3 -c "import ast; ast.parse(open('scripts/calibrate-perspective.py').read()); print('ok')"`
Expected: `ok`。

- [ ] **Step 3: スモークテスト（ネットワーク可なら）**

`/tmp/calib-input.json` に仮の入力（real01_line: 基準点を画像四隅、rois に stall1 を
適当な矩形）を1カメラぶん書いて実行:
```bash
python3 scripts/calibrate-perspective.py 2>&1 | tail -5
```
Expected: `/tmp/calib-real01_line-rectified.png` 等が生成される。ネットワーク不可で
`fetch_frame` が失敗する場合はその旨を報告（スクリプト自体の構文・import が通れば可）。

- [ ] **Step 4: コミット**

```bash
git add scripts/calibrate-perspective.py
git diff --cached --name-only
git commit -m "$(cat <<'EOF'
feat(track): 台形補正の校正支援スクリプト calibrate-perspective.py

現在フレームを取得し、基準4点で真上視点ワープ画像＋グリッド、元画像への
ROI逆投影画像を出力。--write で stall-rois.json v2 を書き出す。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: 実校正・検証・本番反映（対話タスク — 制御セッションが実施）

**このタスクはサブエージェントに渡さない。** カメラ画像を見て基準点・ROIを決めるのは
ユーザーとの対話が必要なため、制御セッションが実施する。

- [ ] **Step 1: real01_line の基準4点を決める**

`calibrate-perspective.py` で現在フレームを取得し、駐車場の白線で現実が長方形になる
地面の4隅を選ぶ。候補を `/tmp/calib-input.json` に書いて実行 →
`/tmp/calib-real01_line-original.png`（基準点オーバーレイ）をユーザーに見せ、
「その4点でOK／ここを直す」を確認。合うまで反復。

- [ ] **Step 2: real01_line の真上視点を確認し乗り場ROIを決める**

確定基準点で `/tmp/calib-real01_line-rectified.png`（真上視点ワープ＋グリッド）を生成。
歪みが取れて駐車区画が格子状に見えることを確認。グリッドを見ながらユーザーが
乗り場1・2・3の領域を指定。`/tmp/calib-input.json` の `rois` に書いて再実行 →
逆投影確認画像で「乗り場1〜3が実際の待機列に乗っているか」を確認。合うまで反復。

- [ ] **Step 3: real02（乗り場4）も同様に校正**

Step 1-2 を real02 について繰り返す。

- [ ] **Step 4: stall-rois.json v2 を書き出す**

```bash
python3 scripts/calibrate-perspective.py --write
```
`scripts/lib/stall-rois.json` が v2 になる。`python3 -m unittest tests.test_track_vehicles`
が引き続きパスすること（テストは独自の SAMPLE を使うので影響しないが確認）。

- [ ] **Step 5: 実データ検証**

直近の track-history か現在フレームで、新 `camera_calibration`＋`stall_of_point` を
通し、乗り場別の検出が観測実態と整合するか確認する:
```bash
python3 - <<'PY'
import json, sys
sys.path.insert(0, 'scripts')
from track_vehicles import camera_calibration, stall_of_point, to_ground_point
from detect_vehicles import fetch_image, detect_image
import onnxruntime as ort
from detect_vehicles import MODEL_PATH
sj = json.load(open('scripts/lib/stall-rois.json'))
sess = ort.InferenceSession(MODEL_PATH, providers=['CPUExecutionProvider'])
for image_name, cam in [('Real01_line','real01_line'), ('Real02','real02')]:
    calib = camera_calibration(sj, cam)
    dets = [to_ground_point(d) for d in detect_image(sess, fetch_image(image_name))]
    cnt = {}
    for d in dets:
        s = stall_of_point(d['x'], d['y'], calib)
        cnt[s] = cnt.get(s, 0) + 1
    print(cam, cnt)
PY
```
Expected: 各乗り場ROIに検出が分散する（乗り場3がほぼ0でなくなる、乗り場1への偏りが
解消する）。結果をユーザーに報告。偏りが残るなら Step 2 に戻りROIを微調整。

- [ ] **Step 6: コミットして push**

```bash
git add scripts/lib/stall-rois.json
git diff --cached --name-only
git commit -m "$(cat <<'EOF'
feat(track): stall-rois.json を台形補正スキーマ v2 に更新

カメラ別ホモグラフィ基準点と真上視点ROIで校正。斜め撮影の透視ゆがみに
合わせ乗り場1〜4を再定義。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git pull --rebase --autostash origin main
git push origin main
```

- [ ] **Step 7: 完了報告**

push 後の SHA を報告。コード（Task 1-4）と校正データ（Task 5）が同じ push に含まれ、
観測スクリプトが次回 pull 時に v2 コード＋v2 データを揃って取り込むことを伝える。
過渡的に track-state が一度リセットされること（schema 都合があれば）も伝える。

---

## 完了条件

- `track_vehicles.py` がホモグラフィで真上視点ROI判定する（`to_rectified`/`build_homography`/`camera_calibration`/`to_ground_point`、新 `stall_of_point`/`filter_to_rois`）。
- `stall-rois.json` が v2（カメラ別ホモグラフィ＋真上視点ROI）。
- Python 全テスト（`test_track_vehicles`・`test_detect_vehicles`）が回帰なしでパス。
- 実データ検証で乗り場別の検出が観測実態と整合（乗り場3≈0・乗り場1過剰が解消）。
- taxi-ic-helper main 反映（コード＋校正データを揃えて push）。

## Self-Review

- **Spec coverage:** 設計§1(v2スキーマ)→Task 2・Task 4。§2(ホモグラフィ点変換)→Task 1。
  §3(接地点)→Task 2 `to_ground_point`・Task 3。§4(ROI判定)→Task 2。§5(校正プロセス・
  スクリプト)→Task 4・Task 5。§6(データフロー)→Task 3。§7(テスト方針)→各Task TDD。
- **Placeholder scan:** TBD/TODO なし。各コードステップに実コード全文。校正の実座標値は
  Task 5（対話）で確定する旨を明記＝設計書§波及と整合（プレースホルダではなく、校正
  という性質上の手順）。
- **Type consistency:** `to_rectified(x,y,h_matrix)` は Task 1 定義、`stall_of_point`
  （Task 2）・`calibrate-perspective.py`（Task 4）が使用。`build_homography(reference_points,
  rectified_corners,image_size)` は Task 1 定義、`camera_calibration`（Task 2）が使用。
  `camera_calibration` の戻り `{h_matrix, stalls:[{stall,rect:{x,y,w,h}}]}` は Task 2
  定義、`stall_of_point`/`filter_to_rois`（Task 2）・`main`（Task 3）が使用。
  `to_ground_point` は Task 2 定義・Task 3 使用。`departedByStall`(schema v4) は不変。
