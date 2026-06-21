#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
from bisect import bisect_left
from collections import Counter, defaultdict, deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw, ImageFont


ARCHIVE_ROOT = Path("/Users/nakanohideaki/taxi-image-archive")
REAL01_ARCHIVE = ARCHIVE_ROOT / "real01_line"
REAL02_ARCHIVE = ARCHIVE_ROOT / "real02"

REAL01_FULL = REAL01_ARCHIVE / "2026-06-19" / "200030.jpg"
REAL01_EMPTY = REAL01_ARCHIVE / "2026-06-19" / "000018.jpg"
REAL02_FULL = REAL02_ARCHIVE / "2026-06-19" / "200030.jpg"
REAL02_EMPTY = REAL02_ARCHIVE / "2026-06-19" / "000018.jpg"

_REPO = Path(__file__).resolve().parents[1]
LANE_JSON = _REPO.parent / "data/noriba-lanes.json"
CAPACITY_JSON = _REPO.parent / "data/noriba-night-capacity.json"
REPORT_JSON = Path("/tmp/night_lantern_report.json")
OVERLAY_OUT = Path("/tmp/night_lanterns.png")

NIGHT_BRIGHTNESS_THRESHOLD = 55.0
CALIBRATION_DATES = ("2026-06-05", "2026-06-12", "2026-06-18", "2026-06-19")
CALIBRATION_HOURS = range(19, 24)
CALIBRATION_MINUTE_STEP = 10
CALIBRATION_MAX_OFFSET_SEC = 60
CALIBRATION_QUANTILE = 0.95

STALL_SOURCE = {
    "stall1": "real01",
    "stall2": "real01",
    "stall3": "real01",
    "stall4": "real01",
    "stall4_back": "real02",
}

STALLS_BY_SOURCE = {
    "real01": ["stall1", "stall2", "stall3", "stall4"],
    "real02": ["stall4_back"],
}

GO_GROUPS = {
    "1号": ["stall1"],
    "2号": ["stall2"],
    "3号": ["stall3"],
    "4号": ["stall4", "stall4_back"],
}

STALL_COLOR = {
    "stall1": (255, 96, 96),
    "stall2": (96, 255, 128),
    "stall3": (96, 220, 255),
    "stall4": (255, 220, 96),
    "stall4_back": (255, 96, 255),
}

REJECT_COLOR = {
    "brake_light": (255, 64, 64),
    "background_light": (255, 176, 64),
    "outside_lane": (255, 176, 64),
    "off_anchor": (180, 180, 180),
    "size_shape": (140, 140, 140),
}

BACKGROUND_FRAMES = {
    "real01": [
        REAL01_ARCHIVE / "2026-06-19" / "000048.jpg",
        REAL01_ARCHIVE / "2026-06-19" / "000119.jpg",
        REAL01_ARCHIVE / "2026-06-19" / "000150.jpg",
        REAL01_ARCHIVE / "2026-06-19" / "000221.jpg",
    ],
    "real02": [
        REAL02_ARCHIVE / "2026-06-19" / "000048.jpg",
        REAL02_ARCHIVE / "2026-06-19" / "000120.jpg",
        REAL02_ARCHIVE / "2026-06-19" / "000150.jpg",
        REAL02_ARCHIVE / "2026-06-19" / "000221.jpg",
    ],
}


@dataclass
class StallGeometry:
    name: str
    source: str
    points_norm: np.ndarray
    anchors_px: np.ndarray
    hull_px: list[tuple[float, float]]
    bbox: tuple[int, int, int, int]
    dist_limit: float
    y_limit: float


def convex_hull(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    pts = sorted(set(points))
    if len(pts) <= 1:
        return pts

    def cross(o: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower: list[tuple[float, float]] = []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)

    upper: list[tuple[float, float]] = []
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)

    return lower[:-1] + upper[:-1]


def point_in_poly(x: float, y: float, poly: list[tuple[float, float]]) -> bool:
    if len(poly) < 3:
        return False
    inside = False
    px1, py1 = poly[0]
    for i in range(len(poly) + 1):
        px2, py2 = poly[i % len(poly)]
        if y > min(py1, py2) and y <= max(py1, py2) and x <= max(px1, px2):
            if py1 != py2:
                xinters = (y - py1) * (px2 - px1) / (py2 - py1) + px1
            else:
                xinters = px1
            if px1 == px2 or x <= xinters:
                inside = not inside
        px1, py1 = px2, py2
    return inside


