# タクシープール観測 — Phase B 分析手順

## 利用規約確認結果 (2026-05-10 時点)

- `https://ttc.taxi-inf.jp/robots.txt` — HTTP 404 (存在しない、明示的禁止なし)
- ページ本文に利用規約・bot 記述・お問い合わせ先 すべてなし
- 運営はドメインから「東京タクシーセンター」推定

判断: 進行可。User-Agent に bot 識別子 + GitHub URL を明記して 15 分間隔で取得開始。運営から連絡があれば即停止する運用で安全。

## 前提

Phase A で `data/taxi-pool-history.jsonl` に 14 日分 (約 4,032 tick) のデータが
蓄積された後に、このドキュメントの手順で分析を行う。

## 必要環境

- Python 3.10+ + pandas + matplotlib (or duckdb + plotly)
- jq (簡易集計用)

## ステップ

### 1. データ取得

```bash
git pull origin main
wc -l data/taxi-pool-history.jsonl
# 期待: 4000 行前後
```

### 2. ピボット可能な形式に変換

```python
import pandas as pd
df = pd.read_json('data/taxi-pool-history.jsonl', lines=True)
df['ts'] = pd.to_datetime(df['ts'])
df['hour'] = df['ts'].dt.hour
df['weekday'] = df['ts'].dt.weekday  # 0=月
df['black_ratio_1'] = df['img1'].apply(lambda x: x['black_ratio'])
df['black_ratio_2'] = df['img2'].apply(lambda x: x['black_ratio'])
df['diff_1'] = df['img1'].apply(lambda x: x.get('diff_from_prev'))
df['diff_2'] = df['img2'].apply(lambda x: x.get('diff_from_prev'))
df['est_taxi_pax'] = df['arrivals_state'].apply(
    lambda x: x.get('total_estimated_taxi_pax') if x else None
)
df['weather_code'] = df['weather'].apply(lambda x: x.get('code') if x else None)
```

### 3. 仮説検証

#### H1: 予測上昇と実プール減少のタイミング一致

「`est_taxi_pax` が立ち上がる時刻」と「`black_ratio` が下がり始める時刻」を
日次でプロットし、ラグの平均と分散を見る。

```python
df['date'] = df['ts'].dt.date
peaks = df.groupby('date').agg(
    pax_peak=('est_taxi_pax', lambda s: s.idxmax()),
    pool_low=('black_ratio_1', lambda s: s.idxmin())
)
# 時刻差を計算
```

#### H2: 予測スケールと出庫量の整合

`est_taxi_pax` (人) と `diff_1` の絶対値の合計 (= 1 日の出入り総量) の比が
transit-share.json の係数 (8〜32%) と整合するかを 1 日単位で見る。

#### H3: 雨天 (weather_code 50/60 系) で予測のずれ

```python
rain_codes = [51, 53, 55, 61, 63, 65]
df['is_rainy'] = df['weather_code'].isin(rain_codes)
print(df.groupby('is_rainy')[['est_taxi_pax', 'black_ratio_1']].agg(['mean', 'std']))
```

#### H4: 深夜帯 (21:30〜) のラッシュ

`hour >= 21` でフィルタし、`black_ratio_1` の急変 (`diff_1 > 0.05`) の頻度を見る。

### 4. 出力

`docs/research/taxi-pool-analysis-2026-MM-DD.md` に分析結果を書き、グラフは
`docs/research/figures/` に png で保存。

## 観測終了後の jsonl 取扱

```bash
mkdir -p data/_archive
mv data/taxi-pool-history.jsonl data/_archive/taxi-pool-history-2026-MM-DD-to-MM-DD.jsonl
git add -A && git commit -m "chore(observe): archive Phase A jsonl, start fresh observation"
```

新規観測を続けるなら空ファイルを置く必要なし (orchestrator が自動的に作る)。

## Phase B 完了後の判断

- 予測と実プールが整合 → 既存係数を維持
- 系統的なずれ → どの係数 (load-factors / transit-share / taxiBucket) を再校正するか
  Phase C spec として起こす

## Phase A の進捗チェックポイント

- 1 日経過 (≈ 96 行) → jsonl 構造を目視確認、欠落なし
- 7 日経過 (≈ 672 行) → tick_seq の抜けを `jq -r '.tick_seq' jsonl | awk 'NR>1 && $1!=prev+1 {print prev, $1}; {prev=$1}'` で検出
- 14 日経過 (≈ 4,032 行) → 観測完了、Phase B 分析セッションへ
