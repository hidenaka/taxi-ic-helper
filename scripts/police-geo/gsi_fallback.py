"""OSMで見つからなかった交差点名を国土地理院の地名検索で補う（町名・駅・交番などの位置＝目安）。
同じ2次メッシュ（約10km四方）の中にある候補だけ使う。1秒に1回まで。"""
import json, re, time, urllib.parse, urllib.request, math, collections
from match_lib import mesh_bounds

res = json.load(open('police-points-geo.json', encoding='utf-8'))
cache = {}
try:
    cache = json.load(open('gsi_cache.json', encoding='utf-8'))
except Exception:
    pass

def queries(name):
    n = re.sub(r'(交差点)$', '', name)
    out = [n]
    # 「志村三」→「志村三丁目」、「〇〇駅前」→「〇〇駅」、「〇〇署前」「〇〇陸橋」「〇〇橋北」→ 地名部分
    if re.search(r'[一二三四五六七八九十]$', n):
        out.append(n + '丁目')
    m = re.match(r'(.+?)(駅前|駅北|駅南|駅東|駅西|駅入口)$', n)
    if m: out.append(m.group(1) + '駅')
    m = re.match(r'(.+?)(陸橋|橋北|橋南|橋東|橋西|口|入口|北|南|東|西|下|上|前|署前|警察署前|郵便局前)$', n)
    if m and len(m.group(1)) >= 2: out.append(m.group(1))
    return list(dict.fromkeys(out))

def search(q):
    if q in cache: return cache[q]
    url = 'https://msearch.gsi.go.jp/address-search/AddressSearch?q=' + urllib.parse.quote(q)
    try:
        d = json.load(urllib.request.urlopen(url, timeout=30))
    except Exception:
        d = []
    time.sleep(1.0)
    cache[q] = [{'t': x['properties']['title'], 'lon': x['geometry']['coordinates'][0], 'lat': x['geometry']['coordinates'][1]} for x in d[:30]]
    return cache[q]

stat = collections.Counter()
done_names = {}
for k, v in res.items():
    if v['status'] != 'none':
        continue
    key = (v['name'], v['mesh'])
    if key not in done_names:
        lat0, lat1, lon0, lon1 = mesh_bounds(v['mesh'])
        hit = None
        for q in queries(v['name']):
            for c in search(q):
                if lat0 <= c['lat'] <= lat1 and lon0 <= c['lon'] <= lon1:
                    hit = (c['lat'], c['lon'], q, c['t']); break
            if hit: break
        done_names[key] = hit
    hit = done_names[key]
    if hit:
        v.update({'status': 'approx', 'lat': round(hit[0], 6), 'lon': round(hit[1], 6), 'approxBy': f'{hit[2]}→{hit[3]}'})
    stat[v['status']] += 1

json.dump(cache, open('gsi_cache.json', 'w', encoding='utf-8'), ensure_ascii=False)
json.dump(res, open('police-points-geo.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=0)
print('補った結果', dict(stat))
print('全体', dict(collections.Counter(v['status'] if not v['status'].startswith('ambiguous') else 'ambiguous' for v in res.values())))
