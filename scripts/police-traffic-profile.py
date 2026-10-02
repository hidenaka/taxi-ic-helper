#!/usr/bin/env python3
"""ためた警察の交通量から「いつもの台数（曜日の種類×5分ごと）」を地点ごとに作る。

  入力: <ROOT>/packed/tokyo_YYYY_MM.npz（police-traffic-pack.py の出力）
  出力: <ROOT>/profile/tokyo_profile.npz
          keys    … 地点の名前（"情報源コード-計測地点番号"）
          kinds   … ["平日", "土曜", "日祝"]
          median  … [地点 × 3 × 288] いつもの台数（5分あたり・中央値）
          p25/p75 … 同じ形のばらつき（少ない日・多い日の目安）
          days    … [地点 × 3] 元にした日数
        <ROOT>/profile/tokyo_profile_summary.json … 期間・地点数・確かめ用の数字

出典: 「断面交通量情報」（公益財団法人日本道路交通情報センター）を加工して作成
祝日: 内閣府「国民の祝日」CSV（https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv）
"""
import argparse
import json
import os
import re
import sys
import urllib.request
import warnings
from datetime import datetime, timezone, timedelta

import numpy as np

JST = timezone(timedelta(hours=9))
MISSING = 65535
KINDS = ['平日', '土曜', '日祝']
HOLIDAY_URL = 'https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv'


def load_holidays(root):
    path = os.path.join(root, 'syukujitsu.csv')
    if not os.path.exists(path) or (datetime.now().timestamp() - os.path.getmtime(path)) > 30 * 86400:
        try:
            data = urllib.request.urlopen(HOLIDAY_URL, timeout=60).read()
            with open(path, 'wb') as f:
                f.write(data)
        except Exception as e:
            if not os.path.exists(path):
                raise RuntimeError(f'祝日の一覧が取れない: {e}')
    text = open(path, 'rb').read().decode('cp932', 'replace')
    out = set()
    for m in re.finditer(r'(\d{4})/(\d{1,2})/(\d{1,2})', text):
        y, mo, d = map(int, m.groups())
        out.add(f'{y:04d}-{mo:02d}-{d:02d}')
    return out


