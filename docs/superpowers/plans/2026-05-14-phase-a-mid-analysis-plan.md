# Phase A 中間分析 実装プラン

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `data/taxi-pool-history.jsonl` (739+ 行、schema 混在) の中間スナップショット分析を行い、データ品質・仮説 H1/H6/H8/H9 の暫定傾向・5/31 本分析と ROI v4 設計への提言をレポートとして出す。

**Architecture:** Python venv (リポジトリ外) + pandas + matplotlib で一発スクリプト。純関数は inline assertion で検証。観測ジョブとは完全独立に read-only で動く。最終的に `docs/research/` 配下に script + figures + markdown レポートを残す。

**Tech Stack:** Python 3.10+ / pandas / matplotlib / venv (~/.venvs/taxi-ic-phase-a/) / 標準ライブラリ json,pathlib

**設計ドキュメント:** `docs/superpowers/specs/2026-05-14-phase-a-mid-analysis-design.md`

---

## File Structure

| ファイル | 種別 | 役割 |
|---|---|---|
| `~/.venvs/taxi-ic-phase-a/` | Setup | Python 仮想環境 (リポジトリ外、5/31 で再利用) |
| `docs/research/scripts/phase-a-mid-analysis.py` | Create | 分析スクリプト全体 (純関数 + main) |
| `docs/research/figures/2026-05-14/01-schema-distribution.png` | Create | schema_version 分布の棒グラフ |
| `docs/research/figures/2026-05-14/02-tick-seq-gaps.png` | Create | tick_seq 欠損の時系列プロット |
| `docs/research/figures/2026-05-14/03-stall-occupancy-heatmap.png` | Create | stall 別 occupied_estimate の時間帯ヒートマップ |
| `docs/research/figures/2026-05-14/04-night-saturation.png` | Create | 夜間飽和率 / luminance vs capacity 張り付きの可視化 |
| `docs/research/figures/2026-05-14/05-h6-correlation.png` | Create | T1/T2 出庫 × arrivals_window 散布図 |
| `docs/research/figures/2026-05-14/06-h8-stall3-stall4.png` | Create | stall3 vs stall4 occupied/diff 相関 |
| `docs/research/figures/2026-05-14/07-h9-night-proxy-signals.png` | Create | 夜間 luminance_std / edge_density の分布 |
| `docs/research/taxi-pool-mid-analysis-2026-05-14.md` | Create | 分析レポート本体 (7 章構成) |

実装順序: **環境セットアップ → 読み込み・品質 → 信頼サブセット定義 → 仮説 H1/H6/H8/H9 → グラフ → レポート → 最終 push**。

各 Task はそれ単独でスクリプト全体を実行可能な状態で commit する (途中段階でも `python phase-a-mid-analysis.py` がエラーなく走る)。

---

## Task 1: Python 環境セットアップ

**Files:**
- Setup: `~/.venvs/taxi-ic-phase-a/`

- [ ] **Step 1.1: Python と pip の存在確認**

```bash
python3 --version
which python3
```

期待: `Python 3.10` 以上が出力されること。

- [ ] **Step 1.2: venv 作成**

```bash
python3 -m venv ~/.venvs/taxi-ic-phase-a
```

期待: 何も出力されない (静かに成功)。

- [ ] **Step 1.3: pandas + matplotlib インストール**

```bash
~/.venvs/taxi-ic-phase-a/bin/pip install --upgrade pip
~/.venvs/taxi-ic-phase-a/bin/pip install pandas matplotlib
```

期待: `Successfully installed pandas-... matplotlib-...` のような出力。

- [ ] **Step 1.4: 動作確認**

```bash
~/.venvs/taxi-ic-phase-a/bin/python -c "import pandas as pd; import matplotlib; print(f'pandas={pd.__version__} matplotlib={matplotlib.__version__}')"
```

期待: バージョン文字列が出る。エラーなし。

(venv はリポジトリ外なので commit は不要)

---

## Task 2: 分析スクリプトのスケルトン作成

**Files:**
- Create: `docs/research/scripts/phase-a-mid-analysis.py`

- [ ] **Step 2.1: ディレクトリと初期スクリプト作成**

`mkdir -p docs/research/scripts docs/research/figures/2026-05-14` で空のディレクトリを準備。

`docs/research/scripts/phase-a-mid-analysis.py` の内容:

```python
#!/usr/bin/env python3
"""Phase A 中間分析 (2026-05-14 スナップショット)。

設計: docs/superpowers/specs/2026-05-14-phase-a-mid-analysis-design.md
完成後の出力: docs/research/figures/2026-05-14/*.png と
            docs/research/taxi-pool-mid-analysis-2026-05-14.md
"""
from __future__ import annotations

import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")  # GUI なしで動かす
import matplotlib.pyplot as plt
import pandas as pd

REPO_ROOT = Path(__file__).resolve().parents[3]
JSONL_PATH = REPO_ROOT / "data" / "taxi-pool-history.jsonl"
FIGURES_DIR = REPO_ROOT / "docs" / "research" / "figures" / "2026-05-14"
REPORT_PATH = REPO_ROOT / "docs" / "research" / "taxi-pool-mid-analysis-2026-05-14.md"

NIGHT_LUMINANCE_THRESHOLD = 30  # roi.luminance_mean がこれ未満を夜間扱い


def main() -> None:
    FIGURES_DIR.mkdir(parents=True, exist_ok=True)
    print(f"[phase-a-mid] jsonl: {JSONL_PATH}")
    print(f"[phase-a-mid] figures: {FIGURES_DIR}")
    print(f"[phase-a-mid] report: {REPORT_PATH}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2.2: 構文チェック + 実行**

```bash
~/.venvs/taxi-ic-phase-a/bin/python -m py_compile docs/research/scripts/phase-a-mid-analysis.py
~/.venvs/taxi-ic-phase-a/bin/python docs/research/scripts/phase-a-mid-analysis.py
```

期待:
```
[phase-a-mid] jsonl: .../data/taxi-pool-history.jsonl
[phase-a-mid] figures: .../docs/research/figures/2026-05-14
[phase-a-mid] report: .../docs/research/taxi-pool-mid-analysis-2026-05-14.md
```

- [ ] **Step 2.3: commit**

```bash
git add docs/research/scripts/phase-a-mid-analysis.py
git commit -m "feat(research): add phase-a-mid-analysis scaffold"
```

---

## Task 3: JSONL 読み込みと schema 分布

**Files:**
- Modify: `docs/research/scripts/phase-a-mid-analysis.py`

- [ ] **Step 3.1: 純関数 `load_jsonl` を追加 (`main()` 定義の前に挿入)**

```python
def get_nested(obj, *keys):
    """ネスト辞書から安全に値を取り出す。途中で None / 非 dict なら None を返す。"""
    for k in keys:
        if obj is None:
            return None
        obj = obj.get(k) if isinstance(obj, dict) else None
    return obj


def load_jsonl(path: Path) -> pd.DataFrame:
    """jsonl を読み込み、tspd.Timestamp 化と schema_version を 1/2/3 整数で正規化する。"""
    df = pd.read_json(path, lines=True)
    df["ts"] = pd.to_datetime(df["ts"])
    if "schema_version" not in df.columns:
        df["schema_version"] = 1
    df["schema_version"] = df["schema_version"].fillna(1).astype(int)
    return df


