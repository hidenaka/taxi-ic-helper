# Phase A 中間分析 設計

- 日付: 2026-05-14
- 対象: 乗務地図関係 / `data/taxi-pool-history.jsonl`
- フェーズ: Phase A (観測) の中間スナップショット分析
- 観測継続: 2026-05-31 23:59 JST まで本観測は止めない

## 背景

Mac mini で 2026-05-11 から 5 分間隔の観測が走っており、5/14 21:07 JST 時点で jsonl は 739 行 (schema 混在)。本来の Phase B 分析は 5/31 観測終了後に実施するが、その前に **中間スナップショット**を取って次の 2 つの目的に当てる:

1. **5/31 本分析の準備**: どの集計が見えそうか、サンプル不足はどこか、データ品質課題は何かを事前に判定
2. **ROI v4 設計の足がかり**: 現 ROI (v3 暫定) の限界を可視化し、特に夜間問題への対策方針 (行燈ピクセルカウント方式) の予備妥当性を取る

## ゴール

1. データ品質の現状を構造化された数値で出す (schema 分布 / tick_seq 欠損 / ts 逆行 / 夜間飽和率 / ROI 健全性)
2. 仮説 H1 (ピーク時刻一致) / H6 (T1/T2 出庫 × arrivals_window) / H8 (stall3 vs stall4 相関) の**暫定傾向**を取る
3. 仮説 H9 (新規・夜間代理指標) として、`luminance_std` と `edge_density` が夜間タクシー存在のシグナルになり得るかを調査
4. 5/31 本分析で追加すべき集計項目と、ROI v4 (駐車枠ベース検出 + 夜間行燈カウント) の設計提言を出す

## 非ゴール

- 観測パイプライン (`scripts/observe-taxi-pool.mjs` 等) の改修
- 観測ジョブの停止・再起動
- `data/taxi-pool-history.jsonl` の編集・削除
- ROI 座標の変更 (Phase A 中は凍結、v4 設計は別 spec)
- 仮説 H2/H3/H4/H5/H7 の検証 (サンプル不足 or 夜間問題で 5/31 へ後送り)
- `feature/pax-observation-loopback` ブランチへの干渉 (別 Claude が作業中)
- 画像本体 (Mac mini ローカル `~/Library/Application Support/taxi-ic-helper/images/`) へのアクセス (MacBook 側からは触れない)

## アーキテクチャ

### 不変点

| ファイル | 状態 |
|---|---|
| `scripts/` 配下すべて | 不変 |
| `data/taxi-pool-history.jsonl` | 読み込みのみ、書き込み・削除しない |
| launchd 設定 / plist | 不変 |
| `feature/pax-observation-loopback` ブランチ | 不変 |

### 新規・変更ファイル

| パス | 種別 | 役割 |
|---|---|---|
| `docs/superpowers/specs/2026-05-14-phase-a-mid-analysis-design.md` | Create | 本 spec |
| `docs/research/scripts/phase-a-mid-analysis.py` | Create | 分析スクリプト (再現性のため commit、5/31 で発展利用) |
| `docs/research/figures/2026-05-14/*.png` | Create | グラフ 7 枚 |
| `docs/research/taxi-pool-mid-analysis-2026-05-14.md` | Create | 分析レポート本体 |
| `~/.venvs/taxi-ic-phase-a/` | Create | Python 仮想環境 (リポジトリ外、5/31 で再利用) |

## レポート章構成

レポート (`docs/research/taxi-pool-mid-analysis-2026-05-14.md`) は以下の 7 章で構成:

### 1. 要約
1 段落 + 3 文結論。冒頭で「3.5 日分 (v3 期間実質 2.5 日) のためサンプル不足、傾向のヒントとして扱う」を明記。

### 2. データ品質チェック
- schema 分布 (v1/v2/v3 の行数)
- tick_seq 連続性 (欠損集計、長期欠損の期間)
- ts 逆行行の特定 (ユーザー報告の seq 121→122 影響範囲、それ以外に逆行があるか)
- 夜間飽和率 (luminance_mean < 30 の tick で全 stall = capacity になっている率)
- ROI 健全性 (各 stall の `occupied_estimate` 分布、capacity に張り付いている時間帯比率)
- img2.analysis_disabled の影響 (Real02 由来 stall4 のシグナル損失率)
- **信頼サブセット**の定義と行数: `schema_version=3 ∧ luminance_mean >= 30 ∧ ts 順序正常`

### 3. H1: 予測ピーク時刻と実プール変化のラグ (暫定)
- 日次で `arrivals_window.estimated_taxi_pax_sum` ピーク時刻と stall1+2+3 合計の `diff_occupied` 最大負値時刻を比較
- サンプル: 5/13 + 5/14 の 2 日分、信頼サブセット限定
- 結論は「ヒント」表記、n= 明記

### 4. H6: T1/T2 出庫量 × arrivals_window 相関
- 時間帯バケット (1 時間粒度) で集計
- Pearson 相関係数 + 散布図
- 信頼サブセットで算出

### 5. H8: stall3 vs stall4 相関 (神奈川車混在の影響)
- 単純な Pearson 相関 (`occupied_estimate` ベース、`diff_occupied_from_prev` ベース両方)
- 解釈: > 0.5 = 連動 (T2 共有)、< 0.2 = 汚染疑い (神奈川車が stall4 に漏れている)

### 6. H9: 夜間代理指標 (行燈方式の予備妥当性)
**新規追加**。夜間 (luminance_mean < 30) で `luminance_std` と `edge_density` が「タクシー実在のシグナル」として動いているかを調査。

