#!/usr/bin/env python3
"""警察の交通量（断面交通量情報・東京）を取り込んで外付けドライブにためる。

出典: 「断面交通量情報」（公益財団法人日本道路交通情報センター）
      https://www.jartic.or.jp/service/opendata/
      利用規約: 複製・加工・商用利用可（出典を記載）。CC BY 4.0 互換。

公式の公開ページは「最新の1か月ぶん」しか置かれず、翌月の更新で消える。
そこで2通りで取る:
  --latest   公式ページから、いま公開中の月の東京ぶんを取る（毎月の定期実行用）
  --backfill 過去分を保管している個人サーバー（全国まとめ・1か月 約4GB）から、
             HTTP の範囲指定で「東京ぶんの中身(約280MB)」だけを抜き出す。
             相手は個人のサーバーなので、1か月ずつ・間を空けて取りに行く。

置き場所: <ROOT>/raw/typeB_tokyo_YYYY_MM.zip （中身は公式と同じ CSV）
"""
import argparse
import io
import json
import os
import re
import sys
import time
import urllib.request
import zipfile

OFFICIAL_INDEX = 'https://www.jartic.or.jp/d/opendata/opendata.json'
OFFICIAL_BASE = 'https://www.jartic.or.jp/d/opendata'
MIRROR_BASE = 'http://storage.compusophia.com:1475/traffic/typeB/'
UA = 'taxi-ic-helper police-traffic-fetch (personal research; contact via github hidenaka)'
DEFAULT_ROOT = '/Volumes/ADATA HV620/police-traffic'


def http_get(url, headers=None, timeout=120):
    req = urllib.request.Request(url, headers={'User-Agent': UA, **(headers or {})})
    return urllib.request.urlopen(req, timeout=timeout)


class RangeFile(io.RawIOBase):
    """HTTP の範囲指定で読む、シーク可能なファイル。zipfile にそのまま渡せる。"""

    BLOCK = 8 * 1024 * 1024

    def __init__(self, url):
        self.url = url
        with http_get(url, {'Range': 'bytes=0-0'}) as r:
            cr = r.headers.get('Content-Range', '')
            m = re.search(r'/(\d+)$', cr)
            if not m:
                raise RuntimeError(f'範囲指定に対応していない: {url}')
            self.size = int(m.group(1))
        self.pos = 0
        self.cache_start = -1
        self.cache = b''
        self.fetched = 0

    def seekable(self):
        return True

    def readable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, off, whence=0):
        if whence == 0:
            self.pos = off
        elif whence == 1:
            self.pos += off
        else:
            self.pos = self.size + off
        return self.pos

    def _fill(self, start):
        end = min(self.size, start + self.BLOCK) - 1
        for attempt in range(5):
            try:
                with http_get(self.url, {'Range': f'bytes={start}-{end}'}, timeout=300) as r:
                    self.cache = r.read()
                break
            except Exception as e:  # 途切れたら少し待って取り直す
                if attempt == 4:
                    raise
                time.sleep(10 * (attempt + 1))
        self.cache_start = start
        self.fetched += len(self.cache)

    def readinto(self, b):
        if self.pos >= self.size:
            return 0
        n = len(b)
        out = 0
        while out < n and self.pos < self.size:
            if not (self.cache_start <= self.pos < self.cache_start + len(self.cache)):
                self._fill(self.pos)
            off = self.pos - self.cache_start
            chunk = self.cache[off:off + (n - out)]
            b[out:out + len(chunk)] = chunk
            out += len(chunk)
            self.pos += len(chunk)
        return out


def save_atomic(path, data_iter):
    tmp = path + '.part'
    with open(tmp, 'wb') as f:
        for chunk in data_iter:
            f.write(chunk)
    os.replace(tmp, path)