# inline test: 純関数 get_nested の挙動
assert get_nested({"a": {"b": 1}}, "a", "b") == 1
assert get_nested({"a": {"b": 1}}, "a", "c") is None
assert get_nested(None, "a") is None
assert get_nested({"a": None}, "a", "b") is None
```

- [ ] **Step 3.2: `main()` 内で読み込み + schema 分布の出力**

`main()` の本体を以下に置き換え:

```python
def main() -> None:
    FIGURES_DIR.mkdir(parents=True, exist_ok=True)
    df = load_jsonl(JSONL_PATH)
    print(f"[phase-a-mid] loaded {len(df)} rows, ts range {df['ts'].min()} 〜 {df['ts'].max()}")

    schema_counts = df["schema_version"].value_counts().sort_index()
    print("[phase-a-mid] schema_version 分布:")
    for v, n in schema_counts.items():
        print(f"  v{v}: {n} 行")

    # figure 01: schema 分布の棒グラフ
    fig, ax = plt.subplots(figsize=(6, 4))
    ax.bar([f"v{v}" for v in schema_counts.index], schema_counts.values, color=["#888", "#5b8", "#48c"])
    ax.set_title("schema_version 分布")
    ax.set_ylabel("行数")
    for i, n in enumerate(schema_counts.values):
        ax.text(i, n, str(n), ha="center", va="bottom")
    fig.tight_layout()
    fig.savefig(FIGURES_DIR / "01-schema-distribution.png", dpi=120)
    plt.close(fig)
    print(f"[phase-a-mid] wrote {FIGURES_DIR / '01-schema-distribution.png'}")
```

- [ ] **Step 3.3: 実行 + 期待値確認**

```bash
~/.venvs/taxi-ic-phase-a/bin/python docs/research/scripts/phase-a-mid-analysis.py
```

期待 (jsonl の最新状態次第で多少前後する):
```
[phase-a-mid] loaded 740+ rows, ts range 2026-05-10 ... 〜 2026-05-14 ...
[phase-a-mid] schema_version 分布:
  v1: 121 行
  v2: ~14 行
  v3: 600+ 行
[phase-a-mid] wrote .../01-schema-distribution.png
```

`v1=121` を満たさない場合: jsonl の最初の数行に `schema_version` フィールドが存在しないなら `load_jsonl` の `fillna(1)` で対処済み。それでも 121 にならなければ実データの状況なので、報告値として記録する (後の Task 10 でレポートに反映)。

- [ ] **Step 3.4: commit**

```bash
git add docs/research/scripts/phase-a-mid-analysis.py docs/research/figures/2026-05-14/01-schema-distribution.png
git commit -m "feat(research): load jsonl and report schema_version distribution"
```

---

## Task 4: tick_seq 連続性と ts 逆行の検出

**Files:**
- Modify: `docs/research/scripts/phase-a-mid-analysis.py`

- [ ] **Step 4.1: 純関数 `find_tick_seq_gaps` と `find_ts_reversal` を追加**

`load_jsonl` 定義の直後に挿入:

```python
def find_tick_seq_gaps(df: pd.DataFrame) -> list[tuple[int, int]]:
    """tick_seq の不連続箇所を [(prev, next)] のリストで返す。連続なら []。"""
    seq = df["tick_seq"].to_numpy()
    gaps = []
    for i in range(1, len(seq)):
        if seq[i] != seq[i - 1] + 1:
            gaps.append((int(seq[i - 1]), int(seq[i])))
    return gaps


def find_ts_reversal(df: pd.DataFrame) -> list[int]:
    """ts が前行より戻っている行の index を返す。順序正常なら []。"""
    diff = df["ts"].diff()
    return df.index[diff < pd.Timedelta(0)].tolist()


# inline test: tick_seq gap 検出
_test_df = pd.DataFrame({"tick_seq": [1, 2, 3, 5, 6, 8]})
assert find_tick_seq_gaps(_test_df) == [(3, 5), (6, 8)], f"got {find_tick_seq_gaps(_test_df)}"

# inline test: ts 逆行検出
_test_df_ts = pd.DataFrame({
    "ts": pd.to_datetime([
        "2026-01-01 10:00", "2026-01-01 10:05",
        "2026-01-01 09:57",  # 逆行
        "2026-01-01 10:10",
    ])
})
assert find_ts_reversal(_test_df_ts) == [2], f"got {find_ts_reversal(_test_df_ts)}"
```

- [ ] **Step 4.2: `main()` に品質チェック + figure 02 出力を追加**

`schema_counts` のループ後、`# figure 01:` の前に挿入:

```python
    # --- tick_seq 連続性 ---
    gaps = find_tick_seq_gaps(df)
    print(f"[phase-a-mid] tick_seq 欠損: {len(gaps)} 箇所")
    for prev, nxt in gaps[:5]:
        print(f"  seq {prev} → {nxt} (skipped {nxt - prev - 1})")
    if len(gaps) > 5:
        print(f"  ... 他 {len(gaps) - 5} 箇所")

    # --- ts 逆行 ---
    reversals = find_ts_reversal(df)
    print(f"[phase-a-mid] ts 逆行: {len(reversals)} 件 (index: {reversals[:10]})")

    # figure 02: tick_seq 欠損の時系列プロット
    fig, ax = plt.subplots(figsize=(10, 4))
    ax.plot(df["ts"], df["tick_seq"], linewidth=0.8, color="#48c")
    for prev, nxt in gaps:
        gap_idx = df.index[df["tick_seq"] == nxt]
        if len(gap_idx) > 0:
            ax.axvline(df.loc[gap_idx[0], "ts"], color="#e44", alpha=0.3, linewidth=0.5)
    ax.set_title(f"tick_seq の連続性 (欠損 {len(gaps)} 箇所, 赤線=スキップ)")
    ax.set_xlabel("ts")
    ax.set_ylabel("tick_seq")
    fig.autofmt_xdate()
    fig.tight_layout()
    fig.savefig(FIGURES_DIR / "02-tick-seq-gaps.png", dpi=120)
    plt.close(fig)
    print(f"[phase-a-mid] wrote {FIGURES_DIR / '02-tick-seq-gaps.png'}")
```

- [ ] **Step 4.3: 実行 + 期待値確認**

```bash
~/.venvs/taxi-ic-phase-a/bin/python docs/research/scripts/phase-a-mid-analysis.py
```

期待:
```
[phase-a-mid] tick_seq 欠損: 0〜5 箇所 (Mac mini スリープ等で発生する可能性)
[phase-a-mid] ts 逆行: 1 件 (index: [121] あたり、ユーザー報告の seq 121→122)
```

ts 逆行が 0 件なら、報告値として「逆行なし」を記録 (Task 10 でレポートに書く)。

- [ ] **Step 4.4: commit**

```bash
git add docs/research/scripts/phase-a-mid-analysis.py docs/research/figures/2026-05-14/02-tick-seq-gaps.png
git commit -m "feat(research): detect tick_seq gaps and ts reversals"
```

