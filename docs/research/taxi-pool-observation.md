# タクシープール観測 — Phase B 分析手順

## スキーマ履歴

- **v1** (2026-05-10 〜 2026-05-11、121 行): `img.black_ratio` / `img.diff_from_prev` / `arrivals_state.total_estimated_taxi_pax`
- **v2** (2026-05-11 〜 2026-05-12、数十行): `schema_version: 2` フィールドあり。`img.roi.edge_density` / `img.roi.luminance_mean` / `arrivals_window.estimated_taxi_pax_sum` を追加。v1 フィールドは互換のため保持
- **v3** (2026-05-12 〜): `schema_version: 3` フィールドあり。`stalls.stall1` 〜 `stalls.stall4` で 4 乗り場別の `occupied_estimate` / `diff_occupied_from_prev` を追加。`img2.analysis_disabled: true` で Real02 が神奈川車混在で観測対象外であることを明示。取得頻度を 15 分 → 5 分に変更。

詳細は:
- v2: `docs/superpowers/specs/2026-05-11-observation-schema-v2-design.md`
- v3: `docs/superpowers/specs/2026-05-12-stall-aware-observation-design.md`

**v3 ROI キャリブレーション課題 (Phase B での宿題)**: 当初の「右端 1 列で 8/7/8 台が縦に積み上がる」という ROI 設計は、カメラ遠近で本体列が画像奥に圧縮されて見えないことが判明。`stall1-3` の ROI 座標は暫定値のまま運用、より精度の高い「**駐車枠ベース検出**」を spec v4 として別途設計予定。v3 の stalls 値は「粗いシグナル」として記録継続、Phase B 分析で「駐車枠版」と比較する。

## 利用規約確認結果 (2026-05-10 時点)

- `https://ttc.taxi-inf.jp/robots.txt` — HTTP 404 (存在しない、明示的禁止なし)
- ページ本文に利用規約・bot 記述・お問い合わせ先 すべてなし
- 運営はドメインから「東京タクシーセンター」推定

判断: 進行可。User-Agent に bot 識別子 + GitHub URL を明記して 15 分間隔で取得開始。運営から連絡があれば即停止する運用で安全。

## 運用形態: ローカル launchd (GeoIP 制約のため)

GitHub Actions runner (Azure US) から ttc.taxi-inf.jp:443 への TCP 接続が
`UND_ERR_CONNECT_TIMEOUT` で失敗する (海外 IP 拒否)。日本国内 IP からは正常に
取得できるため、ローカル Mac の launchd で観測ジョブを動かす運用に切り替え。

### 起動手順

```bash
cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係"
./scripts/install-observe-launchd.sh install
```

15 分間隔 (`StartInterval: 900`) で `scripts/observe-tick-local.sh` が起動し、
画像取得 → 解析 → jsonl 追記 → git push を行う。

### 状態確認

```bash
./scripts/install-observe-launchd.sh status
```

`launchctl list | grep jp.taxi-ic-helper.observe` で PID と最終 exit ステータスを表示。
ログは `.local/observe-stdout.log` / `.local/observe-stderr.log` (gitignore)。

### 停止・再開

```bash
./scripts/install-observe-launchd.sh uninstall  # 停止
./scripts/install-observe-launchd.sh install    # 再開
./scripts/install-observe-launchd.sh run-once   # 1 回だけ手動実行 (デバッグ)
```

### 制約と前提

- Mac がスリープ / 電源 OFF 中は観測されない (データ欠損)
- 14 日連続観測の網羅率は実際の Mac 稼働時間に依存
- 14 日経過後の Phase B 分析時に `tick_seq` の連続性で欠損を集計し、データ品質を判定する

### Mac mini (24h 稼働機) への移設手順

スリープしない Mac (常時稼働の Mac mini など) があれば、欠損率を最小化できる。
スクリプトはリポジトリ相対パスで自動解決するため、Mac 名や iCloud Drive のマウント先に依存しない。

**移設手順** (macOS 想定):

1. 観測 Mac (現行) で launchd ジョブを停止:
   ```bash
   ./scripts/install-observe-launchd.sh uninstall
   ```

2. Mac mini 側でこのリポジトリをクローン (同じ Apple ID で iCloud Drive 経由なら同期されているので clone 不要):
   ```bash
   # 例: GitHub から clone する場合
   git clone https://github.com/hidenaka/taxi-ic-helper.git ~/repos/taxi-ic-helper
   cd ~/repos/taxi-ic-helper
   npm install
   ```

3. Mac mini で git push 認証を済ませる (HTTPS PAT or SSH key)。一度手動で `git push` を試して通ることを確認。

