#!/usr/bin/env python3
"""工事の記録 × 警察の交通量（5分ごと）で、「工事の作業時間に台数がどれだけ減るか」を測る。

考え方（工事ごと・近くの感知器ごと）:
  - 工事が始まる前の月（最大3か月）と、始まった後の月（最大3か月）の平日をくらべる
  - 作業時間（例 9:00〜17:00）の台数の変化を、同じ日の作業時間外の台数の変化で割る
      効果 = (後/前 の 作業時間内) ÷ (後/前 の 作業時間外)
    1.0 なら影響なし、0.8 なら作業時間に2割減。季節や道全体の増減は「時間外」で打ち消す
  - 作業開始の時刻をはさむ30分の「段差」を日ごとに見て、工事前には無かった段差が
    出た日の割合（＝実際に作業していそうな日の割合）も出す

入力: <ROOT>/geo/police-points-geo.json（交差点名から推定した位置。ok/bridge だけ使う）
      <ROOT>/geo/koji-*.json（工事マップの工事一覧）
      <ROOT>/packed/tokyo_YYYY_MM.npz
出力: <ROOT>/analysis/koji-traffic-effect.json と画面への要約

出典: 「断面交通量情報」（公益財団法人日本道路交通情報センター）を加工して作成
      東京都建設局 路上工事情報（CC BY 4.0）
      交差点の位置: © OpenStreetMap contributors（ODbL）
"""
import argparse
import glob
import json
import math
import os
import re
import statistics
from datetime import datetime, timedelta, timezone

import numpy as np

JST = timezone(timedelta(hours=9))
MISSING = 65535


# ---- 工事の読み方（tools/js/koji-data.js と同じ規則） ----
def ym_of(s):
    m = re.match(r'(\d{4})-(\d{2})', str(s or ''))
    return f'{m.group(1)}_{m.group(2)}' if m else None


def parse_windows(tw):
    out = []
    for w in str(tw or '').split(','):
        m = re.match(r'^\s*(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})\s*$', w)
        if m:
            out.append((int(m[1]) * 60 + int(m[2]), int(m[3]) * 60 + int(m[4])))
    return out


def lane_level(p):
    try:
        r, t = float(p.get('lanesRestricted')), float(p.get('lanesTotal'))
        known = r > 0 and t > 0
    except (TypeError, ValueError):
        known = False
        r = t = 0
    if p.get('restrictionType') == 'road_closed' or (known and r >= t):
        return 'closed'
    if p.get('restrictionType') == 'alternating_one_way':
        return 'alternating'
    if not known:
        return 'unknown'
    return 'half' if r / t >= 1 / 3 else 'part'


def slot_mask(wins):
    """作業時間に入る5分枠（288個）の印"""
    m = np.zeros(288, dtype=bool)
    for s, e in wins:
        for slot in range(288):
            t = slot * 5
            if (s <= e and s <= t < e) or (s > e and (t >= s or t < e)):
                m[slot] = True
    return m


# ---- 位置 ----
def to_xy(lat, lon, lat0):
    return lon * 111320 * math.cos(math.radians(lat0)), lat * 110540


def seg_dist(p, a, b):
    ax, ay = a; bx, by = b; px, py = p
    dx, dy = bx - ax, by - ay
    L = dx * dx + dy * dy
    t = 0 if L == 0 else max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / L))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def geom_lines(g):
    if g['type'] == 'Point':
        return [[g['coordinates'], g['coordinates']]]
    if g['type'] == 'LineString':
        return [g['coordinates']]
    if g['type'] == 'MultiLineString':
        return g['coordinates']
    return []


def dist_to_geom(lat, lon, g):
    best = 1e18
    p = to_xy(lat, lon, lat)
    for line in geom_lines(g):
        pts = [to_xy(c[1], c[0], lat) for c in line]
        if len(pts) == 1:
            pts = pts * 2
        for a, b in zip(pts, pts[1:]):
            best = min(best, seg_dist(p, a, b))
    return best