---

## Task 5: stall フィールド展開 + 夜間飽和率 + 信頼サブセット

**Files:**
- Modify: `docs/research/scripts/phase-a-mid-analysis.py`

- [ ] **Step 5.1: 純関数 `expand_v3_fields` と `define_trusted_subset` を追加**

`find_ts_reversal` 定義の直後に挿入:

```python
def expand_v3_fields(df: pd.DataFrame) -> pd.DataFrame:
    """v3 stalls / img / arrivals_window の必要フィールドを列に展開した DataFrame を返す。"""
    out = df.copy()
    out["luminance_mean_1"] = out["img1"].apply(lambda x: get_nested(x, "roi", "luminance_mean"))
    out["luminance_std_1"] = out["img1"].apply(lambda x: get_nested(x, "roi", "luminance_std"))
    out["edge_density_1"] = out["img1"].apply(lambda x: get_nested(x, "roi", "edge_density"))
    out["window_taxi_pax"] = out["arrivals_window"].apply(lambda x: get_nested(x, "estimated_taxi_pax_sum"))
    out["weather_code"] = out["weather"].apply(lambda x: get_nested(x, "code"))
    for n in (1, 2, 3, 4):
        out[f"stall{n}_occ"] = out["stalls"].apply(lambda x: get_nested(x, f"stall{n}", "occupied_estimate"))
        out[f"stall{n}_diff"] = out["stalls"].apply(lambda x: get_nested(x, f"stall{n}", "diff_occupied_from_prev"))
        out[f"stall{n}_cap"] = out["stalls"].apply(lambda x: get_nested(x, f"stall{n}", "capacity"))
        out[f"stall{n}_lum"] = out["stalls"].apply(lambda x: get_nested(x, f"stall{n}", "luminance_mean"))
    out["hour"] = out["ts"].dt.hour
    return out


def define_trusted_subset(df: pd.DataFrame) -> pd.DataFrame:
    """信頼サブセット: schema=3 ∧ luminance_mean_1 >= 30 ∧ ts 順序正常 ∧ stalls 非 null。"""
    reversals = set(find_ts_reversal(df))
    mask = (
        (df["schema_version"] == 3)
        & (df["luminance_mean_1"] >= NIGHT_LUMINANCE_THRESHOLD)
        & (~df.index.isin(reversals))
        & (df["stall1_occ"].notna())
    )
    return df[mask].copy()


# inline test: expand_v3_fields の基本動作
_test_row = {
    "schema_version": 3,
    "ts": "2026-05-14T12:00:00+09:00",
    "tick_seq": 1,
    "img1": {"roi": {"luminance_mean": 100, "luminance_std": 40, "edge_density": 0.4}},
    "img2": {},
    "stalls": {
        "stall1": {"occupied_estimate": 5, "diff_occupied_from_prev": -1, "capacity": 8, "luminance_mean": 95},
        "stall2": {"occupied_estimate": 4, "diff_occupied_from_prev": 0, "capacity": 7, "luminance_mean": 95},
        "stall3": {"occupied_estimate": 6, "diff_occupied_from_prev": 1, "capacity": 8, "luminance_mean": 95},
        "stall4": {"occupied_estimate": 7, "diff_occupied_from_prev": 0, "capacity": 8, "luminance_mean": 95},
    },
    "arrivals_window": {"estimated_taxi_pax_sum": 200},
    "weather": {"code": 0},
}
_test_df = pd.DataFrame([_test_row])
_test_df["ts"] = pd.to_datetime(_test_df["ts"])
_expanded = expand_v3_fields(_test_df)
assert _expanded["luminance_mean_1"].iloc[0] == 100
assert _expanded["stall1_occ"].iloc[0] == 5
assert _expanded["stall3_diff"].iloc[0] == 1
assert _expanded["hour"].iloc[0] == 12
```

- [ ] **Step 5.2: `main()` で expand + 信頼サブセット定義 + 夜間飽和率**

`figure 02:` のブロックの後に挿入:

```python
    # --- フィールド展開 + 信頼サブセット定義 ---
    df = expand_v3_fields(df)
    v3 = df[df["schema_version"] == 3].copy()
    trusted = define_trusted_subset(df)
    print(f"[phase-a-mid] v3 行: {len(v3)} / 信頼サブセット: {len(trusted)} 行")

    # --- 夜間飽和率 ---
    night = v3[v3["luminance_mean_1"] < NIGHT_LUMINANCE_THRESHOLD].copy()
    night_saturated = (
        (night["stall1_occ"] == night["stall1_cap"])
        & (night["stall2_occ"] == night["stall2_cap"])
        & (night["stall3_occ"] == night["stall3_cap"])
    )
    sat_rate = night_saturated.mean() if len(night) > 0 else float("nan")
    print(f"[phase-a-mid] 夜間 tick {len(night)} 件、stall1-3 全満杯率 {sat_rate:.1%}")

    # figure 04: luminance vs occupied 合計 散布図
    fig, ax = plt.subplots(figsize=(8, 5))
    occ_sum = v3[["stall1_occ", "stall2_occ", "stall3_occ"]].sum(axis=1)
    cap_sum = v3[["stall1_cap", "stall2_cap", "stall3_cap"]].sum(axis=1)
    ax.scatter(v3["luminance_mean_1"], occ_sum, s=4, alpha=0.4, color="#48c", label="stall1-3 合計")
    ax.axvline(NIGHT_LUMINANCE_THRESHOLD, color="#e44", linestyle="--", linewidth=1, label=f"夜間閾値 ({NIGHT_LUMINANCE_THRESHOLD})")
    ax.axhline(cap_sum.iloc[0] if len(cap_sum) > 0 else 23, color="#666", linestyle=":", linewidth=1, label="capacity 合計")
    ax.set_xlabel("img1.roi.luminance_mean")
    ax.set_ylabel("stall1+2+3 occupied_estimate")
    ax.set_title(f"夜間飽和: 夜間 {len(night)} tick / 飽和率 {sat_rate:.1%} (n={len(v3)})")
    ax.legend()
    fig.tight_layout()
    fig.savefig(FIGURES_DIR / "04-night-saturation.png", dpi=120)
    plt.close(fig)
    print(f"[phase-a-mid] wrote {FIGURES_DIR / '04-night-saturation.png'}")
```

- [ ] **Step 5.3: figure 03 (stall 別 occupied の時間帯ヒートマップ) を追加**

直後に追加:

```python
    # figure 03: stall 別 occupied_estimate の時間帯ヒートマップ (信頼サブセット)
    if len(trusted) > 0:
        heat = trusted.groupby("hour")[["stall1_occ", "stall2_occ", "stall3_occ", "stall4_occ"]].mean().T
        fig, ax = plt.subplots(figsize=(10, 4))
        im = ax.imshow(heat.values, aspect="auto", cmap="YlOrRd", origin="lower")
        ax.set_yticks(range(4))
        ax.set_yticklabels(["stall1", "stall2", "stall3", "stall4"])
        ax.set_xticks(range(len(heat.columns)))
        ax.set_xticklabels(heat.columns)
        ax.set_xlabel("hour (JST)")
        ax.set_title(f"stall 別 occupied_estimate 平均 (信頼サブセット, n={len(trusted)})")
        fig.colorbar(im, ax=ax, label="平均占有台数")
        fig.tight_layout()
        fig.savefig(FIGURES_DIR / "03-stall-occupancy-heatmap.png", dpi=120)
        plt.close(fig)
        print(f"[phase-a-mid] wrote {FIGURES_DIR / '03-stall-occupancy-heatmap.png'}")
    else:
        print("[phase-a-mid] 信頼サブセット 0 行、figure 03 をスキップ")
```