def check_zip(path):
    """取った東京ぶんの zip が壊れていないか（CSV が入っていて、どれも見出しが読めるか）。
    2017年ごろは1か月が前半・後半の2ファイルに分かれている。"""
    with zipfile.ZipFile(path) as z:
        names = [n for n in z.namelist() if not n.endswith('/')]
        if not names:
            raise RuntimeError('中身が空')
        for n in names:
            with z.open(n) as f:
                head = f.read(200).decode('cp932', 'replace')
            if '断面交通量' not in head:
                raise RuntimeError(f'見出し行が想定外: {n} {head[:80]}')


def fetch_latest(raw_dir):
    with http_get(OFFICIAL_INDEX) as r:
        idx = json.load(r)
    typeb = next(x for x in idx if x['type'] == 'typeB')
    link = next(t['link'] for t in typeb['targetList'] if t['id'] == 'R13')   # R13 = 東京
    name = os.path.basename(link)                                              # typeB_tokyo_YYYY_MM.zip
    dst = os.path.join(raw_dir, name)
    if os.path.exists(dst):
        print(f'[latest] もうある: {name}')
        return
    print(f'[latest] 取得: {name}（{typeb["targetMonth"]}・公開 {typeb["releaseDay"]}）')

    def chunks():
        with http_get(OFFICIAL_BASE + link, timeout=600) as r:
            while True:
                b = r.read(1 << 20)
                if not b:
                    break
                yield b
    save_atomic(dst, chunks())
    check_zip(dst)
    print(f'[latest] 保存: {dst} ({os.path.getsize(dst) / 1e6:.0f} MB)')


def mirror_months():
    with http_get(MIRROR_BASE) as r:
        html = r.read().decode('utf-8', 'replace')
    return sorted(set(re.findall(r'href="(\d{4}_\d{2})\.zip"', html)))


def fetch_backfill(raw_dir, since, until, pause):
    months = [m for m in mirror_months() if since <= m <= until]
    print(f'[backfill] 保管庫にある月: {len(months)}（{months[0] if months else "-"}〜{months[-1] if months else "-"}）')
    for ym in months:
        name = f'typeB_tokyo_{ym}.zip'
        dst = os.path.join(raw_dir, name)
        if os.path.exists(dst):
            continue
        url = f'{MIRROR_BASE}{ym}.zip'
        t0 = time.time()
        try:
            rf = RangeFile(url)
            with zipfile.ZipFile(io.BufferedReader(rf, buffer_size=1 << 20)) as outer:
                inner = [n for n in outer.namelist() if re.search(r'tokyo', n, re.I)]
                if not inner:
                    print(f'[backfill] {ym}: 東京ぶんが入っていない → 飛ばす')
                    continue

                def chunks():
                    with outer.open(inner[0]) as f:
                        while True:
                            b = f.read(1 << 20)
                            if not b:
                                break
                            yield b
                save_atomic(dst, chunks())
            try:
                check_zip(dst)
            except Exception:
                os.remove(dst)       # 壊れたものは残さない（次回取り直す）
                raise
            print(f'[backfill] {ym}: {os.path.getsize(dst) / 1e6:.0f} MB '
                  f'（取った量 {rf.fetched / 1e6:.0f} MB・{time.time() - t0:.0f}秒）', flush=True)
        except Exception as e:
            for p in (dst + '.part',):
                if os.path.exists(p):
                    os.remove(p)
            print(f'[backfill] {ym}: 失敗 {e}', flush=True)
        time.sleep(pause)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', default=DEFAULT_ROOT)
    ap.add_argument('--latest', action='store_true')
    ap.add_argument('--backfill', action='store_true')
    ap.add_argument('--since', default='2017_01')
    ap.add_argument('--until', default='9999_99')
    ap.add_argument('--pause', type=int, default=60, help='1か月ごとに空ける秒数（相手は個人サーバー）')
    a = ap.parse_args()
    raw_dir = os.path.join(a.root, 'raw')
    os.makedirs(raw_dir, exist_ok=True)
    if a.latest:
        fetch_latest(raw_dir)
    if a.backfill:
        fetch_backfill(raw_dir, a.since, a.until, a.pause)
    if not (a.latest or a.backfill):
        ap.print_help()
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
