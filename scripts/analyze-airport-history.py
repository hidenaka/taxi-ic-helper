#!/usr/bin/env python3
"""
data/_private/history.xlsx から「羽田空港発の営業」の乗車時刻と
直前の休憩時間を抽出し、時間帯別に集計する。

フィルタ:
- 2024年8月1日以降のデータのみ
- 各日の迎車率 ≥ 90% の日のみ（アプリ配車中心運用の日）

使い方: python3 scripts/analyze-airport-history.py
"""
import zipfile
import xml.etree.ElementTree as ET
from collections import defaultdict
from datetime import date

XLSX = 'data/_private/history.xlsx'
NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
RELS = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'

CUTOFF_DATE = date(2024, 8, 1)
MIN_HAILED_RATIO = 0.90
PERIODS = [
    ('2024-08以降', lambda d: d >= CUTOFF_DATE),
    ('2024-08以前', lambda d: d < CUTOFF_DATE),
]

WEEKDAY_JP = {0:'月', 1:'火', 2:'水', 3:'木', 4:'金', 5:'土', 6:'日'}

BUCKETS = [
    ('early',     7*60,  9*60),
    ('morning',   9*60,  12*60),
    ('noon',      12*60, 15*60),
    ('afternoon', 15*60, 17*60),
    ('peak1',     17*60, 19*60),
    ('evening',   19*60, 21*60+30),
    ('peak2',     21*60+30, 24*60),
    ('midnight',  24*60, 27*60),
]

def excel_time_to_minutes(s):
    if not s: return None
    try: f = float(s)
    except (ValueError, TypeError): return None
    if f < 0 or f > 5: return None
    return f * 24 * 60

def parse_sheet_date(name):
    """シート名から日付を解析。
    例: '4月21日(火)', '2024年4月20日（土）', '12月14日(（日）'
    曜日と月日から、2024〜2026年のどの年かを推定。
    """
    import re
    # 「2024年4月20日（土）」のような明示形式
    m = re.match(r'^(\d{4})年\s*(\d+)月\s*(\d+)日', name)
    if m:
        return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    # 「4月21日(火)」のような月日+曜日
    m = re.match(r'^(\d+)月(\d+)日.*?[（(]([月火水木金土日])', name)
    if not m:
        return None
    mo, d, wd_jp = int(m.group(1)), int(m.group(2)), m.group(3)
    target_wd = {'月':0,'火':1,'水':2,'木':3,'金':4,'土':5,'日':6}[wd_jp]
    # 2024〜2026のうち、月日+曜日が一致する年を選ぶ。
    # シート順は新→古なので、最も新しい候補を優先。
    candidates = []
    for y in (2026, 2025, 2024):
        try:
            cand = date(y, mo, d)
            if cand.weekday() == target_wd:
                candidates.append(cand)
        except ValueError:
            continue
    if not candidates: return None
    return candidates[0]  # 最新優先

def open_xlsx():
    z = zipfile.ZipFile(XLSX)
    ss_root = ET.fromstring(z.read('xl/sharedStrings.xml'))
    strings = []
    for si in ss_root.findall(NS+'si'):
        t = si.find(NS+'t')
        if t is not None: strings.append(t.text or '')
        else:
            parts = si.findall(NS+'r/'+NS+'t')
            strings.append(''.join((p.text or '') for p in parts))
    wb = ET.fromstring(z.read('xl/workbook.xml'))
    rels = ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
    rid_to_target = {r.get('Id'): r.get('Target') for r in rels.findall('{http://schemas.openxmlformats.org/package/2006/relationships}Relationship')}
    sheets = []
    for s in wb.findall(NS+'sheets/'+NS+'sheet'):
        sheets.append((s.get('name'), rid_to_target.get(s.get(RELS+'id'))))
    return z, strings, sheets

def read_sheet(z, strings, target):
    sheet = ET.fromstring(z.read(f'xl/{target}'))
    rows = []
    for row in sheet.findall(f'{NS}sheetData/{NS}row'):
        cells = {}
        for c in row.findall(f'{NS}c'):
            ref = c.get('r', '')
            col_letters = ''.join(ch for ch in ref if ch.isalpha())
            t = c.get('t', 'n')
            v = c.find(f'{NS}v')
            if v is None: value = ''
            elif t == 's':
                idx = int(v.text)
                value = strings[idx] if idx < len(strings) else ''
            elif t == 'inlineStr':
                i = c.find(f'{NS}is/{NS}t')
                value = i.text if i is not None else ''
            else: value = v.text or ''
            cells[col_letters] = value
        row_list = [cells.get(col, '') for col in 'ABCDEFGHIJKLMNOPQR']
        rows.append(row_list)
    return rows

def find_log_start(rows):
    for i, r in enumerate(rows):
        if r and r[0] == 'No' and '乗車' in (r[1] or ''):
            return i + 1
    return None

def is_haneda(addr):
    return bool(addr) and '羽田空港' in addr

def is_op_no(no_field):
    """No列が数字（営業）か判定。"""
    if not no_field: return False
    s = no_field.strip()
    if not s: return False
    return all(ch.isdigit() or ch == '.' for ch in s)