def day_kind(date, holidays):
    """0=平日 1=土曜 2=日祝（年末年始 12/29〜1/3 も日祝あつかい）"""
    s = date.strftime('%Y-%m-%d')
    md = (date.month, date.day)
    if s in holidays or date.weekday() == 6 or md >= (12, 29) or md <= (1, 3):
        return 2
    if date.weekday() == 5:
        return 1
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', default='/Volumes/ADATA HV620/police-traffic')
    ap.add_argument('--months', type=int, default=12, help='新しい方から何か月ぶんを使うか')
    a = ap.parse_args()
    packed = os.path.join(a.root, 'packed')
    files = sorted(f for f in os.listdir(packed) if re.match(r'tokyo_\d{4}_\d{2}\.npz$', f))
    files = files[-a.months:]
    if not files:
        print('詰め直したデータがまだ無い')
        return 1
    holidays = load_holidays(a.root)

    # 全期間の地点をそろえる（年によって地点が増えたり減ったりする）
    months = []
    all_keys = {}
    for f in files:
        z = np.load(os.path.join(packed, f))
        keys = [str(k) for k in z['keys']]
        for k in keys:
            all_keys.setdefault(k, len(all_keys))
        months.append((f, keys, int(z['t0']), z['vol']))
    P = len(all_keys)

    # 曜日の種類ごとに [日 × 地点 × 288] を積む（欠測は NaN）
    per_kind = {0: [], 1: [], 2: []}
    for f, keys, t0, vol in months:
        idx = np.array([all_keys[k] for k in keys])
        ndays = vol.shape[1] // 288
        v = vol[:, :ndays * 288].reshape(len(keys), ndays, 288).astype(np.float32)
        v[v == MISSING] = np.nan
        for d in range(ndays):
            date = datetime.fromtimestamp(t0, JST) + timedelta(days=d)
            day = np.full((P, 288), np.nan, dtype=np.float32)
            day[idx] = v[:, d, :]
            # 1日の半分以上が欠けている地点は、その日は使わない（止まっていた感知器）
            bad = np.isnan(day).sum(axis=1) > 144
            day[bad] = np.nan
            per_kind[day_kind(date, holidays)].append(day)

    kind_days = {KINDS[k]: len(per_kind[k]) for k in range(3)}
    med = np.full((P, 3, 288), np.nan, dtype=np.float32)
    p25 = np.full_like(med, np.nan)
    p75 = np.full_like(med, np.nan)
    days = np.zeros((P, 3), dtype=np.int32)
    for k in range(3):
        if not per_kind[k]:
            continue
        stack = np.stack(per_kind[k])             # [日, 地点, 288]
        per_kind[k] = None                        # 元のリストは手放す（メモリ節約）
        days[:, k] = (~np.isnan(stack).all(axis=2)).sum(axis=0)
        # 12か月ぶんだと平日だけで約245日。一度に計算すると数GB使うので、地点を区切って計算する
        for s0 in range(0, P, 300):
            s1 = min(P, s0 + 300)
            with warnings.catch_warnings():
                warnings.simplefilter('ignore', category=RuntimeWarning)
                q = np.nanpercentile(stack[:, s0:s1, :], [25, 50, 75], axis=0)   # [3, 地点, 288]
            p25[s0:s1, k], med[s0:s1, k], p75[s0:s1, k] = q[0], q[1], q[2]
        del stack

    out_dir = os.path.join(a.root, 'profile')
    os.makedirs(out_dir, exist_ok=True)
    key_list = [None] * P
    for k, i in all_keys.items():
        key_list[i] = k
    tmp = os.path.join(out_dir, 'tokyo_profile.part.npz')
    np.savez_compressed(tmp, keys=np.array(key_list), kinds=np.array(KINDS),
                        median=np.round(med, 1), p25=np.round(p25, 1), p75=np.round(p75, 1), days=days)
    os.replace(tmp, os.path.join(out_dir, 'tokyo_profile.npz'))

    # 確かめ用: 平日の1日の合計が多い地点（いつも混む交差点）
    with np.errstate(all='ignore'):
        daily = np.nansum(med[:, 0, :], axis=1)
    pts = {}
    last_points = os.path.join(packed, files[-1].replace('tokyo_', 'points_').replace('.npz', '.json'))
    if os.path.exists(last_points):
        pts = json.load(open(last_points, encoding='utf-8'))
    top = []
    for i in np.argsort(-daily)[:15]:
        k = key_list[i]
        hourly = [float(np.nansum(med[i, 0, h * 12:(h + 1) * 12])) for h in range(24)]
        top.append({'key': k, 'name': pts.get(k, {}).get('name', ''), 'weekdayTotal': int(daily[i]),
                    'peakHour': int(np.argmax(hourly)), 'days': days[i].tolist()})
    summary = {
        'months': [f[6:13] for f in files],
        'points': P,
        'daysByKind': kind_days,
        'pointsWithWeekday': int((days[:, 0] >= 20).sum()),
        'topWeekday': top,
        'generatedAt': datetime.now(JST).isoformat(timespec='seconds'),
        'source': '「断面交通量情報」（公益財団法人日本道路交通情報センター）を加工して作成',
    }
    with open(os.path.join(out_dir, 'tokyo_profile_summary.json'), 'w', encoding='utf-8') as f:
        json.dump(summary, f, ensure_ascii=False, indent=1)
    print(json.dumps({k: summary[k] for k in ('months', 'points', 'daysByKind', 'pointsWithWeekday')}, ensure_ascii=False))
    for t in top[:8]:
        print(f"  {t['name']}（{t['key']}）平日1日 {t['weekdayTotal']}台・いちばん多いのは{t['peakHour']}時台")
    return 0


if __name__ == '__main__':
    sys.exit(main())