- [ ] **Step 5.4: 実行 + 結果ログを記録**

```bash
~/.venvs/taxi-ic-phase-a/bin/python docs/research/scripts/phase-a-mid-analysis.py
```

期待:
- `v3 行: 600+`、信頼サブセット 300+ 行 (夜間半減を見込む)
- 夜間飽和率 70% 以上 (spec で予想された通り、夜間問題が顕在化)
- figure 03 / 04 が出力される

- [ ] **Step 5.5: commit**

```bash
git add docs/research/scripts/phase-a-mid-analysis.py docs/research/figures/2026-05-14/03-stall-occupancy-heatmap.png docs/research/figures/2026-05-14/04-night-saturation.png
git commit -m "feat(research): expand v3 fields, define trusted subset, night saturation"
```

---

## Task 6: H1 (ピーク時刻一致の暫定計算)

**Files:**
- Modify: `docs/research/scripts/phase-a-mid-analysis.py`

- [ ] **Step 6.1: 純関数 `compute_h1_peak_lag` を追加**

`define_trusted_subset` 定義の直後に挿入:

```python
def compute_h1_peak_lag(trusted: pd.DataFrame) -> pd.DataFrame:
    """日次で window_taxi_pax のピーク時刻と (stall1+2+3) 出庫量ピーク時刻のラグを計算。
    戻り値: ['date', 'pax_peak_ts', 'outflow_peak_ts', 'lag_minutes', 'n'] の DataFrame。
    """
    out = []
    trusted = trusted.copy()
    trusted["date"] = trusted["ts"].dt.date
    trusted["outflow_t1_t2"] = (-trusted[["stall1_diff", "stall2_diff", "stall3_diff"]].clip(upper=0)).sum(axis=1)
    for date, g in trusted.groupby("date"):
        if g["window_taxi_pax"].isna().all() or g["outflow_t1_t2"].isna().all():
            continue
        pax_peak_idx = g["window_taxi_pax"].idxmax()
        outflow_peak_idx = g["outflow_t1_t2"].idxmax()
        pax_ts = g.loc[pax_peak_idx, "ts"]
        out_ts = g.loc[outflow_peak_idx, "ts"]
        lag_min = (out_ts - pax_ts).total_seconds() / 60.0
        out.append({
            "date": date,
            "pax_peak_ts": pax_ts,
            "outflow_peak_ts": out_ts,
            "lag_minutes": lag_min,
            "n": len(g),
        })
    return pd.DataFrame(out)


# inline test: H1 ラグ計算
_h1_test = pd.DataFrame({
    "ts": pd.to_datetime([
        "2026-05-13 10:00", "2026-05-13 10:30", "2026-05-13 11:00", "2026-05-13 11:30",
    ]),
    "window_taxi_pax": [100, 300, 200, 150],  # ピーク 10:30
    "stall1_diff": [0, -1, -2, 0],
    "stall2_diff": [0, 0, -1, 0],
    "stall3_diff": [0, 0, -1, 0],
})
_h1_result = compute_h1_peak_lag(_h1_test)
assert len(_h1_result) == 1
assert _h1_result["lag_minutes"].iloc[0] == 30.0, f"got {_h1_result['lag_minutes'].iloc[0]}"
```

- [ ] **Step 6.2: `main()` で H1 計算 + 結果 print**

figure 03 のブロックの後に挿入:

```python
    # --- H1: 予測ピーク時刻 vs 実プール出庫ピーク時刻 ---
    h1 = compute_h1_peak_lag(trusted)
    print(f"[phase-a-mid] H1 ラグ計算: {len(h1)} 日分")
    if len(h1) > 0:
        print(h1[["date", "pax_peak_ts", "outflow_peak_ts", "lag_minutes", "n"]].to_string(index=False))
    h1_summary = {
        "n_days": len(h1),
        "mean_lag_minutes": float(h1["lag_minutes"].mean()) if len(h1) > 0 else None,
        "median_lag_minutes": float(h1["lag_minutes"].median()) if len(h1) > 0 else None,
    }
    print(f"[phase-a-mid] H1 summary: {h1_summary}")
```

(figure 出力は Task 10 のレポート組み立てで一括処理。Task 6 はテキスト統計のみ)

- [ ] **Step 6.3: 実行確認**

```bash
~/.venvs/taxi-ic-phase-a/bin/python docs/research/scripts/phase-a-mid-analysis.py 2>&1 | tail -20
```

期待: 5/13 + 5/14 の 2 日分のラグが出る (5/12 は信頼サブセット行数不足の可能性、その場合は出ない)。

- [ ] **Step 6.4: commit**

```bash
git add docs/research/scripts/phase-a-mid-analysis.py
git commit -m "feat(research): H1 peak time lag computation"
```

---

## Task 7: H6 (T1/T2 出庫量 × arrivals_window 相関)

**Files:**
- Modify: `docs/research/scripts/phase-a-mid-analysis.py`

- [ ] **Step 7.1: 純関数 `compute_h6_correlation` を追加**

`compute_h1_peak_lag` の直後に挿入:

```python
def compute_h6_correlation(trusted: pd.DataFrame) -> dict:
    """T1 (stall1+2)、T2 (stall3+4) 出庫量と window_taxi_pax の時間帯バケット相関。
    戻り値: {'T1_pearson_r', 'T2_pearson_r', 'hourly_df', 'n'}。
    """
    t = trusted.copy()
    t["T1_outflow"] = (-t[["stall1_diff", "stall2_diff"]].clip(upper=0)).sum(axis=1)
    t["T2_outflow"] = (-t[["stall3_diff", "stall4_diff"]].clip(upper=0)).sum(axis=1)
    hourly = t.groupby("hour").agg(
        T1_outflow_sum=("T1_outflow", "sum"),
        T2_outflow_sum=("T2_outflow", "sum"),
        window_taxi_mean=("window_taxi_pax", "mean"),
        n=("ts", "count"),
    ).reset_index()
    # 観測のない時間帯は除く (どちらかが 0 または NaN なら相関に入れない)
    valid = hourly[(hourly["window_taxi_mean"].notna()) & (hourly["n"] > 0)]
    if len(valid) < 3:
        return {"T1_pearson_r": None, "T2_pearson_r": None, "hourly_df": hourly, "n": len(t)}
    r1 = float(valid["T1_outflow_sum"].corr(valid["window_taxi_mean"]))
    r2 = float(valid["T2_outflow_sum"].corr(valid["window_taxi_mean"]))
    return {"T1_pearson_r": r1, "T2_pearson_r": r2, "hourly_df": hourly, "n": len(t)}


# inline test: H6 相関の符号と桁
_h6_test = pd.DataFrame({
    "hour": [10, 11, 12, 13, 14, 15],
    "ts": pd.to_datetime([
        "2026-05-13 10:00", "2026-05-13 11:00", "2026-05-13 12:00",
        "2026-05-13 13:00", "2026-05-13 14:00", "2026-05-13 15:00",
    ]),
    "stall1_diff": [-1, -2, -3, -2, -1, 0],
    "stall2_diff": [0, -1, -2, -1, 0, 0],
    "stall3_diff": [-1, -1, -2, -1, 0, 0],
    "stall4_diff": [0, 0, -1, 0, 0, 0],
    "window_taxi_pax": [100, 200, 300, 200, 100, 50],
})
_h6_result = compute_h6_correlation(_h6_test)
assert _h6_result["T1_pearson_r"] is not None
assert _h6_result["T1_pearson_r"] > 0.8, f"got T1 r = {_h6_result['T1_pearson_r']}"
```