def aggregate_for_period(z, strings, sheets, period_filter, label):
    """指定periodのフィルタ条件で集計。"""
    bucket_count = defaultdict(int)
    bucket_wait = defaultdict(list)
    bucket_fare = defaultdict(list)
    bucket_dist = defaultdict(list)
    bucket_dest = defaultdict(lambda: defaultdict(int))
    days_processed = 0
    days_skipped_low_hailed = 0
    total_haneda_ops = 0

    for name, target in sheets[3:]:
        if not target: continue
        d = parse_sheet_date(name)
        if d is None or not period_filter(d): continue
        try:
            rows = read_sheet(z, strings, target)
        except Exception: continue
        log_start = find_log_start(rows)
        if log_start is None: continue

        total_ops = 0; hailed_ops = 0
        for r in rows[log_start:]:
            if len(r) < 5: continue
            if is_op_no(r[0] or ''):
                total_ops += 1
                if '迎' in (r[4] or ''): hailed_ops += 1
        if total_ops == 0: continue
        if (hailed_ops/total_ops) < MIN_HAILED_RATIO:
            days_skipped_low_hailed += 1
            continue
        days_processed += 1

        prev_break_min = 0
        for r in rows[log_start:]:
            if len(r) < 9: continue
            no_field, board, _, duration, meet_or_break, from_addr, to_addr, distance, fare = r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8]
            is_op = is_op_no(no_field or '')
            is_break = '休' in (no_field or '')
            board_min = excel_time_to_minutes(board)
            dur_min = excel_time_to_minutes(duration) if duration else 0
            if is_break:
                if dur_min: prev_break_min += dur_min
                continue
            if is_op and is_haneda(from_addr):
                if board_min is None: continue
                bk_id = None
                for bid, frm, to in BUCKETS:
                    if board_min >= frm and board_min < to: bk_id = bid; break
                if bk_id is None and board_min < BUCKETS[0][1]: bk_id = 'midnight'
                if bk_id is None: continue
                bucket_count[bk_id] += 1
                bucket_wait[bk_id].append(prev_break_min)
                try: bucket_fare[bk_id].append(float((fare or '0').replace(',','')))
                except (ValueError, TypeError): pass
                try: bucket_dist[bk_id].append(float((distance or '0').replace(',','')))
                except (ValueError, TypeError): pass
                if to_addr:
                    import re
                    m = re.match(r'(\S+?[区市])', to_addr)
                    if m: bucket_dest[bk_id][m.group(1)] += 1
                total_haneda_ops += 1
                prev_break_min = 0
            elif is_op:
                prev_break_min = 0

    return {
        'label': label,
        'days_processed': days_processed,
        'days_skipped_low_hailed': days_skipped_low_hailed,
        'total_haneda_ops': total_haneda_ops,
        'bucket_count': bucket_count,
        'bucket_wait': bucket_wait,
        'bucket_fare': bucket_fare,
        'bucket_dist': bucket_dist,
        'bucket_dest': bucket_dest,
    }

def print_report(r):
    print(f'\n========== {r["label"]} ==========')
    print(f'集計対象日数: {r["days_processed"]} (除外: 迎車率<90% {r["days_skipped_low_hailed"]}日)')
    print(f'羽田空港発営業 合計: {r["total_haneda_ops"]}件')
    print(f'\n時間帯別:')
    print(f"{'バケット':<10} {'時間帯':<13} {'件数':<5} {'1日あたり':<10} {'平均待機分':<10} {'中央値分':<8} {'平均運賃':<8} {'平均距離':<8}")
    for bid, frm, to in BUCKETS:
        cnt = r['bucket_count'][bid]
        per_day = cnt / r['days_processed'] if r['days_processed'] else 0
        waits = r['bucket_wait'][bid]
        fares = r['bucket_fare'][bid]
        dists = r['bucket_dist'][bid]
        avg_w = sum(waits)/len(waits) if waits else 0
        med_w = sorted(waits)[len(waits)//2] if waits else 0
        avg_f = sum(fares)/len(fares) if fares else 0
        avg_d = sum(dists)/len(dists) if dists else 0
        frm_h = f'{frm//60:02d}:{frm%60:02d}'
        to_h = f'{to//60:02d}:{to%60:02d}'
        print(f"{bid:<10} {frm_h}-{to_h:<7} {cnt:<5} {per_day:<10.2f} {avg_w:<10.1f} {med_w:<8.1f} ¥{int(avg_f):<7} {avg_d:<8.1f}km")
    print(f'\n降車地区 TOP6:')
    for bid, frm, to in BUCKETS:
        dests = r['bucket_dest'][bid]
        if not dests: continue
        top = sorted(dests.items(), key=lambda x: -x[1])[:6]
        formatted = ', '.join(f'{k}:{v}' for k, v in top)
        print(f'  {bid}: {formatted}')

def main():
    z, strings, sheets = open_xlsx()
    print(f'迎車率カットオフ: ≥ {MIN_HAILED_RATIO*100:.0f}%、CUTOFF: {CUTOFF_DATE}')
    results = []
    for label, period_filter in PERIODS:
        results.append(aggregate_for_period(z, strings, sheets, period_filter, label))
    for r in results:
        print_report(r)

    # 比較表
    print(f'\n========== 比較（1日あたり件数）==========')
    print(f"{'バケット':<10} {'時間帯':<14}", end='')
    for r in results: print(f"{r['label']:<14}", end='')
    print()
    for bid, frm, to in BUCKETS:
        frm_h = f'{frm//60:02d}:{frm%60:02d}'
        to_h = f'{to//60:02d}:{to%60:02d}'
        print(f"{bid:<10} {frm_h}-{to_h:<8}", end='')
        for r in results:
            cnt = r['bucket_count'][bid]
            per_day = cnt / r['days_processed'] if r['days_processed'] else 0
            print(f"{per_day:<14.2f}", end='')
        print()

if __name__ == '__main__':
    main()