- 夜間 tick の `luminance_std` 分布 (高ければ局所明点があるサイン)
- 夜間 tick の `edge_density` 分布 (行燈周辺のエッジ密度)
- 昼間 tick (luminance_mean >= 60) の同指標と比較
- 各 stall の `luminance_std` / `edge_density` の夜間相関 (stall1〜4 が独立に動いているか)

期待される所見:
- 夜間 `luminance_std` > 昼間平均 → 局所明点 (= 行燈) が存在
- 夜間 `edge_density` も比較的高い → タクシー実在
- これらが arrivals_window と弱くでも相関 → 行燈ピクセルカウントが Phase B で有効な可能性

### 7. 5/31 本分析で追加すべき項目 + ROI v4 設計提言

**追加すべき集計** (5-8 項目想定):
- H2 (予測スケールと出庫量の整合) を 14 日サンプルで本格化
- H3 (雨天での予測ずれ) を雨天日が含まれるサンプルで
- H4 (深夜帯ラッシュ) を夜間問題が解決された ROI v4 データで
- H7 (ピーク → 出庫ラグ) を cross-correlation で本格化
- 曜日効果 (平日 vs 土日)
- ROI v3 と v4 の比較分析 (v4 が動いていれば)

**ROI v4 設計提言** (本中間分析の最重要アウトプット):
- **昼間**: 駐車枠ベース検出 (車両 1 台 1 ROI、現 stall1-3 の「縦列まとめて 8 台」を解体)
- **夜間**: 行燈ピクセルカウント方式
  - HSV 範囲: 行燈の典型色 (LED 白〜淡黄、明度高、彩度中-低) を絞り込み
  - 局所明点検出: max luminance ベース、ヘッドライト・テールライト・信号機との区別
  - カウント: 連結成分ラベリングで「行燈 1 つ = タクシー 1 台」
  - 検証パス: 昼間データで行燈方式と既存 occupied_estimate の整合性確認
- **昼夜ハイブリッド**: luminance_mean で昼夜判定、夜は行燈方式に切替

## 信頼サブセットの定義 (確定)

以下すべてを満たす tick を「信頼サブセット」とする:

1. `schema_version == 3`
2. ROI 由来 `img1.roi.luminance_mean >= 30` (夜間問題回避)
3. `ts` が単調増加 (前 tick より進んでいる)
4. `stalls != null` (stall-rois 読み込み失敗で null になっていない)

このサブセットでだけ仮説検証を行う。サブセット外は別途集計 (品質チェックで件数を示すのみ)。

## データフロー

```
[git pull origin main]
  → jsonl 読込 (pandas.read_json lines=True)
    → schema_version でラベル付け
      → ts 逆行検出 (前行と diff)
        → 信頼サブセット定義 (上記4条件)
          → 品質メトリクス計算 → fig 01-04
          → H1/H6/H8/H9 計算 → fig 05-07
            → markdown レポート組み立て
              → git pull --rebase (commit 直前、観測 push と衝突回避)
                → git add docs/research/{scripts,figures/2026-05-14,...}.md + spec
                → git commit
                  → git push origin main (race retry 3回)
```

## エラーハンドリング・前提

| 事象 | 対応 |
|---|---|
| pandas / matplotlib 未導入 | venv (`~/.venvs/taxi-ic-phase-a/`) を作成し `pip install pandas matplotlib` |
| jsonl 読込で KeyError | 列を取り出す前に schema_version でフィルタ、ネストフィールドは `get_nested` ヘルパで防御 |
| 観測ジョブが同時に jsonl 追記 | 読み込み時点のスナップショットで分析、増分は次回分析の対象。commit 前に必ず `git pull --rebase --autostash` |
| push race | 3 回まで `pull --rebase → push` リトライ |
| ts 逆行が多発 | 品質チェック節で件数を示し、信頼サブセットから除外 |
| 信頼サブセットが少なすぎる (< 100 行) | レポート冒頭で「サンプル不足、5/31 まで再開」と明記して止める |

## テスト・検証

- 分析スクリプトは観測ジョブと完全独立 (read-only)、観測パイプラインへの影響なし
- まず schema 分布を目視 (v1=121, v2=~14, v3=~600+ を期待)
- 信頼サブセット行数が 100 を超えるか確認
- 各仮説のグラフが「n= 表示あり」「ヒント表記あり」「信頼区間は描かない」を守る

## 完了条件

- [ ] `docs/research/scripts/phase-a-mid-analysis.py` を実装、`~/.venvs/taxi-ic-phase-a/` で実行できる
- [ ] `docs/research/figures/2026-05-14/` に 7 枚の png が生成される
- [ ] `docs/research/taxi-pool-mid-analysis-2026-05-14.md` に 7 章すべてが書かれている
- [ ] 「3.5 日分 (v3 期間実質 2.5 日) のためサンプル不足、傾向のヒントとして扱う」が冒頭・各章・結論で明記されている
- [ ] スコープ外ファイル (`scripts/`, `data/*.jsonl`, launchd plist, feature ブランチ) は触っていない
- [ ] commit メッセージは `docs(research): Phase A 中間分析 (2026-05-14 時点, ~700 tick)`
- [ ] main へ push 成功

## スコープ外 (再掲・厳守)

- `scripts/` 配下のコード (観測パイプライン、Mac mini で稼働中)
- `data/taxi-pool-history.jsonl` の編集 (read-only)
- `feature/pax-observation-loopback` ブランチ
- launchd plist / install スクリプト
- 観測ジョブの停止・再起動・ROI 調整
- 行燈方式の実装 (今回は提言まで、Mac mini 側の別セッションで実画像検証 → ROI v4 spec へ)