4. Mac mini で launchd ジョブを install:
   ```bash
   ./scripts/install-observe-launchd.sh install
   ./scripts/install-observe-launchd.sh run-once  # 1 tick 動作確認
   ./scripts/install-observe-launchd.sh status
   ```

5. ログを 1 時間後に確認:
   ```bash
   tail -f .local/observe-stdout.log
   ```
   `[observe] appended tick_seq=N` が 15 分間隔で出ていれば OK。

**重要 — 二重実行の禁止**:

複数の Mac で同時に launchd を install すると、同じ tick で 2 つの行が
`data/taxi-pool-history.jsonl` に append されて時系列が乱れる。Mac mini に
移したら必ず元の Mac で `uninstall` する。

**Mac mini ではスリープを抑止する** (省エネ設定 → コンピュータのスリープ「しない」)。Mac mini は標準でディスプレイスリープのみ可能でシステムスリープは起きないので、デフォルトで問題ないことが多い。

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
df['weekday'] = df['ts'].dt.weekday
df['schema'] = df.get('schema_version', pd.Series([None] * len(df))).fillna(1).astype(int)

# v1 互換フィールド (全行で有効)
df['black_ratio_1'] = df['img1'].apply(lambda x: x['black_ratio'])
df['black_ratio_2'] = df['img2'].apply(lambda x: x['black_ratio'])

# v2 専用フィールド (schema_version=2 の行だけ)
def get_nested(x, *keys):
    for k in keys:
        if x is None: return None
        x = x.get(k) if isinstance(x, dict) else None
    return x

df['edge_density_1'] = df['img1'].apply(lambda x: get_nested(x, 'roi', 'edge_density'))
df['edge_density_2'] = df['img2'].apply(lambda x: get_nested(x, 'roi', 'edge_density'))
df['luminance_mean_1'] = df['img1'].apply(lambda x: get_nested(x, 'roi', 'luminance_mean'))
df['window_taxi_pax'] = df['arrivals_window'].apply(lambda x: get_nested(x, 'estimated_taxi_pax_sum'))
df['window_flights'] = df['arrivals_window'].apply(lambda x: get_nested(x, 'flight_count'))

df['weather_code'] = df['weather'].apply(lambda x: get_nested(x, 'code'))

# v2 だけのサブセット
v2 = df[df['schema'] == 2].copy()
print(f"v1 行: {(df['schema'] == 1).sum()}, v2 行: {len(v2)}")
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

#### H5 (v2 専用): edge_density と window_taxi_pax の相関

ROI エッジ密度 (= 実プールの車両在不在の照度ロバスト指標) と、時間窓予測タクシー
候補数の Pearson 相関を 1 時間バケットごとに計算。負の相関 (= 予測タクシー多い時
にプール空く) が見えれば「予測 vs 実」の有意な乖離が観測されたことになる。

```python
v2_hour = v2.groupby('hour').agg(
    edge1_mean=('edge_density_1', 'mean'),
    edge2_mean=('edge_density_2', 'mean'),
    window_taxi_mean=('window_taxi_pax', 'mean'),
    n=('ts', 'count')
)
print(v2_hour)
corr = v2[['edge_density_1', 'window_taxi_pax']].corr().iloc[0, 1]
print(f"edge_density_1 vs window_taxi_pax Pearson r = {corr:.3f}")
```

#### H6 (v3 専用): T1 / T2 別の出庫と arrivals_window の整合

stall1+stall2 (T1) の `diff_occupied_from_prev` の負値合計 = T1 出庫数推定。
stall3+stall4 (T2) も同様。

```python
v3 = df[df['schema'] == 3].copy()
v3['stall1_occ'] = v3['stalls'].apply(lambda x: get_nested(x, 'stall1', 'occupied_estimate'))
v3['stall2_occ'] = v3['stalls'].apply(lambda x: get_nested(x, 'stall2', 'occupied_estimate'))
v3['stall3_occ'] = v3['stalls'].apply(lambda x: get_nested(x, 'stall3', 'occupied_estimate'))
v3['stall4_occ'] = v3['stalls'].apply(lambda x: get_nested(x, 'stall4', 'occupied_estimate'))
v3['stall1_diff'] = v3['stalls'].apply(lambda x: get_nested(x, 'stall1', 'diff_occupied_from_prev'))
v3['stall2_diff'] = v3['stalls'].apply(lambda x: get_nested(x, 'stall2', 'diff_occupied_from_prev'))
v3['stall3_diff'] = v3['stalls'].apply(lambda x: get_nested(x, 'stall3', 'diff_occupied_from_prev'))
v3['stall4_diff'] = v3['stalls'].apply(lambda x: get_nested(x, 'stall4', 'diff_occupied_from_prev'))

# 出庫数推定 (負の diff を絶対値で合計)
v3['T1_outflow'] = (-v3[['stall1_diff', 'stall2_diff']].clip(upper=0)).sum(axis=1)
v3['T2_outflow'] = (-v3[['stall3_diff', 'stall4_diff']].clip(upper=0)).sum(axis=1)

hourly = v3.groupby('hour').agg(
    T1_outflow=('T1_outflow', 'sum'),
    T2_outflow=('T2_outflow', 'sum'),
    window_taxi_pax_mean=('window_taxi_pax', 'mean')
)
print(hourly)
```

