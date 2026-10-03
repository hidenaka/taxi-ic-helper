"""警察の感知器（交差点名＋2次メッシュ）を、OpenStreetMap の名前つき信号に当てて位置を推定する。"""
import json, math, re, unicodedata, collections

pts = json.load(open('points12.json', encoding='utf-8'))
osm = json.load(open('osm_signals.json', encoding='utf-8'))['elements']


def norm(s):
    s = unicodedata.normalize('NFKC', s or '').strip()
    s = re.sub(r'\s+', '', s)
    s = re.sub(r'(交差点|交叉点)$', '', s)
    s = s.replace('丁目', '')
    s = s.replace('ヶ', 'が').replace('ヵ', 'が')
    s = re.sub(r'(?<=[一-龥])ケ(?=[一-龥])', 'が', s)
    s = s.replace('之', 'の')
    s = s.translate(str.maketrans({'1': '一', '2': '二', '3': '三', '4': '四', '5': '五',
                                   '6': '六', '7': '七', '8': '八', '9': '九'}))
    return s


def mesh_bounds(code, margin_deg=0.004):
    p, u, q, v = int(code[0:2]), int(code[2:4]), int(code[4]), int(code[5])
    lat0 = p / 1.5 + q / 12
    lon0 = u + 100 + v / 8
    return lat0 - margin_deg, lat0 + 1 / 12 + margin_deg, lon0 - margin_deg, lon0 + 1 / 8 + margin_deg


def dist_m(a, b):
    dy = (a[0] - b[0]) * 111000
    dx = (a[1] - b[1]) * 111000 * math.cos(math.radians(a[0]))
    return math.hypot(dx, dy)


by_name = collections.defaultdict(list)
for e in osm:
    by_name[norm(e['tags'].get('name'))].append((e['lat'], e['lon']))
bridge_name = collections.defaultdict(list)
for e in json.load(open('osm_bridges.json', encoding='utf-8'))['elements']:
    if 'center' in e:
        bridge_name[norm(e['tags'].get('name'))].append((e['center']['lat'], e['center']['lon']))


def clusters(cands, r=400):
    out = []
    for c in cands:
        for cl in out:
            if dist_m(c, cl['c']) <= r:
                cl['pts'].append(c)
                n = len(cl['pts'])
                cl['c'] = (sum(x[0] for x in cl['pts']) / n, sum(x[1] for x in cl['pts']) / n)
                break
        else:
            out.append({'c': c, 'pts': [c]})
    return out


def find(name, mesh):
    lat0, lat1, lon0, lon1 = mesh_bounds(mesh)
    variants = [norm(name)]
    n = norm(name)
    # よくある言い換え: 末尾の「前」「北」「南」などはそのまま。「〇〇一」→「〇〇1丁目」相当は norm で吸収済み
    if n.endswith('前'):
        variants.append(n[:-1])
    for src, table in (('signal', by_name), ('bridge', bridge_name)):
      for v in variants:
        cands = [c for c in table.get(v, []) if lat0 <= c[0] <= lat1 and lon0 <= c[1] <= lon1]
        if not cands:
            continue
        cl = clusters(cands, r=400 if src == 'signal' else 700)
        tag = 'ok' if src == 'signal' else 'bridge'
        if len(cl) == 1:
            return cl[0]['c'], tag, v
        cl.sort(key=lambda x: -len(x['pts']))
        return cl[0]['c'], f'ambiguous{len(cl)}', v
    return None, 'none', None


res = {}
stat = collections.Counter()
for k, v in pts.items():
    c, st, used = find(v['name'], v['mesh'])
    stat[st if not st.startswith('ambiguous') else 'ambiguous'] += 1
    res[k] = {'name': v['name'], 'mesh': v['mesh'], 'status': st,
              'lat': round(c[0], 6) if c else None, 'lon': round(c[1], 6) if c else None}

print('地点', len(pts), dict(stat))
names_none = collections.Counter(v['name'] for v in res.values() if v['status'] == 'none')
print('見つからない名前(多い順)', names_none.most_common(30))
json.dump(res, open('police-points-geo.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=0)