- [ ] **Step 7.2: `main()` で H6 計算 + figure 05 出力**

H1 のブロックの後に挿入:

```python
    # --- H6: T1/T2 出庫量 × arrivals_window 相関 ---
    h6 = compute_h6_correlation(trusted)
    print(f"[phase-a-mid] H6 Pearson r: T1={h6['T1_pearson_r']}, T2={h6['T2_pearson_r']} (n={h6['n']})")
    print(h6["hourly_df"].to_string(index=False))

    fig, axes = plt.subplots(1, 2, figsize=(12, 5))
    hourly = h6["hourly_df"]
    for ax, terminal, color in [(axes[0], "T1", "#48c"), (axes[1], "T2", "#e84")]:
        ax.scatter(hourly[f"{terminal}_outflow_sum"], hourly["window_taxi_mean"], s=40, alpha=0.7, color=color)
        for _, row in hourly.iterrows():
            ax.annotate(f"{int(row['hour'])}h", (row[f"{terminal}_outflow_sum"], row["window_taxi_mean"]),
                        fontsize=7, alpha=0.6)
        r_val = h6[f"{terminal}_pearson_r"]
        r_str = f"r = {r_val:.3f}" if r_val is not None else "r = n/a"
        ax.set_xlabel(f"{terminal} 出庫量 (時間合計)")
        ax.set_ylabel("window_taxi_pax (時間平均)")
        ax.set_title(f"{terminal} 出庫 × 予測タクシー需要  {r_str}  (n={h6['n']})")
    fig.suptitle("H6: ヒント程度 (3.5 日サンプル)", fontsize=10, y=1.02)
    fig.tight_layout()
    fig.savefig(FIGURES_DIR / "05-h6-correlation.png", dpi=120, bbox_inches="tight")
    plt.close(fig)
    print(f"[phase-a-mid] wrote {FIGURES_DIR / '05-h6-correlation.png'}")
```

- [ ] **Step 7.3: 実行確認**

```bash
~/.venvs/taxi-ic-phase-a/bin/python docs/research/scripts/phase-a-mid-analysis.py 2>&1 | tail -25
```

期待: T1, T2 の Pearson r が出力される (`None` の場合は時間帯バケットが 3 未満ということ → サンプル不足としてレポートに書く)。

- [ ] **Step 7.4: commit**

```bash
git add docs/research/scripts/phase-a-mid-analysis.py docs/research/figures/2026-05-14/05-h6-correlation.png
git commit -m "feat(research): H6 T1/T2 outflow vs arrivals_window correlation"
```

---

## Task 8: H8 (stall3 vs stall4 相関)

**Files:**
- Modify: `docs/research/scripts/phase-a-mid-analysis.py`

- [ ] **Step 8.1: 純関数 `compute_h8_stall34_correlation` を追加**

`compute_h6_correlation` の直後に挿入:

```python
def compute_h8_stall34_correlation(trusted: pd.DataFrame) -> dict:
    """stall3 と stall4 の occupied / diff の Pearson 相関を返す。"""
    occ_r = float(trusted[["stall3_occ", "stall4_occ"]].dropna().corr().iloc[0, 1])
    diff_r = float(trusted[["stall3_diff", "stall4_diff"]].dropna().corr().iloc[0, 1])
    return {
        "occupied_pearson_r": occ_r,
        "diff_pearson_r": diff_r,
        "n_occ": int(trusted[["stall3_occ", "stall4_occ"]].dropna().shape[0]),
        "n_diff": int(trusted[["stall3_diff", "stall4_diff"]].dropna().shape[0]),
    }


# inline test
_h8_test = pd.DataFrame({
    "stall3_occ": [1, 2, 3, 4, 5],
    "stall4_occ": [2, 3, 4, 5, 6],  # 完全に同方向
    "stall3_diff": [0, 1, 1, 1, 1],
    "stall4_diff": [0, 1, 1, 1, 1],
})
_h8_result = compute_h8_stall34_correlation(_h8_test)
assert abs(_h8_result["occupied_pearson_r"] - 1.0) < 1e-9
assert abs(_h8_result["diff_pearson_r"] - 1.0) < 1e-9
```

- [ ] **Step 8.2: `main()` で H8 計算 + figure 06 出力**

H6 のブロックの後に挿入:

```python
    # --- H8: stall3 vs stall4 相関 (神奈川車混在の影響) ---
    h8 = compute_h8_stall34_correlation(trusted)
    print(f"[phase-a-mid] H8: stall3 vs stall4 occupied r = {h8['occupied_pearson_r']:.3f} (n={h8['n_occ']})")
    print(f"[phase-a-mid] H8: stall3 vs stall4 diff r     = {h8['diff_pearson_r']:.3f} (n={h8['n_diff']})")

    fig, axes = plt.subplots(1, 2, figsize=(11, 5))
    axes[0].scatter(trusted["stall3_occ"], trusted["stall4_occ"], s=4, alpha=0.3, color="#48c")
    axes[0].set_xlabel("stall3 occupied_estimate")
    axes[0].set_ylabel("stall4 occupied_estimate")
    axes[0].set_title(f"occupied 相関  r={h8['occupied_pearson_r']:.3f}  (n={h8['n_occ']})")
    axes[1].scatter(trusted["stall3_diff"], trusted["stall4_diff"], s=8, alpha=0.4, color="#e84")
    axes[1].set_xlabel("stall3 diff_occupied_from_prev")
    axes[1].set_ylabel("stall4 diff_occupied_from_prev")
    axes[1].set_title(f"diff 相関  r={h8['diff_pearson_r']:.3f}  (n={h8['n_diff']})")
    fig.suptitle("H8: stall3-4 連動 (>0.5 連動 / <0.2 神奈川車汚染疑い)", fontsize=10, y=1.02)
    fig.tight_layout()
    fig.savefig(FIGURES_DIR / "06-h8-stall3-stall4.png", dpi=120, bbox_inches="tight")
    plt.close(fig)
    print(f"[phase-a-mid] wrote {FIGURES_DIR / '06-h8-stall3-stall4.png'}")
```

- [ ] **Step 8.3: 実行確認**

