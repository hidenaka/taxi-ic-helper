#!/usr/bin/env python3
"""取り込んだ警察の交通量（東京・1か月の CSV、約1.3GB）を小さな表に詰め直す。

  入力: <ROOT>/raw/typeB_tokyo_YYYY_MM.zip
  出力: <ROOT>/packed/tokyo_YYYY_MM.npz
          keys  … 地点の名前（"情報源コード-計測地点番号"）
          t0    … その月の最初の時刻（日本時間・UNIX秒）
          vol   … [地点 × 5分枠] の台数（uint16。65535 = 欠測）
        <ROOT>/packed/points_YYYY_MM.json … 地点の名称・2次メッシュ・リンク番号など

出典: 「断面交通量情報」（公益財団法人日本道路交通情報センター）を加工して作成
"""
import argparse
import calendar
import csv
import io
import json
import os
import re
import sys
import time
import zipfile
from datetime import datetime, timezone, timedelta

import numpy as np

JST = timezone(timedelta(hours=9))
MISSING = 65535
SLOT = 300  # 5分


def month_bounds(ym):
    y, m = map(int, ym.split('_'))
    start = datetime(y, m, 1, tzinfo=JST)
    days = calendar.monthrange(y, m)[1]
    return int(start.timestamp()), days * 288


def parse_time(s):
    # "2026/08/01 00:00" の形（年によって秒が付く・ゼロ埋め無しも許す）
    m = re.match(r'(\d{4})[/-](\d{1,2})[/-](\d{1,2})\s+(\d{1,2}):(\d{2})', s)
    if not m:
        return None
    y, mo, d, h, mi = map(int, m.groups())
    return int(datetime(y, mo, d, h, mi, tzinfo=JST).timestamp())


def pack(raw_path, out_dir):
    ym = re.search(r'(\d{4}_\d{2})', os.path.basename(raw_path)).group(1)
    out_npz = os.path.join(out_dir, f'tokyo_{ym}.npz')
    if os.path.exists(out_npz):
        return None
    t0, nslots = month_bounds(ym)
    t_start = time.time()
    keys = {}
    meta = {}
    rows_k, rows_s, rows_v = [], [], []
    bad = 0
    tcache = {}
    with zipfile.ZipFile(raw_path) as z:
        # 2017年ごろは1か月が前半・後半の2ファイルに分かれているので、全部読む
        for name in [n for n in z.namelist() if not n.endswith('/')]:
            with z.open(name) as fb:
                f = io.TextIOWrapper(fb, encoding='cp932', errors='replace', newline='')
                r = csv.reader(f)
                head = next(r)
                col = {h.strip(): i for i, h in enumerate(head)}
                ci_t = col['時刻']
                ci_src = col['情報源コード']
                ci_no = col['計測地点番号']
                ci_name = col.get('計測地点名称')
                ci_mesh = col.get('2次メッシュコード')
                ci_lkind = col.get('リンク区分')
                ci_link = col.get('リンク番号')
                ci_vol = col['断面交通量']
                ci_dist = col.get('リンク終端からの距離（×10m）')
                for row in r:
                    if len(row) <= ci_vol:
                        bad += 1
                        continue
                    ts = row[ci_t]
                    t = tcache.get(ts)
                    if t is None:
                        t = parse_time(ts)
                        tcache[ts] = t
                    if t is None:
                        bad += 1
                        continue
                    s = (t - t0) // SLOT
                    if s < 0 or s >= nslots:
                        bad += 1
                        continue
                    k = f'{row[ci_src]}-{row[ci_no]}'
                    ki = keys.get(k)
                    if ki is None:
                        ki = len(keys)
                        keys[k] = ki
                        meta[k] = {
                            'name': row[ci_name] if ci_name is not None else '',
                            'mesh': row[ci_mesh] if ci_mesh is not None else '',
                            'linkKind': row[ci_lkind] if ci_lkind is not None else '',
                            'link': row[ci_link] if ci_link is not None else '',
                            'dist10m': row[ci_dist] if ci_dist is not None else '',
                        }
                    v = row[ci_vol].strip()
                    if not v.lstrip('-').isdigit():
                        continue
                    v = int(v)
                    if v < 0 or v >= MISSING:
                        continue
                    rows_k.append(ki)
                    rows_s.append(s)
                    rows_v.append(v)
    vol = np.full((len(keys), nslots), MISSING, dtype=np.uint16)
    vol[np.asarray(rows_k, dtype=np.int32), np.asarray(rows_s, dtype=np.int32)] = np.asarray(rows_v, dtype=np.uint16)
    key_list = [None] * len(keys)
    for k, i in keys.items():
        key_list[i] = k
    tmp = out_npz + '.part.npz'
    np.savez_compressed(tmp, keys=np.array(key_list), t0=np.int64(t0), vol=vol)
    os.replace(tmp, out_npz)
    with open(os.path.join(out_dir, f'points_{ym}.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False)
    filled = float((vol != MISSING).mean())
    return {'ym': ym, 'points': len(keys), 'slots': nslots, 'filled': round(filled, 3),
            'bad': bad, 'sec': round(time.time() - t_start), 'mb': round(os.path.getsize(out_npz) / 1e6, 1)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', default='/Volumes/ADATA HV620/police-traffic')
    a = ap.parse_args()
    raw_dir = os.path.join(a.root, 'raw')
    out_dir = os.path.join(a.root, 'packed')
    os.makedirs(out_dir, exist_ok=True)
    for name in sorted(os.listdir(raw_dir)):
        if not re.match(r'typeB_tokyo_\d{4}_\d{2}\.zip$', name):
            continue
        try:
            res = pack(os.path.join(raw_dir, name), out_dir)
        except Exception as e:
            print(f'[pack] {name}: 失敗 {e}', flush=True)
            continue
        if res:
            print('[pack]', json.dumps(res, ensure_ascii=False), flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