def score_map(rgb: np.ndarray) -> np.ndarray:
    r = rgb[..., 0].astype(np.int16)
    g = rgb[..., 1].astype(np.int16)
    b = rgb[..., 2].astype(np.int16)
    yellow = (r + g) // 2
    return np.maximum(np.maximum(g, b), yellow)


def make_red_mask(rgb: np.ndarray) -> np.ndarray:
    r = rgb[..., 0].astype(np.int16)
    g = rgb[..., 1].astype(np.int16)
    b = rgb[..., 2].astype(np.int16)
    return (r >= 140) & (r >= g + 32) & (r >= b + 32) & (g <= 170) & (b <= 170)


def connected_components(mask: np.ndarray) -> list[dict[str, Any]]:
    h, w = mask.shape
    seen = np.zeros_like(mask, dtype=np.uint8)
    components: list[dict[str, Any]] = []
    for y in range(h):
        for x in range(w):
            if not mask[y, x] or seen[y, x]:
                continue
            q = deque([(x, y)])
            seen[y, x] = 1
            xs: list[int] = []
            ys: list[int] = []
            while q:
                cx, cy = q.popleft()
                xs.append(cx)
                ys.append(cy)
                y0 = max(0, cy - 1)
                y1 = min(h, cy + 2)
                x0 = max(0, cx - 1)
                x1 = min(w, cx + 2)
                for ny in range(y0, y1):
                    row = seen[ny]
                    for nx in range(x0, x1):
                        if mask[ny, nx] and not row[nx]:
                            row[nx] = 1
                            q.append((nx, ny))
            components.append(
                {
                    "xs": np.asarray(xs, dtype=np.int16),
                    "ys": np.asarray(ys, dtype=np.int16),
                }
            )
    return components


def avg_brightness_rgb(rgb: np.ndarray) -> float:
    flat = rgb.reshape(-1, 3)
    sample = flat[::50]
    return float(sample.mean()) if len(sample) else 0.0


def capped_ratio(count: int, capacity: int) -> float:
    return min(1.0, count / max(1, capacity))