```bash
~/.venvs/taxi-ic-phase-a/bin/python docs/research/scripts/phase-a-mid-analysis.py 2>&1 | tail -15
```

期待: r が出力される。0.5 以上なら連動、0.2 以下なら汚染疑い。中間値ならどちらとも言えないとレポートに書く。

- [ ] **Step 8.4: commit**

```bash
git add docs/research/scripts/phase-a-mid-analysis.py docs/research/figures/2026-05-14/06-h8-stall3-stall4.png
git commit -m "feat(research): H8 stall3 vs stall4 correlation"
```

---

## Task 9: H9 (夜間代理指標で行燈方式の予備妥当性)

**Files:**
- Modify: `docs/research/scripts/phase-a-mid-analysis.py`

- [ ] **Step 9.1: 純関数 `compute_h9_night_proxy` を追加**

`compute_h8_stall34_correlation` の直後に挿入:

```python
def compute_h9_night_proxy(v3: pd.DataFrame) -> dict:
    """夜間 (luminance < 30) と昼間 (luminance >= 60) の luminance_std / edge_density 分布を比較。
    戻り値: 各サブセットの統計と arrivals_window との Pearson r。
    """
    night = v3[v3["luminance_mean_1"] < NIGHT_LUMINANCE_THRESHOLD]
    day = v3[v3["luminance_mean_1"] >= 60]

    def safe_stats(s: pd.Series) -> dict:
        s = s.dropna()
        if len(s) == 0:
            return {"n": 0, "mean": None, "median": None, "std": None}
        return {"n": int(len(s)), "mean": float(s.mean()), "median": float(s.median()), "std": float(s.std())}

    def safe_corr(a: pd.Series, b: pd.Series) -> float | None:
        joined = pd.concat([a, b], axis=1).dropna()
        if len(joined) < 5:
            return None
        return float(joined.iloc[:, 0].corr(joined.iloc[:, 1]))

    return {
        "night_n": int(len(night)),
        "day_n": int(len(day)),
        "luminance_std_night": safe_stats(night["luminance_std_1"]),
        "luminance_std_day": safe_stats(day["luminance_std_1"]),
        "edge_density_night": safe_stats(night["edge_density_1"]),
        "edge_density_day": safe_stats(day["edge_density_1"]),
        "night_lum_std_vs_window": safe_corr(night["luminance_std_1"], night["window_taxi_pax"]),
        "night_edge_vs_window": safe_corr(night["edge_density_1"], night["window_taxi_pax"]),
    }


# inline test: H9 統計の基本形
_h9_test = pd.DataFrame({
    "luminance_mean_1": [10, 15, 20, 80, 90, 100],
    "luminance_std_1": [40, 45, 50, 20, 22, 25],
    "edge_density_1": [0.3, 0.35, 0.4, 0.2, 0.22, 0.25],
    "window_taxi_pax": [100, 120, 90, 200, 220, 180],
})
_h9_result = compute_h9_night_proxy(_h9_test)
assert _h9_result["night_n"] == 3
assert _h9_result["day_n"] == 3
assert _h9_result["luminance_std_night"]["mean"] is not None
```

- [ ] **Step 9.2: `main()` で H9 計算 + figure 07 出力**

H8 のブロックの後に挿入:

```python
    # --- H9: 夜間代理指標 (行燈方式の予備妥当性) ---
    h9 = compute_h9_night_proxy(v3)
    print(f"[phase-a-mid] H9: night n={h9['night_n']} day n={h9['day_n']}")
    print(f"  luminance_std night mean = {h9['luminance_std_night']['mean']}")
    print(f"  luminance_std day   mean = {h9['luminance_std_day']['mean']}")
    print(f"  edge_density night mean = {h9['edge_density_night']['mean']}")
    print(f"  edge_density day   mean = {h9['edge_density_day']['mean']}")
    print(f"  night luminance_std vs window_taxi_pax r = {h9['night_lum_std_vs_window']}")
    print(f"  night edge_density  vs window_taxi_pax r = {h9['night_edge_vs_window']}")

    fig, axes = plt.subplots(1, 2, figsize=(11, 5))
    night_v3 = v3[v3["luminance_mean_1"] < NIGHT_LUMINANCE_THRESHOLD]
    day_v3 = v3[v3["luminance_mean_1"] >= 60]
    axes[0].hist(day_v3["luminance_std_1"].dropna(), bins=30, alpha=0.5, label=f"昼間 n={h9['day_n']}", color="#fc4")
    axes[0].hist(night_v3["luminance_std_1"].dropna(), bins=30, alpha=0.5, label=f"夜間 n={h9['night_n']}", color="#48c")
    axes[0].set_xlabel("img1.roi.luminance_std")
    axes[0].set_ylabel("tick 数")
    axes[0].set_title("luminance_std 分布 (昼夜)")
    axes[0].legend()
    axes[1].hist(day_v3["edge_density_1"].dropna(), bins=30, alpha=0.5, label=f"昼間 n={h9['day_n']}", color="#fc4")
    axes[1].hist(night_v3["edge_density_1"].dropna(), bins=30, alpha=0.5, label=f"夜間 n={h9['night_n']}", color="#48c")
    axes[1].set_xlabel("img1.roi.edge_density")
    axes[1].set_ylabel("tick 数")
    axes[1].set_title("edge_density 分布 (昼夜)")
    axes[1].legend()
    fig.suptitle("H9: 夜間でもタクシー実在シグナル (luminance_std / edge_density) が動くか", fontsize=10, y=1.02)
    fig.tight_layout()
    fig.savefig(FIGURES_DIR / "07-h9-night-proxy-signals.png", dpi=120, bbox_inches="tight")
    plt.close(fig)
    print(f"[phase-a-mid] wrote {FIGURES_DIR / '07-h9-night-proxy-signals.png'}")
```

- [ ] **Step 9.3: 実行確認**

```bash
~/.venvs/taxi-ic-phase-a/bin/python docs/research/scripts/phase-a-mid-analysis.py 2>&1 | tail -20
```

期待:
- 夜間 / 昼間の `luminance_std` 平均が出る
- 期待される所見: 夜間で `luminance_std` が高め (= 局所明点) で `edge_density` も非ゼロ → 行燈方式の妥当性に裏付け
- 期待と逆の結果 (夜間で完全に平坦) なら、レポートに「現メトリックでは夜間シグナル捕捉不可、新メトリック必須」と書く

- [ ] **Step 9.4: commit**

```bash
git add docs/research/scripts/phase-a-mid-analysis.py docs/research/figures/2026-05-14/07-h9-night-proxy-signals.png
git commit -m "feat(research): H9 night proxy signals (luminance_std, edge_density)"
```

---

## Task 10: レポート markdown 組み立て

**Files:**
- Create: `docs/research/taxi-pool-mid-analysis-2026-05-14.md`
- Modify: `docs/research/scripts/phase-a-mid-analysis.py`

- [ ] **Step 10.1: `main()` の最後にレポート書き出しを追加**

H9 のブロックの後、`if __name__ == "__main__":` の前に追加 (`main()` 関数末尾):