# ---- 交通量 ----
def load_holidays(root):
    text = open(os.path.join(root, 'syukujitsu.csv'), 'rb').read().decode('cp932', 'replace')
    return {f'{int(y):04d}-{int(m):02d}-{int(d):02d}' for y, m, d in re.findall(r'(\d{4})/(\d{1,2})/(\d{1,2})', text)}


class Months:
    def __init__(self, root):
        self.root = root
        self.cache = {}

    def get(self, ym):
        if ym not in self.cache:
            path = os.path.join(self.root, 'packed', f'tokyo_{ym}.npz')
            if not os.path.exists(path):
                self.cache[ym] = None
            else:
                z = np.load(path)
                keys = [str(k) for k in z['keys']]
                self.cache[ym] = ({k: i for i, k in enumerate(keys)}, int(z['t0']), z['vol'])
        return self.cache[ym]


def weekday_days(months, ym, key, holidays):
    """その月の平日ごとの [288] 台数（欠測は NaN）。地点が無ければ空"""
    m = months.get(ym)
    if not m or key not in m[0]:
        return []
    idx, t0, vol = m
    row = vol[idx[key]].astype(np.float32)
    row[row == MISSING] = np.nan
    out = []
    for d in range(row.size // 288):
        date = datetime.fromtimestamp(t0, JST) + timedelta(days=d)
        s = date.strftime('%Y-%m-%d')
        md = (date.month, date.day)
        if date.weekday() >= 5 or s in holidays or md >= (12, 29) or md <= (1, 3) or (8, 10) <= md <= (8, 16):
            continue                                   # 土日・祝日・年末年始・お盆は使わない
        day = row[d * 288:(d + 1) * 288]
        if np.isnan(day).sum() > 60:                   # 5時間以上欠けた日は使わない
            continue
        out.append(day)
    return out


def shift_month(ym, k):
    y, m = map(int, ym.split('_'))
    m += k
    while m > 12:
        y, m = y + 1, m - 12
    while m < 1:
        y, m = y - 1, m + 12
    return f'{y:04d}_{m:02d}'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', default='/Volumes/ADATA HV620/police-traffic')
    ap.add_argument('--radius', type=float, default=120, help='工事の線から何m以内の感知器を使うか')
    a = ap.parse_args()
    root = a.root
    pts = json.load(open(os.path.join(root, 'geo', 'police-points-geo.json'), encoding='utf-8'))
    pts = {k: v for k, v in pts.items() if v['status'] in ('ok', 'bridge') or v['status'].startswith('ambiguous')}
    koji_file = sorted(glob.glob(os.path.join(root, 'geo', 'koji-*.json')))[-1]
    works = json.load(open(koji_file, encoding='utf-8'))['features']
    holidays = load_holidays(root)
    months = Months(root)
    packed = sorted(re.search(r'(\d{4}_\d{2})', f).group(1) for f in glob.glob(os.path.join(root, 'packed', 'tokyo_*.npz')))
    last_ym = packed[-1]

    pairs = []
    for f in works:
        p = f['properties']
        s_ym, e_ym = ym_of(p.get('startAt')), ym_of(p.get('endAt'))
        wins = parse_windows(p.get('timeWindow'))
        if not s_ym or not wins or s_ym > last_ym or s_ym < packed[0]:
            continue
        mask = slot_mask(wins)
        if mask.all() or not mask.any():
            continue
        pre = [shift_month(s_ym, -k) for k in (3, 2, 1)]
        post = [m for m in (s_ym, shift_month(s_ym, 1), shift_month(s_ym, 2)) if m <= last_ym and (not e_ym or m <= e_ym)]
        if not post:
            continue
        # 工事の線の近くの感知器
        near = []
        for k, v in pts.items():
            if v['lat'] is None:
                continue
            # 粗い足切り（約1.5km）
            c = f['geometry']['coordinates']
            c0 = c if f['geometry']['type'] == 'Point' else (c[0] if f['geometry']['type'] == 'LineString' else c[0][0])
            if abs(v['lat'] - c0[1]) > 0.02 or abs(v['lon'] - c0[0]) > 0.025:
                continue
            d = dist_to_geom(v['lat'], v['lon'], f['geometry'])
            if d <= a.radius:
                near.append((k, round(d)))
        for k, d in near:
            pre_days = [x for m in pre for x in weekday_days(months, m, k, holidays)]
            post_days = [x for m in post for x in weekday_days(months, m, k, holidays)]
            if len(pre_days) < 15 or len(post_days) < 8:
                continue
            P, Q = np.stack(pre_days), np.stack(post_days)
            with np.errstate(all='ignore'):
                pin, qin = np.nanmean(P[:, mask], axis=1), np.nanmean(Q[:, mask], axis=1)
                pout, qout = np.nanmean(P[:, ~mask], axis=1), np.nanmean(Q[:, ~mask], axis=1)
            if np.nanmedian(pin) < 3 or np.nanmedian(pout) < 3:     # ほとんど車が通らない地点は使わない
                continue
            effect = (np.nanmedian(qin) / np.nanmedian(pin)) / (np.nanmedian(qout) / np.nanmedian(pout))
            # 作業開始の段差（開始前30分 → 開始後30分の比）。工事前の下位10%より低い日＝作業した日らしい
            step_share = None
            s0 = wins[0][0] // 5
            if 6 <= s0 < 282:
                def step(D):
                    with np.errstate(all='ignore'):
                        return np.nanmean(D[:, s0:s0 + 6], axis=1) / np.nanmean(D[:, s0 - 6:s0], axis=1)
                sp, sq = step(P), step(Q)
                sp, sq = sp[np.isfinite(sp)], sq[np.isfinite(sq)]
                if sp.size >= 10 and sq.size >= 5:
                    thr = np.percentile(sp, 10)
                    step_share = round(float((sq < thr).mean()), 2)
            pairs.append({
                'work': p.get('id'), 'title': p.get('title'), 'level': lane_level(p),
                'window': p.get('timeWindow'), 'night': not (6 * 60 <= wins[0][0] < 20 * 60),
                'start': s_ym, 'pre': pre, 'post': post,
                'point': k, 'pointName': pts[k]['name'], 'distM': d,
                'effect': round(float(effect), 3), 'stepShare': step_share,
                'preDays': len(pre_days), 'postDays': len(post_days),
            })

    out_dir = os.path.join(root, 'analysis')
    os.makedirs(out_dir, exist_ok=True)
    json.dump({'generatedAt': datetime.now(JST).isoformat(timespec='seconds'), 'radiusM': a.radius,
               'kojiFile': os.path.basename(koji_file), 'pairs': pairs},
              open(os.path.join(out_dir, 'koji-traffic-effect.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=0)

    # ---- 要約 ----
    print(f'工事×感知器の組: {len(pairs)}（工事 {len({x["work"] for x in pairs})} 件・感知器 {len({x["point"] for x in pairs})} か所）')
    for night in (False, True):
        for lv in ('closed', 'alternating', 'half', 'part', 'unknown'):
            xs = [x for x in pairs if x['level'] == lv and x['night'] == night]
            if len(xs) < 3:
                continue
            eff = [x['effect'] for x in xs]
            st = [x['stepShare'] for x in xs if x['stepShare'] is not None]
            print(f'  {"夜" if night else "昼"} {lv:12s} 組 {len(xs):4d}  作業時間の台数 中央値 {statistics.median(eff):.2f}倍'
                  f'（下位25% {np.percentile(eff, 25):.2f}）  段差が出た日の割合 {statistics.median(st) if st else float("nan"):.2f}')
    # 落ち込みの大きい組
    print('落ち込みの大きい組（上位10）:')
    for x in sorted(pairs, key=lambda x: x['effect'])[:10]:
        print(f'  {x["effect"]:.2f}倍  {x["level"]:11s} {x["window"]:22s} {x["pointName"]}（{x["distM"]}m）  {x["title"][:30]}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