#### H7 (v3 専用): 「便ピーク」→「乗り場出庫」のラグ時間

`arrivals_window.estimated_taxi_pax_sum` がピークになる時刻と、stall 出庫の累積が
ピークになる時刻のラグを 5 分単位で測る。

```python
v3['ts'] = pd.to_datetime(v3['ts'])
day = v3[v3['ts'].dt.date == pd.Timestamp('2026-05-13').date()]
day_resampled = day.set_index('ts').resample('5min').first()

from scipy.signal import correlate
window = day_resampled['window_taxi_pax'].fillna(0).values
outflow = (day_resampled['T1_outflow'] + day_resampled['T2_outflow']).fillna(0).values
xcorr = correlate(outflow, window, mode='full')
lag = xcorr.argmax() - (len(window) - 1)  # 単位: 5 分
print(f"ラグ (5 分単位): {lag}, つまり {lag * 5} 分")
```

#### H8 (v3 専用): 神奈川車混在の影響

Real02 (`img2.analysis_disabled: true`) を分析対象外とした影響を測る。stall4
(Real02 右上 8 台) と stall1-3 (Real01) の挙動が時間帯ごとに大きく違う場合、
神奈川車の影響が stall4 にも漏れている可能性がある。

```python
corr_T2 = v3[['stall3_occ', 'stall4_occ']].corr().iloc[0, 1]
print(f"stall3 vs stall4 (T2 内) 相関: {corr_T2:.3f}")
# 期待: > 0.5 (T2 客が両方の乗り場を使うので連動)
# < 0.2 → stall4 が神奈川車に汚染されている可能性
```

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

**実運用上の終了日**: `2026-05-31 23:59 JST`。`scripts/observe-tick-local.sh` の `STOP_DATE=2026-06-01` ガードにより 6/1 00:00 JST 以降の tick は自動 skip される。完全停止は手動 `./scripts/install-observe-launchd.sh uninstall`。

### schema_version=2 への移行検証 (実装直後 24 時間)

```bash
# 24 時間経過後に
git pull origin main
jq -r '.schema_version' data/taxi-pool-history.jsonl | sort | uniq -c
# 期待: v1=118 (旧)、v2 が 24 行以上 (Mac mini 稼働率による)

# v2 の edge_density 分布
jq -r 'select(.schema_version==2) | "\(.ts) \(.img1.roi.edge_density) \(.img1.roi.luminance_mean)"' data/taxi-pool-history.jsonl | head -30
# 期待: edge_density が 0.0〜1.0 内、夜間も日中もそれぞれの値域に分散

# arrivals_window が時間帯ごとに動いているか
jq -r 'select(.schema_version==2) | "\(.ts) \(.arrivals_window.estimated_taxi_pax_sum)"' data/taxi-pool-history.jsonl | head -30
# 期待: 時間帯で 0 〜 数百の値が変動、14,000 で定数化していない
```

### schema_version=3 への移行検証 (実装直後 24 時間)

```bash
# 24 時間経過後に
git pull origin main
jq -r '.schema_version' data/taxi-pool-history.jsonl | sort | uniq -c
# 期待: v1=121, v2=数十, v3=200+ (5 分間隔 × 24h = 288 が理想)

# stall ごとの occupied_estimate 分布
jq -r 'select(.schema_version==3) | "\(.ts) s1=\(.stalls.stall1.occupied_estimate) s2=\(.stalls.stall2.occupied_estimate) s3=\(.stalls.stall3.occupied_estimate) s4=\(.stalls.stall4.occupied_estimate)"' data/taxi-pool-history.jsonl | head -30
# 期待: 各 stall で 0-capacity の範囲で時間帯ごとに変動

# 出庫検出 (diff が負の tick)
jq -r 'select(.schema_version==3 and .stalls.stall1.diff_occupied_from_prev < 0) | "\(.ts) stall1: \(.stalls.stall1.diff_occupied_from_prev)"' data/taxi-pool-history.jsonl | head -20
```

注意: v3 の stall ROI は暫定値のため `occupied_estimate` がノイズ気味になる可能性あり。spec v4 の駐車枠ベース検出が完成した時点で再評価する。