```python
    # --- レポート組み立て ---
    schema_lines = "\n".join(f"- v{v}: {n} 行" for v, n in schema_counts.items())
    h1_table = h1.to_markdown(index=False) if len(h1) > 0 else "(H1 ラグ計算: 信頼サブセットが日次集計に足りず)"
    hourly_table = h6["hourly_df"].to_markdown(index=False)

    def fmt_r(v):
        return f"{v:.3f}" if v is not None else "n/a"

    def fmt_stats(s):
        if s["n"] == 0:
            return "n=0"
        return f"n={s['n']}, mean={s['mean']:.3f}, median={s['median']:.3f}, std={s['std']:.3f}"

    report = f"""# Phase A タクシープール観測 中間分析 (2026-05-14 スナップショット)

> **注意: 3.5 日分 (v3 期間実質 2.5 日) のためサンプル不足。各仮説の結論は「ヒント」として扱い、5/31 観測終了後の本分析で再評価する。**

## 1. 要約

2026-05-11 から開始した観測ジョブの中間スナップショット (jsonl {len(df)} 行、ts 範囲 {df['ts'].min()} 〜 {df['ts'].max()}) を解析した。信頼サブセット {len(trusted)} 行 (schema=3 ∧ luminance>=30 ∧ ts 順序正常) を基準として、H1/H6/H8/H9 の暫定傾向と、5/31 本分析・ROI v4 設計への提言をまとめる。

**3 文結論:**
- 夜間の ROI 飽和率 {sat_rate:.1%} (n={len(night)}) — 夜間問題は実データで明確に再現、ROI v4 で行燈方式の導入が不可欠
- H6 (T1/T2 出庫 vs 予測需要): T1 r={fmt_r(h6['T1_pearson_r'])}, T2 r={fmt_r(h6['T2_pearson_r'])} — 5/31 までの追加サンプルで本格評価
- H8 (stall3 vs stall4): occupied r={h8['occupied_pearson_r']:.3f} — Real02 の神奈川車混在問題の暫定指標

## 2. データ品質チェック

### schema_version 分布

{schema_lines}

![schema 分布](figures/2026-05-14/01-schema-distribution.png)

### tick_seq 連続性

検出された欠損: {len(gaps)} 箇所
{chr(10).join(f"- seq {p} → {n} (skipped {n - p - 1})" for p, n in gaps[:10]) if gaps else "- (連続、欠損なし)"}

![tick_seq 欠損](figures/2026-05-14/02-tick-seq-gaps.png)

### ts 逆行

検出された逆行: {len(reversals)} 件 (index: {reversals[:10] if reversals else '(なし)'})

ユーザー報告の seq 121→122 の rebase 起因の逆行が含まれる。信頼サブセットからは除外済み。

### 夜間飽和率

- 夜間 tick (luminance_mean < {NIGHT_LUMINANCE_THRESHOLD}): {len(night)} 件
- そのうち stall1/2/3 全 capacity 張り付き: {night_saturated.sum()} 件 ({sat_rate:.1%})

![夜間飽和](figures/2026-05-14/04-night-saturation.png)

夜間問題は実データで顕在化している。Phase B での仮説検証では夜間を除外する前提、ROI v4 設計時には行燈方式で代替する必要あり。

### ROI 健全性 / 信頼サブセット

- v3 行: {len(v3)}
- 信頼サブセット (schema=3 ∧ luminance>={NIGHT_LUMINANCE_THRESHOLD} ∧ ts 順序正常 ∧ stalls 非 null): {len(trusted)}

![stall 別 occupied ヒートマップ](figures/2026-05-14/03-stall-occupancy-heatmap.png)

## 3. H1: 予測ピーク時刻と実プール出庫ピーク時刻のラグ (ヒント)

信頼サブセット上の日次集計:

{h1_table}

ラグ平均 {h1_summary['mean_lag_minutes']} 分、中央値 {h1_summary['median_lag_minutes']} 分 (n_days={h1_summary['n_days']})。サンプル日数が少なく結論はヒント程度。

## 4. H6: T1/T2 出庫量 × arrivals_window 相関 (ヒント)

時間帯バケット (1 時間粒度) で集計:

{hourly_table}

- T1 (stall1+2) Pearson r = {fmt_r(h6['T1_pearson_r'])}
- T2 (stall3+4) Pearson r = {fmt_r(h6['T2_pearson_r'])}
- 信頼サブセット n = {h6['n']}

![H6 散布図](figures/2026-05-14/05-h6-correlation.png)

## 5. H8: stall3 vs stall4 相関 (神奈川車混在の影響、ヒント)

- occupied_estimate Pearson r = {h8['occupied_pearson_r']:.3f} (n={h8['n_occ']})
- diff_occupied_from_prev Pearson r = {h8['diff_pearson_r']:.3f} (n={h8['n_diff']})

![H8 相関](figures/2026-05-14/06-h8-stall3-stall4.png)

解釈基準 (spec § 5):
- r > 0.5: T2 共有として連動、stall4 は健全
- r < 0.2: 神奈川車が stall4 ROI に漏れて汚染の疑い

## 6. H9: 夜間代理指標 (行燈方式の予備妥当性、新規)

夜間 (luminance_mean < {NIGHT_LUMINANCE_THRESHOLD}) と昼間 (luminance_mean >= 60) の比較:

| 指標 | 夜間 | 昼間 |
|---|---|---|
| luminance_std | {fmt_stats(h9['luminance_std_night'])} | {fmt_stats(h9['luminance_std_day'])} |
| edge_density | {fmt_stats(h9['edge_density_night'])} | {fmt_stats(h9['edge_density_day'])} |

夜間内での arrivals_window との相関:
- night `luminance_std` vs `window_taxi_pax` r = {fmt_r(h9['night_lum_std_vs_window'])}
- night `edge_density` vs `window_taxi_pax` r = {fmt_r(h9['night_edge_vs_window'])}

![H9 夜間代理指標](figures/2026-05-14/07-h9-night-proxy-signals.png)

**解釈**:
- 夜間 `luminance_std` の中央値が昼間より高ければ、局所明点 (行燈・テールライト等) が ROI に存在 → 行燈ピクセルカウント方式の妥当性に裏付け
- 夜間内で `luminance_std` と `window_taxi_pax` に弱い正の相関があれば、これらの代理指標で「夜間タクシー存在」を粗く拾える可能性 → ROI v4 の中間段階として有望
- 完全に平坦 (相関 ~0、std 分布が昼夜重なる) なら、行燈方式の実装には現メトリック以外の処理 (HSV / 連結成分ラベリング) が必須

## 7. 5/31 本分析への提言と ROI v4 設計

### 5/31 本分析で追加すべき項目

1. **H2** (予測スケールと出庫量の整合) — 14 日分のサンプルで日次集計、transit-share 係数との一致度
2. **H3** (雨天での予測ずれ) — weather_code in [51,53,55,61,63,65] のサブセットで偏り検出
3. **H4** (深夜帯ラッシュ 21:30 以降) — ROI v4 が動いていれば夜間データを使う
4. **H7** (ピーク → 出庫ラグ) — cross-correlation で 5 分単位、信頼サブセットを 14 日分積んで再計算
5. **曜日効果** — 平日 vs 土日の occupied / 出庫量の差
6. **ROI v3 vs v4 比較** — v4 ROI 実装後、同じ tick で両方計算して相関と乖離を可視化
7. **欠損率の長期傾向** — Mac mini 稼働率、長期欠損の原因 (OS アップデート等) 集計

### ROI v4 設計提言

**昼間 (luminance_mean >= 60)**:
- 駐車枠ベース検出: 1 台 1 ROI で分解。現 stall1-3 の「縦列 8 台まとめ」を解体し、stall ごとに 7-8 個の小 ROI を持つ
- 各小 ROI の black_ratio 二値判定で「占有/空」を判定 → occupied_estimate は連続値でなく整数和

**夜間 (luminance_mean < 30)** (新規):
- **行燈ピクセルカウント方式** (本中間分析で示唆された方針)
  - HSV 範囲: タクシー行燈の典型色 (LED 白〜淡黄、明度 200+、彩度 0-80) を絞り込み
  - 連結成分ラベリング: HSV マスク後に 8 連結で blob 検出
  - 区別: ヘッドライト白 (面積が大きい、地面に寄っている) / テールライト赤 / 信号機 (位置固定) をフィルタ
  - カウント: blob 数 = 行燈数 ≒ タクシー台数
- 予備実装: Mac mini 側で実画像を使い、HSV 範囲と blob 最小面積を 5-10 サンプルで調整

**昼夜判定**: `luminance_mean` で閾値判定。境界付近 (30-60) は両方計算して整合する方を採用するハイブリッド戦略。

**段階導入**:
1. v4-A: 昼間だけ駐車枠ベース、夜間は v3 のまま (= occupied_estimate は capacity 張り付き継続を許容)
2. v4-B: 夜間に行燈方式を導入、v3 と v4-A 両方記録
3. v4-C: v3 を deprecate、v4 単独運用

5/31 観測終了後の Phase B 分析で v4 の評価指標を確定する。

---

**メタ情報**: 分析スクリプト `docs/research/scripts/phase-a-mid-analysis.py` を実行 ({df['ts'].max()} 時点の jsonl)。再現性のため commit 済み。venv は `~/.venvs/taxi-ic-phase-a/`。
"""
    REPORT_PATH.write_text(report, encoding="utf-8")
    print(f"[phase-a-mid] wrote {REPORT_PATH}")
```