class NightLanternCounter:
    def __init__(self, lanes_path: Path = LANE_JSON, capacity_path: Path = CAPACITY_JSON):
        payload = json.loads(Path(lanes_path).read_text())
        self.points_norm = {k: np.asarray(v, dtype=np.float32) for k, v in payload.items() if isinstance(v, list)}
        self._geom: dict[tuple[str, int, int], dict[str, StallGeometry]] = {}
        self._background_rgb = {source: self._median_background(frames) for source, frames in BACKGROUND_FRAMES.items()}
        self._background_score = {source: score_map(rgb) for source, rgb in self._background_rgb.items()}
        self.capacity_path = Path(capacity_path)
        self.capacity_payload: dict[str, Any] = {}
        self.max_counts = {stall: 1 for stall in self.points_norm}
        if self.capacity_path.exists():
            self.apply_capacity_payload(json.loads(self.capacity_path.read_text()))

    @staticmethod
    def _median_background(frames: list[Path]) -> np.ndarray:
        stack = [np.asarray(Image.open(path).convert("RGB"), dtype=np.uint8) for path in frames]
        return np.median(np.stack(stack, axis=0), axis=0).astype(np.uint8)

    @staticmethod
    def _hhmmss_to_seconds(hhmmss: str) -> int:
        return int(hhmmss[:2]) * 3600 + int(hhmmss[2:4]) * 60 + int(hhmmss[4:6])

    def apply_capacity_payload(self, payload: dict[str, Any]) -> None:
        self.capacity_payload = payload
        self.max_counts = {stall: max(1, int(payload[stall])) for stall in self.points_norm}

    def save_capacity_payload(self, payload: dict[str, Any], out_path: str | Path | None = None) -> Path:
        out = Path(out_path) if out_path is not None else self.capacity_path
        out.write_text(json.dumps(payload, ensure_ascii=True, indent=2))
        return out

    def _geometry_for(self, source: str, width: int, height: int) -> dict[str, StallGeometry]:
        key = (source, width, height)
        if key in self._geom:
            return self._geom[key]

        result: dict[str, StallGeometry] = {}
        for stall, pts in self.points_norm.items():
            if STALL_SOURCE[stall] != source:
                continue
            anchors_px = np.column_stack((pts[:, 0] * width, pts[:, 1] * height))
            point_list = [(float(x), float(y)) for x, y in anchors_px]
            hull = convex_hull(point_list)
            xs = anchors_px[:, 0]
            ys = anchors_px[:, 1]
            margin = 18
            bbox = (
                max(0, int(math.floor(xs.min() - margin))),
                max(0, int(math.floor(ys.min() - margin))),
                min(width - 1, int(math.ceil(xs.max() + margin))),
                min(height - 1, int(math.ceil(ys.max() + margin))),
            )
            nn_dists = []
            for i, point in enumerate(anchors_px):
                others = np.delete(anchors_px, i, axis=0)
                if not len(others):
                    nn_dists.append(10.0)
                    continue
                nn_dists.append(float(np.sqrt(np.sum((others - point) ** 2, axis=1)).min()))
            q75 = float(np.quantile(nn_dists, 0.75)) if nn_dists else 10.0
            dist_limit = max(10.0, min(24.0, q75 * 1.25))
            y_limit = max(6.0, min(18.0, dist_limit * 0.8))
            result[stall] = StallGeometry(
                name=stall,
                source=source,
                points_norm=pts,
                anchors_px=anchors_px,
                hull_px=hull,
                bbox=bbox,
                dist_limit=dist_limit,
                y_limit=y_limit,
            )
        self._geom[key] = result
        return result

    def _detect_components(self, rgb: np.ndarray, source: str) -> list[dict[str, Any]]:
        bg_score = self._background_score[source]
        score = score_map(rgb)
        red = make_red_mask(rgb)
        diff = score.astype(np.int16) - bg_score.astype(np.int16)
        raw_mask = (score >= 138) & ~red
        seed_mask = raw_mask & (diff >= 24)
        components = connected_components(raw_mask)
        h, w = score.shape
        geom = self._geometry_for(source, w, h)
        filtered: list[dict[str, Any]] = []
        for comp in components:
            xs = comp["xs"]
            ys = comp["ys"]
            if not seed_mask[ys, xs].any():
                continue
            pixels = rgb[ys, xs]
            local_score = score[ys, xs]
            local_diff = diff[ys, xs]
            x0, x1 = int(xs.min()), int(xs.max())
            y0, y1 = int(ys.min()), int(ys.max())
            width_box = x1 - x0 + 1
            height_box = y1 - y0 + 1
            bbox_area = width_box * height_box
            cx = float(xs.mean())
            cy = float(ys.mean())
            mean_rgb = tuple(float(v) for v in pixels.mean(axis=0))
            red_ratio = float(make_red_mask(pixels.reshape(-1, 1, 3)).mean())
            best_stall = None
            best_dist = 1e9
            best_anchor = -1
            best_dy = 0.0
            for stall, stall_geom in geom.items():
                deltas = stall_geom.anchors_px - np.array([cx, cy], dtype=np.float32)
                dists = np.sqrt(np.sum(deltas**2, axis=1))
                idx = int(np.argmin(dists))
                dist = float(dists[idx])
                if dist < best_dist:
                    best_dist = dist
                    best_stall = stall
                    best_anchor = idx
                    best_dy = float(cy - stall_geom.anchors_px[idx, 1])
            filtered.append(
                {
                    "area": int(len(xs)),
                    "bbox": (x0, y0, x1, y1),
                    "width": width_box,
                    "height": height_box,
                    "bbox_area": bbox_area,
                    "fill_ratio": len(xs) / max(1, bbox_area),
                    "cx": cx,
                    "cy": cy,
                    "mean_rgb": mean_rgb,
                    "peak_score": int(local_score.max()),
                    "mean_score": float(local_score.mean()),
                    "peak_diff": int(local_diff.max()),
                    "mean_diff": float(local_diff.mean()),
                    "red_ratio": red_ratio,
                    "stall": best_stall,
                    "anchor_index": best_anchor,
                    "anchor_dist": best_dist,
                    "anchor_dy": best_dy,
                }
            )
        return filtered

    def _classify_component(self, comp: dict[str, Any], source_geom: dict[str, StallGeometry]) -> tuple[bool, str]:
        stall = comp["stall"]
        if stall is None:
            return False, "off_anchor"
        geom = source_geom[stall]
        cx = comp["cx"]
        cy = comp["cy"]
        x0, y0, x1, y1 = geom.bbox
        if cx < x0 or cx > x1 or cy < y0 or cy > y1:
            return False, "outside_lane"
        if not point_in_poly(cx, cy, geom.hull_px) and comp["anchor_dist"] > geom.dist_limit * 0.85:
            return False, "outside_lane"
        mean_r, mean_g, mean_b = comp["mean_rgb"]
        if comp["red_ratio"] >= 0.34 or (mean_r >= mean_g + 35 and mean_r >= mean_b + 35 and mean_r >= 150):
            return False, "brake_light"
        if comp["area"] < 2 or comp["area"] > 140 or comp["width"] > 22 or comp["height"] > 18 or comp["fill_ratio"] < 0.1:
            return False, "size_shape"
        if comp["anchor_dist"] > geom.dist_limit or abs(comp["anchor_dy"]) > geom.y_limit:
            return False, "off_anchor"
        if comp["peak_diff"] < 30 and comp["mean_diff"] < 18:
            return False, "background_light"
        return True, "lantern"

    def analyze_source(self, image_path: str | Path, source: str) -> dict[str, Any]:
        image_path = Path(image_path)
        rgb = np.asarray(Image.open(image_path).convert("RGB"))
        h, w, _ = rgb.shape
        brightness = avg_brightness_rgb(rgb)
        geom = self._geometry_for(source, w, h)
        counts = {stall: 0 for stall in geom}
        empty_rejections = {stall: {} for stall in counts}
        if brightness >= NIGHT_BRIGHTNESS_THRESHOLD:
            return {
                "source": source,
                "image_path": str(image_path),
                "brightness": brightness,
                "night_active": False,
                "counts": counts,
                "ratios": {stall: 0.0 for stall in counts},
                "accepted": [],
                "rejected": [],
                "rejection_by_stall": empty_rejections,
                "shape": (w, h),
                "disabled_reason": f"brightness_gate>={NIGHT_BRIGHTNESS_THRESHOLD:g}",
            }

        components = self._detect_components(rgb, source)
        accepted: list[dict[str, Any]] = []
        rejected: list[dict[str, Any]] = []
        for comp in components:
            keep, reason = self._classify_component(comp, geom)
            comp["reason"] = reason
            if keep:
                accepted.append(comp)
            else:
                rejected.append(comp)

        accepted.sort(key=lambda c: (-c["peak_diff"], -c["area"], c["anchor_dist"]))
        unique: list[dict[str, Any]] = []
        used_anchors: set[tuple[str, int]] = set()
        for comp in accepted:
            key = (comp["stall"], comp["anchor_index"])
            if key in used_anchors:
                dup = dict(comp)
                dup["reason"] = "duplicate_anchor"
                rejected.append(dup)
                continue
            used_anchors.add(key)
            unique.append(comp)

        for comp in unique:
            counts[comp["stall"]] += 1

        rejection_by_stall: dict[str, Counter[str]] = {stall: Counter() for stall in counts}
        for comp in rejected:
            if comp.get("stall") in rejection_by_stall:
                rejection_by_stall[comp["stall"]][comp["reason"]] += 1

        ratios = {stall: capped_ratio(count, self.max_counts[stall]) for stall, count in counts.items()}

        return {
            "source": source,
            "image_path": str(image_path),
            "brightness": brightness,
            "night_active": True,
            "counts": counts,
            "ratios": ratios,
            "accepted": unique,
            "rejected": rejected,
            "rejection_by_stall": {k: dict(v) for k, v in rejection_by_stall.items()},
            "shape": (w, h),
        }

    def analyze_pair(self, real01_path: str | Path, real02_path: str | Path) -> dict[str, Any]:
        one = self.analyze_source(real01_path, "real01")
        two = self.analyze_source(real02_path, "real02")
        result = {}
        for stall in self.points_norm:
            frame = one if STALL_SOURCE[stall] == "real01" else two
            result[stall] = {
                "count": frame["counts"][stall],
                "ratio": frame["ratios"][stall],
                "capacity": self.max_counts[stall],
                "rejections": frame["rejection_by_stall"][stall],
                "night_active": frame["night_active"],
                "brightness": frame["brightness"],
            }
        groups = {}
        for label, stalls in GO_GROUPS.items():
            count = sum(result[stall]["count"] for stall in stalls)
            max_count = sum(self.max_counts[stall] for stall in stalls)
            rejection_counter = Counter()
            active_sources = []
            for stall in stalls:
                rejection_counter.update(result[stall]["rejections"])
                if result[stall]["night_active"]:
                    active_sources.append(STALL_SOURCE[stall])
            groups[label] = {
                "count": count,
                "ratio": capped_ratio(count, max_count),
                "max_count": max_count,
                "stalls": stalls,
                "rejections": dict(rejection_counter),
                "night_active": bool(active_sources),
                "sources_active": sorted(set(active_sources)),
            }
        return {"real01": one, "real02": two, "stalls": result, "groups": groups}

    def analyze_stall(self, image_path: str | Path, stall: str) -> dict[str, Any]:
        source = STALL_SOURCE[stall]
        analyzed = self.analyze_source(image_path, source)
        return {
            "stall": stall,
            "source": source,
            "count": analyzed["counts"][stall],
            "ratio": analyzed["ratios"][stall],
            "capacity": self.max_counts[stall],
            "rejections": analyzed["rejection_by_stall"][stall],
            "night_active": analyzed["night_active"],
            "brightness": analyzed["brightness"],
        }

    def analyze_go(self, go_label: str, real01_path: str | Path, real02_path: str | Path) -> dict[str, Any]:
        paired = self.analyze_pair(real01_path, real02_path)
        if go_label not in paired["groups"]:
            raise KeyError(f"unknown go label: {go_label}")
        return paired["groups"][go_label]

    def _archive_index(self, source: str, date: str) -> tuple[list[Path], list[int]]:
        root = REAL01_ARCHIVE if source == "real01" else REAL02_ARCHIVE
        files = sorted(path for path in (root / date).iterdir() if path.suffix.lower() == ".jpg")
        return files, [self._hhmmss_to_seconds(path.stem) for path in files]

    @staticmethod
    def _nearest_frame(files: list[Path], seconds: list[int], target_sec: int, max_offset_sec: int) -> Path | None:
        idx = bisect_left(seconds, target_sec)
        best: tuple[int, Path] | None = None
        for cand in (idx - 1, idx):
            if 0 <= cand < len(seconds):
                delta = abs(seconds[cand] - target_sec)
                if delta <= max_offset_sec and (best is None or delta < best[0]):
                    best = (delta, files[cand])
        return best[1] if best else None

    def recalibrate_capacity_payload(
        self,
        dates: tuple[str, ...] = CALIBRATION_DATES,
        hours: range = CALIBRATION_HOURS,
        minute_step: int = CALIBRATION_MINUTE_STEP,
        quantile: float = CALIBRATION_QUANTILE,
        max_offset_sec: int = CALIBRATION_MAX_OFFSET_SEC,
    ) -> dict[str, Any]:
        counts_by_stall: dict[str, list[int]] = defaultdict(list)
        frames_used: list[dict[str, Any]] = []
        for date in dates:
            real01_files, real01_secs = self._archive_index("real01", date)
            real02_files, real02_secs = self._archive_index("real02", date)
            for hour in hours:
                for minute in range(0, 60, minute_step):
                    target_sec = hour * 3600 + minute * 60
                    real01_path = self._nearest_frame(real01_files, real01_secs, target_sec, max_offset_sec)
                    real02_path = self._nearest_frame(real02_files, real02_secs, target_sec, max_offset_sec)
                    if real01_path is None or real02_path is None:
                        continue
                    pair = self.analyze_pair(real01_path, real02_path)
                    night1 = pair["real01"]["night_active"]
                    night2 = pair["real02"]["night_active"]
                    if not (night1 or night2):
                        continue
                    counts = {stall: pair["stalls"][stall]["count"] for stall in self.points_norm}
                    frames_used.append(
                        {
                            "date": date,
                            "target": f"{hour:02d}:{minute:02d}",
                            "real01": real01_path.name,
                            "real02": real02_path.name,
                            "brightness": {
                                "real01": round(pair["real01"]["brightness"], 1),
                                "real02": round(pair["real02"]["brightness"], 1),
                            },
                            "night_active": {"real01": night1, "real02": night2},
                            "counts": counts,
                        }
                    )
                    if night1:
                        for stall in STALLS_BY_SOURCE["real01"]:
                            counts_by_stall[stall].append(counts[stall])
                    if night2:
                        counts_by_stall["stall4_back"].append(counts["stall4_back"])

        if not frames_used:
            raise RuntimeError("no night frames found for calibration")

        payload: dict[str, Any] = {}
        for stall in self.points_norm:
            values = counts_by_stall.get(stall, [])
            if not values:
                raise RuntimeError(f"no night samples collected for {stall}")
            payload[stall] = max(1, int(math.ceil(float(np.quantile(values, quantile)))))

        payload["_method"] = (
            f"capacity = ceil(p{int(round(quantile * 100))}) of lantern counts from "
            f"{len(frames_used)} sampled archive frames across {', '.join(dates)} "
            f"at {hours.start:02d}:00-{hours.stop - 1:02d}:59 every {minute_step} min; "
            f"per-source samples used only when sampled avg brightness < {NIGHT_BRIGHTNESS_THRESHOLD:g}; "
            f"occupancy ratios are capped at 100%"
        )
        payload["_frames_used"] = frames_used
        return payload

    def draw_overlay(self, full_pair: dict[str, Any], out_path: str | Path = OVERLAY_OUT) -> Path:
        real01 = Image.open(full_pair["real01"]["image_path"]).convert("RGB")
        real02 = Image.open(full_pair["real02"]["image_path"]).convert("RGB")
        draw1 = ImageDraw.Draw(real01)
        draw2 = ImageDraw.Draw(real02)
        font = ImageFont.load_default()

        for source_name, image, draw in (("real01", real01, draw1), ("real02", real02, draw2)):
            frame = full_pair[source_name]
            for comp in frame["accepted"]:
                color = STALL_COLOR[comp["stall"]]
                draw.rectangle(comp["bbox"], outline=color, width=2)
            for comp in frame["rejected"]:
                if comp["reason"] not in {"brake_light", "background_light", "outside_lane"}:
                    continue
                if comp["reason"] == "outside_lane" and comp["area"] < 8:
                    continue
                color = REJECT_COLOR.get(comp["reason"], (180, 180, 180))
                draw.rectangle(comp["bbox"], outline=color, width=1)
            w, _ = image.size
            geom = self._geometry_for(source_name, image.width, image.height)
            for stall, stall_geom in geom.items():
                color = STALL_COLOR[stall]
                for x, y in stall_geom.anchors_px:
                    draw.ellipse((x - 1, y - 1, x + 1, y + 1), outline=color)
            lines = [f"brightness: {frame['brightness']:.1f} active={frame['night_active']}"]
            for stall in sorted([s for s in self.points_norm if STALL_SOURCE[s] == source_name]):
                count = frame["counts"][stall]
                max_count = self.max_counts[stall]
                lines.append(f"{stall}: {count}/{max_count}")
            for i, line in enumerate(lines):
                draw.text((8, 8 + i * 12), line, fill=(255, 255, 255), font=font)
            draw.text((w - 170, 8), "accepted / red / bg", fill=(255, 255, 255), font=font)

        canvas = Image.new("RGB", (real01.width + real02.width, max(real01.height, real02.height)), (0, 0, 0))
        canvas.paste(real01, (0, 0))
        canvas.paste(real02, (real01.width, 0))
        out_path = Path(out_path)
        canvas.save(out_path)
        return out_path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--recalibrate", action="store_true", help="rebuild /tmp/night_capacity_codex.json from archive")
    parser.add_argument("--capacity-json", default=str(CAPACITY_JSON))
    parser.add_argument("--report-json", default=str(REPORT_JSON))
    args = parser.parse_args()

    capacity_path = Path(args.capacity_json)
    counter = NightLanternCounter(capacity_path=capacity_path)
    if args.recalibrate or not capacity_path.exists():
        payload = counter.recalibrate_capacity_payload()
        counter.save_capacity_payload(payload, capacity_path)
        counter.apply_capacity_payload(payload)

    full = counter.analyze_pair(REAL01_FULL, REAL02_FULL)
    empty = counter.analyze_pair(REAL01_EMPTY, REAL02_EMPTY)
    overlay = counter.draw_overlay(full, OVERLAY_OUT)
    report = {
        "max_counts": counter.max_counts,
        "full": full["stalls"],
        "full_groups": full["groups"],
        "empty": empty["stalls"],
        "empty_groups": empty["groups"],
        "overlay": str(overlay),
        "capacity_json": str(capacity_path),
    }
    Path(args.report_json).write_text(json.dumps(report, ensure_ascii=True, indent=2))
    print(json.dumps(report, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