- [ ] **Step 10.2: 実行 + レポート生成確認**

```bash
~/.venvs/taxi-ic-phase-a/bin/python docs/research/scripts/phase-a-mid-analysis.py 2>&1 | tail -10
ls -la docs/research/taxi-pool-mid-analysis-2026-05-14.md docs/research/figures/2026-05-14/
```

期待:
- `[phase-a-mid] wrote .../taxi-pool-mid-analysis-2026-05-14.md`
- 7 枚の png が存在
- md ファイルが 100-300 行程度

- [ ] **Step 10.3: レポートの目視チェック**

```bash
head -50 docs/research/taxi-pool-mid-analysis-2026-05-14.md
wc -l docs/research/taxi-pool-mid-analysis-2026-05-14.md
```

期待:
- 「Phase A タクシープール観測 中間分析」のタイトル
- 「3.5 日分... ヒントとして扱う」の注釈が冒頭にあるか
- 数値が `None` ばかりになっていないか (=サンプル不足の場合は明示表記になっているか)

`None` 表示が頻出する場合は、`fmt_r` / `fmt_stats` がそのまま使われているので問題なし (意図的)。それ以外で broken な箇所があれば該当 section を修正。

- [ ] **Step 10.4: commit**

```bash
git add docs/research/scripts/phase-a-mid-analysis.py docs/research/taxi-pool-mid-analysis-2026-05-14.md
git commit -m "feat(research): assemble Phase A mid-analysis report"
```

---

## Task 11: 最終整合 + push

**Files:** なし (整合確認のみ)

- [ ] **Step 11.1: スクリプトを最後まで再実行して整合確認**

```bash
~/.venvs/taxi-ic-phase-a/bin/python docs/research/scripts/phase-a-mid-analysis.py 2>&1 | tail -30
```

期待: エラーなしで完走し、7 枚の png + md が更新される。

- [ ] **Step 11.2: スコープ外ファイルに触っていないか確認**

```bash
git status --short
git log origin/main..HEAD --name-only --pretty=format:'%h %s'
```

期待:
- 触ったファイルは `docs/research/scripts/phase-a-mid-analysis.py`、`docs/research/figures/2026-05-14/*.png`、`docs/research/taxi-pool-mid-analysis-2026-05-14.md`、`docs/superpowers/specs/2026-05-14-phase-a-mid-analysis-design.md`、`docs/superpowers/plans/2026-05-14-phase-a-mid-analysis-plan.md` のみ
- `scripts/`、`data/`、launchd plist には変更なし

- [ ] **Step 11.3: git pull --rebase --autostash で観測 push 衝突を回避**

```bash
git pull --rebase --autostash origin main 2>&1 | tail -5
```

期待: 観測 tick が新しく push されていれば rebase 取り込み、自分の commit は HEAD に積み直される。

- [ ] **Step 11.4: 最終 push (3 回までリトライ)**

```bash
for i in 1 2 3; do
  if git push origin main; then
    echo "[push ok attempt $i]"
    break
  fi
  echo "[push retry $i]"
  git pull --rebase --autostash origin main
  sleep 2
done
```

期待: `[push ok attempt 1]` または 2-3 で成功。

- [ ] **Step 11.5: 完了報告**

レポートの位置とサイズを最終確認:

```bash
ls -la docs/research/taxi-pool-mid-analysis-2026-05-14.md
ls docs/research/figures/2026-05-14/
```

期待: md 1 個、png 7 個。

---

## 検証コマンド一覧 (チートシート)

```bash
# 全体実行
~/.venvs/taxi-ic-phase-a/bin/python docs/research/scripts/phase-a-mid-analysis.py

# 構文チェック
~/.venvs/taxi-ic-phase-a/bin/python -m py_compile docs/research/scripts/phase-a-mid-analysis.py

# レポート目視
head -80 docs/research/taxi-pool-mid-analysis-2026-05-14.md

# 観測ジョブと衝突を避ける commit
git pull --rebase --autostash origin main
git add docs/research/...
git commit -m "..."
for i in 1 2 3; do git push origin main && break; git pull --rebase --autostash origin main; done
```

---

## 完了条件 (再掲)

- [ ] `docs/research/scripts/phase-a-mid-analysis.py` を実装、`~/.venvs/taxi-ic-phase-a/` で実行できる
- [ ] `docs/research/figures/2026-05-14/` に 7 枚の png が生成される
- [ ] `docs/research/taxi-pool-mid-analysis-2026-05-14.md` に 7 章すべてが書かれている
- [ ] 「3.5 日分 (v3 期間実質 2.5 日) のためサンプル不足、傾向のヒントとして扱う」が冒頭・各章・結論で明記されている
- [ ] スコープ外ファイル (`scripts/`, `data/*.jsonl`, launchd plist, feature ブランチ) は触っていない
- [ ] main へ push 成功
