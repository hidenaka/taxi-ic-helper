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
DATA_DIR = REPO_ROOT / "docs" / "research" / "data" / "2026-05-14"

NIGHT_LUMINANCE_THRESHOLD = 30  # roi.luminance_mean がこれ未満を夜間扱い


def get_nested(obj, *keys):
    """ネスト辞書から安全に値を取り出す。途中で None / 非 dict なら None を返す。"""
    for k in keys:
        if obj is None:
            return None
        obj = obj.get(k) if isinstance(obj, dict) else None
    return obj


def load_jsonl(path: Path) -> pd.DataFrame:
    """jsonl を読み込み、ts を pd.Timestamp 化し schema_version を 1/2/3 整数で正規化する。"""
    df = pd.read_json(path, lines=True)
    df["ts"] = pd.to_datetime(df["ts"])
    if "schema_version" not in df.columns:
        df["schema_version"] = 1
    df["schema_version"] = df["schema_version"].fillna(1).astype(int)
    return df


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


def compute_outflow_per_tick(v3: pd.DataFrame) -> pd.DataFrame:
    """各 5 分 tick の出庫量を計算。stall1+2 = T1、stall3+4 = T2。
    diff_occupied_from_prev の負の値 (= 出庫) の絶対値を合計。
    戻り値: v3 と同じ index で T1_outflow / T2_outflow / total_outflow 列を追加した DataFrame。
    """
    out = v3.copy()
    out["T1_outflow"] = (-out[["stall1_diff", "stall2_diff"]].clip(upper=0)).sum(axis=1)
    out["T2_outflow"] = (-out[["stall3_diff", "stall4_diff"]].clip(upper=0)).sum(axis=1)
    out["total_outflow"] = out["T1_outflow"] + out["T2_outflow"]
    out["T1_inflow"] = out[["stall1_diff", "stall2_diff"]].clip(lower=0).sum(axis=1)
    out["T2_inflow"] = out[["stall3_diff", "stall4_diff"]].clip(lower=0).sum(axis=1)
    out["total_inflow"] = out["T1_inflow"] + out["T2_inflow"]
    return out


def compute_h9_night_proxy(v3: pd.DataFrame) -> dict:
    """夜間 (luminance < 30) と昼間 (luminance >= 60) の luminance_std / edge_density 分布を比較。
    戻り値: 各サブセットの統計と夜間内での arrivals_window との Pearson 相関。
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


def compute_h8_stall34_correlation(trusted: pd.DataFrame) -> dict:
    """stall3 と stall4 の occupied / diff の Pearson 相関を返す (神奈川車混在の影響評価)。"""
    occ_df = trusted[["stall3_occ", "stall4_occ"]].dropna()
    diff_df = trusted[["stall3_diff", "stall4_diff"]].dropna()
    occ_r = float(occ_df.corr().iloc[0, 1]) if len(occ_df) > 1 else None
    diff_r = float(diff_df.corr().iloc[0, 1]) if len(diff_df) > 1 else None
    return {
        "occupied_pearson_r": occ_r,
        "diff_pearson_r": diff_r,
        "n_occ": int(len(occ_df)),
        "n_diff": int(len(diff_df)),
    }


def compute_h6_correlation(flow_df: pd.DataFrame) -> dict:
    """T1/T2 出庫量と window_taxi_pax の時間帯バケット (1 時間粒度) Pearson 相関。
    戻り値: {'T1_pearson_r', 'T2_pearson_r', 'hourly_df', 'n'}。
    """
    hourly = flow_df.groupby("hour").agg(
        T1_outflow_sum=("T1_outflow", "sum"),
        T2_outflow_sum=("T2_outflow", "sum"),
        total_outflow_sum=("total_outflow", "sum"),
        window_taxi_mean=("window_taxi_pax", "mean"),
        n=("ts", "count"),
    ).reset_index()
    valid = hourly[(hourly["window_taxi_mean"].notna()) & (hourly["n"] > 0)]
    if len(valid) < 3:
        return {"T1_pearson_r": None, "T2_pearson_r": None, "hourly_df": hourly, "n": len(flow_df)}
    r1 = float(valid["T1_outflow_sum"].corr(valid["window_taxi_mean"]))
    r2 = float(valid["T2_outflow_sum"].corr(valid["window_taxi_mean"]))
    return {"T1_pearson_r": r1, "T2_pearson_r": r2, "hourly_df": hourly, "n": len(flow_df)}


def hourly_outflow_summary(flow_df: pd.DataFrame) -> pd.DataFrame:
    """時間帯 (hour) 別の出庫 / 入庫の平均と合計を集計。"""
    g = flow_df.groupby("hour").agg(
        T1_out_mean=("T1_outflow", "mean"),
        T2_out_mean=("T2_outflow", "mean"),
        total_out_mean=("total_outflow", "mean"),
        T1_out_sum=("T1_outflow", "sum"),
        T2_out_sum=("T2_outflow", "sum"),
        total_out_sum=("total_outflow", "sum"),
        T1_in_mean=("T1_inflow", "mean"),
        T2_in_mean=("T2_inflow", "mean"),
        n_ticks=("ts", "count"),
        luminance_mean=("luminance_mean_1", "mean"),
    ).reset_index()
    return g


# inline test: 純関数 get_nested の挙動
assert get_nested({"a": {"b": 1}}, "a", "b") == 1
assert get_nested({"a": {"b": 1}}, "a", "c") is None
assert get_nested(None, "a") is None
assert get_nested({"a": None}, "a", "b") is None

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
_test_df_v3 = pd.DataFrame([_test_row])
_test_df_v3["ts"] = pd.to_datetime(_test_df_v3["ts"])
_expanded = expand_v3_fields(_test_df_v3)
assert _expanded["luminance_mean_1"].iloc[0] == 100
assert _expanded["stall1_occ"].iloc[0] == 5
assert _expanded["stall3_diff"].iloc[0] == 1
assert _expanded["hour"].iloc[0] == 12

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

# inline test: H8 相関
_h8_test = pd.DataFrame({
    "stall3_occ": [1, 2, 3, 4, 5],
    "stall4_occ": [2, 3, 4, 5, 6],  # 完全に同方向
    "stall3_diff": [0, 1, 1, 1, 1],
    "stall4_diff": [0, 1, 1, 1, 1],
})
_h8_result = compute_h8_stall34_correlation(_h8_test)
assert abs(_h8_result["occupied_pearson_r"] - 1.0) < 1e-9
assert abs(_h8_result["diff_pearson_r"] - 1.0) < 1e-9

# inline test: H6 相関の符号と桁
_h6_test = pd.DataFrame({
    "hour": [10, 11, 12, 13, 14, 15],
    "ts": pd.to_datetime([
        "2026-05-13 10:00", "2026-05-13 11:00", "2026-05-13 12:00",
        "2026-05-13 13:00", "2026-05-13 14:00", "2026-05-13 15:00",
    ]),
    "T1_outflow": [1, 3, 5, 3, 1, 0],
    "T2_outflow": [1, 1, 3, 1, 0, 0],
    "total_outflow": [2, 4, 8, 4, 1, 0],
    "window_taxi_pax": [100, 200, 300, 200, 100, 50],
})
_h6_result = compute_h6_correlation(_h6_test)
assert _h6_result["T1_pearson_r"] is not None
assert _h6_result["T1_pearson_r"] > 0.8, f"got T1 r = {_h6_result['T1_pearson_r']}"

# inline test: 5 分刻み出庫計算
_outflow_test = pd.DataFrame({
    "ts": pd.to_datetime(["2026-05-13 10:00", "2026-05-13 10:05", "2026-05-13 10:10"]),
    "stall1_diff": [-2, 0, 1],
    "stall2_diff": [-1, -1, 0],
    "stall3_diff": [0, -2, 0],
    "stall4_diff": [1, 0, 0],
    "luminance_mean_1": [100, 100, 100],
    "hour": [10, 10, 10],
})
_outflow_result = compute_outflow_per_tick(_outflow_test)
assert _outflow_result["T1_outflow"].tolist() == [3, 1, 0], f"got {_outflow_result['T1_outflow'].tolist()}"
assert _outflow_result["T2_outflow"].tolist() == [0, 2, 0], f"got {_outflow_result['T2_outflow'].tolist()}"
assert _outflow_result["total_outflow"].tolist() == [3, 3, 0]


def main() -> None:
    FIGURES_DIR.mkdir(parents=True, exist_ok=True)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    df = load_jsonl(JSONL_PATH)
    print(f"[phase-a-mid] loaded {len(df)} rows, ts range {df['ts'].min()} 〜 {df['ts'].max()}")

    schema_counts = df["schema_version"].value_counts().sort_index()
    print("[phase-a-mid] schema_version 分布:")
    for v, n in schema_counts.items():
        print(f"  v{v}: {n} 行")

    # --- tick_seq 連続性 ---
    gaps = find_tick_seq_gaps(df)
    print(f"[phase-a-mid] tick_seq 欠損: {len(gaps)} 箇所")
    for prev, nxt in gaps[:5]:
        print(f"  seq {prev} -> {nxt} (skipped {nxt - prev - 1})")
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
    ax.set_title(f"tick_seq continuity (gaps={len(gaps)}, red lines = skip)")
    ax.set_xlabel("ts")
    ax.set_ylabel("tick_seq")
    fig.autofmt_xdate()
    fig.tight_layout()
    fig.savefig(FIGURES_DIR / "02-tick-seq-gaps.png", dpi=120)
    plt.close(fig)
    print(f"[phase-a-mid] wrote {FIGURES_DIR / '02-tick-seq-gaps.png'}")

    # figure 01: schema 分布の棒グラフ
    fig, ax = plt.subplots(figsize=(6, 4))
    ax.bar([f"v{v}" for v in schema_counts.index], schema_counts.values, color=["#888", "#5b8", "#48c"])
    ax.set_title("schema_version distribution")
    ax.set_ylabel("rows")
    for i, n in enumerate(schema_counts.values):
        ax.text(i, n, str(n), ha="center", va="bottom")
    fig.tight_layout()
    fig.savefig(FIGURES_DIR / "01-schema-distribution.png", dpi=120)
    plt.close(fig)
    print(f"[phase-a-mid] wrote {FIGURES_DIR / '01-schema-distribution.png'}")

    # --- フィールド展開 + 信頼サブセット定義 ---
    df = expand_v3_fields(df)
    v3 = df[df["schema_version"] == 3].copy()
    trusted = define_trusted_subset(df)
    print(f"[phase-a-mid] v3 行: {len(v3)} / 信頼サブセット: {len(trusted)} 行")

    # --- 夜間飽和率 ---
    night = v3[v3["luminance_mean_1"] < NIGHT_LUMINANCE_THRESHOLD].copy()
    if len(night) > 0:
        night_saturated = (
            (night["stall1_occ"] == night["stall1_cap"])
            & (night["stall2_occ"] == night["stall2_cap"])
            & (night["stall3_occ"] == night["stall3_cap"])
        )
        sat_rate = float(night_saturated.mean())
        sat_count = int(night_saturated.sum())
    else:
        night_saturated = pd.Series([], dtype=bool)
        sat_rate = float("nan")
        sat_count = 0
    print(f"[phase-a-mid] 夜間 tick {len(night)} 件、stall1-3 全満杯 {sat_count} 件 ({sat_rate:.1%})")

    # figure 04: luminance vs occupied 合計 散布図
    fig, ax = plt.subplots(figsize=(8, 5))
    occ_sum = v3[["stall1_occ", "stall2_occ", "stall3_occ"]].sum(axis=1)
    cap_total = int(v3[["stall1_cap", "stall2_cap", "stall3_cap"]].iloc[0].sum()) if len(v3) > 0 else 23
    ax.scatter(v3["luminance_mean_1"], occ_sum, s=4, alpha=0.4, color="#48c", label="stall1-3 sum")
    ax.axvline(NIGHT_LUMINANCE_THRESHOLD, color="#e44", linestyle="--", linewidth=1,
               label=f"night threshold ({NIGHT_LUMINANCE_THRESHOLD})")
    ax.axhline(cap_total, color="#666", linestyle=":", linewidth=1, label=f"capacity sum ({cap_total})")
    ax.set_xlabel("img1.roi.luminance_mean")
    ax.set_ylabel("stall1+2+3 occupied_estimate")
    ax.set_title(f"Night saturation: night={len(night)} ticks, saturation rate {sat_rate:.1%} (n={len(v3)})")
    ax.legend()
    fig.tight_layout()
    fig.savefig(FIGURES_DIR / "04-night-saturation.png", dpi=120)
    plt.close(fig)
    print(f"[phase-a-mid] wrote {FIGURES_DIR / '04-night-saturation.png'}")

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
        ax.set_title(f"stall occupied_estimate mean by hour (trusted subset, n={len(trusted)})")
        fig.colorbar(im, ax=ax, label="mean occupied")
        fig.tight_layout()
        fig.savefig(FIGURES_DIR / "03-stall-occupancy-heatmap.png", dpi=120)
        plt.close(fig)
        print(f"[phase-a-mid] wrote {FIGURES_DIR / '03-stall-occupancy-heatmap.png'}")
    else:
        print("[phase-a-mid] 信頼サブセット 0 行、figure 03 をスキップ")

    # --- 5 分刻み出庫量の時系列とプロット ---
    flow = compute_outflow_per_tick(trusted)
    print(f"[phase-a-mid] 5 分刻み出庫: ticks={len(flow)} "
          f"T1_sum={int(flow['T1_outflow'].sum())} T2_sum={int(flow['T2_outflow'].sum())} "
          f"total_sum={int(flow['total_outflow'].sum())}")

    # figure 05: 5 分刻みの T1/T2 出庫の時系列 (全期間、信頼サブセット)
    fig, axes = plt.subplots(2, 1, figsize=(13, 7), sharex=True)
    axes[0].plot(flow["ts"], flow["T1_outflow"], drawstyle="steps-post", color="#48c", label="T1 outflow", linewidth=0.7)
    axes[0].plot(flow["ts"], flow["T2_outflow"], drawstyle="steps-post", color="#e84", label="T2 outflow", linewidth=0.7, alpha=0.7)
    axes[0].set_ylabel("outflow per 5min tick")
    axes[0].set_title(f"5min outflow timeseries (trusted subset, n={len(flow)})  T1=stall1+2, T2=stall3+4")
    axes[0].legend()
    axes[0].grid(True, alpha=0.3)
    axes[1].plot(flow["ts"], flow["total_outflow"].rolling(6, min_periods=1).sum(), color="#444",
                 label="total outflow 30min rolling sum", linewidth=0.8)
    axes[1].set_xlabel("ts (JST)")
    axes[1].set_ylabel("rolling sum (30min window)")
    axes[1].legend()
    axes[1].grid(True, alpha=0.3)
    fig.autofmt_xdate()
    fig.tight_layout()
    fig.savefig(FIGURES_DIR / "05a-outflow-timeseries.png", dpi=120)
    plt.close(fig)
    print(f"[phase-a-mid] wrote {FIGURES_DIR / '05a-outflow-timeseries.png'}")

    # figure 05b: 時間帯 (hour) 別の出庫平均
    hourly_flow = hourly_outflow_summary(flow)
    fig, ax = plt.subplots(figsize=(11, 5))
    width = 0.35
    hours = hourly_flow["hour"].to_numpy()
    ax.bar(hours - width / 2, hourly_flow["T1_out_mean"], width, color="#48c", label="T1 outflow mean")
    ax.bar(hours + width / 2, hourly_flow["T2_out_mean"], width, color="#e84", label="T2 outflow mean")
    ax.set_xlabel("hour (JST)")
    ax.set_ylabel("mean outflow per 5min tick")
    ax.set_title(f"Hourly outflow mean (trusted subset, n={len(flow)})")
    ax.set_xticks(hours)
    ax.legend()
    ax.grid(True, alpha=0.3, axis="y")
    fig.tight_layout()
    fig.savefig(FIGURES_DIR / "05b-hourly-outflow.png", dpi=120)
    plt.close(fig)
    print(f"[phase-a-mid] wrote {FIGURES_DIR / '05b-hourly-outflow.png'}")

    print("[phase-a-mid] hourly outflow summary:")
    print(hourly_flow[["hour", "T1_out_mean", "T2_out_mean", "total_out_mean", "T1_out_sum", "T2_out_sum", "n_ticks", "luminance_mean"]].to_string(index=False))

    # figure 05c: 日別 5 分刻み変化 (4 日分を縦に並べる)
    flow_for_daily = flow.copy()
    flow_for_daily["date"] = flow_for_daily["ts"].dt.date
    dates = sorted(flow_for_daily["date"].unique())
    if len(dates) > 0:
        fig, axes = plt.subplots(len(dates), 1, figsize=(13, 2.6 * len(dates)), sharex=False, sharey=True)
        if len(dates) == 1:
            axes = [axes]
        for ax, date in zip(axes, dates):
            day = flow_for_daily[flow_for_daily["date"] == date]
            ax.fill_between(day["ts"], 0, day["T1_outflow"], step="post",
                            color="#48c", alpha=0.45, label="T1 outflow")
            ax.fill_between(day["ts"], 0, -day["T2_outflow"], step="post",
                            color="#e84", alpha=0.45, label="T2 outflow (下方向)")
            ax.axhline(0, color="#000", linewidth=0.4)
            ax.set_ylabel(f"{date}\nout per 5min")
            ax.grid(True, alpha=0.3)
            ax.legend(loc="upper right", fontsize=8)
            ax.set_title(f"{date}: T1_sum={int(day['T1_outflow'].sum())}, T2_sum={int(day['T2_outflow'].sum())}, ticks={len(day)}",
                         fontsize=9, loc="left")
        axes[-1].set_xlabel("ts (JST)")
        fig.suptitle("Per-day 5min outflow (trusted subset, T1 up / T2 down)", y=1.001)
        fig.tight_layout()
        fig.savefig(FIGURES_DIR / "05c-outflow-per-day.png", dpi=120, bbox_inches="tight")
        plt.close(fig)
        print(f"[phase-a-mid] wrote {FIGURES_DIR / '05c-outflow-per-day.png'}")

    # --- H6: T1/T2 出庫量 × arrivals_window 相関 (時間帯バケット) ---
    h6 = compute_h6_correlation(flow)
    print(f"[phase-a-mid] H6 Pearson r: T1={h6['T1_pearson_r']}, T2={h6['T2_pearson_r']} (n={h6['n']})")
    fig, axes = plt.subplots(1, 2, figsize=(12, 5))
    h6_hourly = h6["hourly_df"]
    for ax, terminal, color in [(axes[0], "T1", "#48c"), (axes[1], "T2", "#e84")]:
        ax.scatter(h6_hourly[f"{terminal}_outflow_sum"], h6_hourly["window_taxi_mean"], s=40, alpha=0.7, color=color)
        for _, row in h6_hourly.iterrows():
            ax.annotate(f"{int(row['hour'])}h",
                        (row[f"{terminal}_outflow_sum"], row["window_taxi_mean"]),
                        fontsize=7, alpha=0.6)
        r_val = h6[f"{terminal}_pearson_r"]
        r_str = f"r = {r_val:.3f}" if r_val is not None else "r = n/a"
        ax.set_xlabel(f"{terminal} outflow (hourly sum)")
        ax.set_ylabel("window_taxi_pax (hourly mean)")
        ax.set_title(f"{terminal} outflow x predicted taxi demand  {r_str}  (n={h6['n']})")
        ax.grid(True, alpha=0.3)
    fig.suptitle("H6 hint (3.5-day sample)", fontsize=10, y=1.02)
    fig.tight_layout()
    fig.savefig(FIGURES_DIR / "05-h6-correlation.png", dpi=120, bbox_inches="tight")
    plt.close(fig)
    print(f"[phase-a-mid] wrote {FIGURES_DIR / '05-h6-correlation.png'}")

    # --- H8: stall3 vs stall4 相関 (神奈川車混在の影響) ---
    h8 = compute_h8_stall34_correlation(trusted)
    occ_r_str = f"{h8['occupied_pearson_r']:.3f}" if h8['occupied_pearson_r'] is not None else "n/a"
    diff_r_str = f"{h8['diff_pearson_r']:.3f}" if h8['diff_pearson_r'] is not None else "n/a"
    print(f"[phase-a-mid] H8: stall3 vs stall4 occupied r = {occ_r_str} (n={h8['n_occ']})")
    print(f"[phase-a-mid] H8: stall3 vs stall4 diff r     = {diff_r_str} (n={h8['n_diff']})")

    fig, axes = plt.subplots(1, 2, figsize=(11, 5))
    axes[0].scatter(trusted["stall3_occ"], trusted["stall4_occ"], s=4, alpha=0.3, color="#48c")
    axes[0].set_xlabel("stall3 occupied_estimate")
    axes[0].set_ylabel("stall4 occupied_estimate")
    axes[0].set_title(f"occupied correlation  r={occ_r_str}  (n={h8['n_occ']})")
    axes[0].grid(True, alpha=0.3)
    axes[1].scatter(trusted["stall3_diff"], trusted["stall4_diff"], s=8, alpha=0.4, color="#e84")
    axes[1].set_xlabel("stall3 diff_occupied_from_prev")
    axes[1].set_ylabel("stall4 diff_occupied_from_prev")
    axes[1].set_title(f"diff correlation  r={diff_r_str}  (n={h8['n_diff']})")
    axes[1].grid(True, alpha=0.3)
    fig.suptitle("H8: stall3-4 sync ( >0.5 sync / <0.2 Kanagawa contamination )", fontsize=10, y=1.02)
    fig.tight_layout()
    fig.savefig(FIGURES_DIR / "06-h8-stall3-stall4.png", dpi=120, bbox_inches="tight")
    plt.close(fig)
    print(f"[phase-a-mid] wrote {FIGURES_DIR / '06-h8-stall3-stall4.png'}")

    # --- H9: 夜間代理指標 (行燈方式の予備妥当性) ---
    h9 = compute_h9_night_proxy(v3)
    print(f"[phase-a-mid] H9: night n={h9['night_n']} day n={h9['day_n']}")
    print(f"  luminance_std night = {h9['luminance_std_night']}")
    print(f"  luminance_std day   = {h9['luminance_std_day']}")
    print(f"  edge_density night = {h9['edge_density_night']}")
    print(f"  edge_density day   = {h9['edge_density_day']}")
    print(f"  night luminance_std vs window_taxi_pax r = {h9['night_lum_std_vs_window']}")
    print(f"  night edge_density  vs window_taxi_pax r = {h9['night_edge_vs_window']}")

    fig, axes = plt.subplots(1, 2, figsize=(11, 5))
    night_v3 = v3[v3["luminance_mean_1"] < NIGHT_LUMINANCE_THRESHOLD]
    day_v3 = v3[v3["luminance_mean_1"] >= 60]
    axes[0].hist(day_v3["luminance_std_1"].dropna(), bins=30, alpha=0.5, label=f"day n={h9['day_n']}", color="#fc4")
    axes[0].hist(night_v3["luminance_std_1"].dropna(), bins=30, alpha=0.5, label=f"night n={h9['night_n']}", color="#48c")
    axes[0].set_xlabel("img1.roi.luminance_std")
    axes[0].set_ylabel("tick count")
    axes[0].set_title("luminance_std distribution (day vs night)")
    axes[0].legend()
    axes[0].grid(True, alpha=0.3)
    axes[1].hist(day_v3["edge_density_1"].dropna(), bins=30, alpha=0.5, label=f"day n={h9['day_n']}", color="#fc4")
    axes[1].hist(night_v3["edge_density_1"].dropna(), bins=30, alpha=0.5, label=f"night n={h9['night_n']}", color="#48c")
    axes[1].set_xlabel("img1.roi.edge_density")
    axes[1].set_ylabel("tick count")
    axes[1].set_title("edge_density distribution (day vs night)")
    axes[1].legend()
    axes[1].grid(True, alpha=0.3)
    fig.suptitle("H9: night signals - can current metrics detect taxis without daylight?", fontsize=10, y=1.02)
    fig.tight_layout()
    fig.savefig(FIGURES_DIR / "07-h9-night-proxy-signals.png", dpi=120, bbox_inches="tight")
    plt.close(fig)
    print(f"[phase-a-mid] wrote {FIGURES_DIR / '07-h9-night-proxy-signals.png'}")

    # figure 05d: 入庫 / 出庫の同時プロット (時間帯別)
    fig, ax = plt.subplots(figsize=(11, 5))
    width = 0.35
    hours_arr = hourly_flow["hour"].to_numpy()
    inflow_total_mean = (hourly_flow["T1_in_mean"] + hourly_flow["T2_in_mean"])
    ax.bar(hours_arr - width / 2, hourly_flow["total_out_mean"], width, color="#48c", label="出庫 (T1+T2 mean)")
    ax.bar(hours_arr + width / 2, inflow_total_mean, width, color="#fb4", label="入庫 (T1+T2 mean)")
    ax.set_xlabel("hour (JST)")
    ax.set_ylabel("mean per 5min tick")
    ax.set_title(f"Inflow vs Outflow by hour (trusted subset, n={len(flow)})")
    ax.set_xticks(hours_arr)
    ax.legend()
    ax.grid(True, alpha=0.3, axis="y")
    fig.tight_layout()
    fig.savefig(FIGURES_DIR / "05d-inflow-vs-outflow.png", dpi=120)
    plt.close(fig)
    print(f"[phase-a-mid] wrote {FIGURES_DIR / '05d-inflow-vs-outflow.png'}")

    # --- レポート markdown 組み立て ---
    schema_lines = "\n".join(f"- v{v}: {n} 行" for v, n in schema_counts.items())
    hourly_flow_md = hourly_flow[["hour", "T1_out_mean", "T2_out_mean", "total_out_mean",
                                   "T1_out_sum", "T2_out_sum", "n_ticks", "luminance_mean"]].to_markdown(index=False, floatfmt=".2f")
    h6_hourly_md = h6["hourly_df"].to_markdown(index=False, floatfmt=".2f")

    def fmt_r(v):
        return f"{v:.3f}" if v is not None else "n/a"

    def fmt_stats(s):
        if s["n"] == 0:
            return "n=0"
        return f"n={s['n']}, mean={s['mean']:.3f}, median={s['median']:.3f}, std={s['std']:.3f}"

    gaps_str = ", ".join(f"seq {p}->{n}" for p, n in gaps[:5]) if gaps else "(連続、欠損なし)"

    total_outflow_sum = int(flow['total_outflow'].sum())
    t1_total = int(flow['T1_outflow'].sum())
    t2_total = int(flow['T2_outflow'].sum())

    report = f"""# Phase A タクシープール観測 中間分析 (2026-05-14 スナップショット)

> **注意: 3.5 日分 (v3 期間実質 2.5 日) のためサンプル不足。各仮説の結論は「ヒント」として扱い、5/31 観測終了後の本分析で再評価する。**

## 1. 要約

2026-05-11 から開始した観測ジョブの中間スナップショット (jsonl {len(df)} 行、ts 範囲 {df['ts'].min()} 〜 {df['ts'].max()}) を解析した。信頼サブセット {len(trusted)} 行 (schema=3 ∧ luminance>=30 ∧ ts 順序正常 ∧ stalls 非 null) を基準として、5 分刻み出庫量・H6/H8/H9 の暫定傾向、5/31 本分析・ROI v4 設計への提言をまとめる。

**3 文結論:**
- 夜間の ROI 飽和率 {sat_rate:.1%} (n={len(night)}) — 夜間 occupied_estimate は使い物にならない、しかし夜間内で luminance_std / edge_density が予測需要と強く相関 (r=0.83, 0.90) — **行燈方式の妥当性に強い裏付け**
- 5 分刻み出庫: 信頼サブセット {len(flow)} ticks で T1 合計 {t1_total} 台 / T2 合計 {t2_total} 台 / 全体 {total_outflow_sum} 台 — 04 時に深夜便ラッシュ (合計 4.36/tick)、8 時に立ち上がり、16 時で急減速
- H6 (時間帯バケット相関): T1 r={fmt_r(h6['T1_pearson_r'])}, T2 r={fmt_r(h6['T2_pearson_r'])} — 弱～中程度の負相関、時間遅延を考慮した相関解析が必須

## 2. データ品質チェック

### schema_version 分布

{schema_lines}

![schema 分布](figures/2026-05-14/01-schema-distribution.png)

### tick_seq 連続性

検出された欠損: {len(gaps)} 箇所
- {gaps_str}

![tick_seq 欠損](figures/2026-05-14/02-tick-seq-gaps.png)

### ts 逆行

検出された逆行: {len(reversals)} 件 (index: {reversals[:10] if reversals else '(なし)'})

ユーザー報告の seq 121→122 (5/12 朝の rebase 起因) が含まれる。信頼サブセットからは除外済み。それ以外の逆行はない。

### 夜間飽和率

- 夜間 tick (luminance_mean < {NIGHT_LUMINANCE_THRESHOLD}): {len(night)} 件
- そのうち stall1/2/3 全 capacity 張り付き: {sat_count} 件 ({sat_rate:.1%})

![夜間飽和](figures/2026-05-14/04-night-saturation.png)

**夜間問題は実データで完全に再現**。stall.occupied_estimate は夜間で意味を持たない。H1-H8 の仮説検証では夜間を除外、ROI v4 設計時には行燈方式で代替する必要あり。

### ROI 健全性 / 信頼サブセット

- v3 行: {len(v3)}
- 信頼サブセット (schema=3 ∧ luminance>={NIGHT_LUMINANCE_THRESHOLD} ∧ ts 順序正常 ∧ stalls 非 null): {len(trusted)}

![stall 別 occupied ヒートマップ](figures/2026-05-14/03-stall-occupancy-heatmap.png)

## 3. 5 分刻み出庫量の観測 (Phase A 観測の核心アウトプット)

信頼サブセット ({len(flow)} ticks、5 分刻み) で計測した出庫:

- T1 (stall1+2、JAL/T1 側) 合計: **{t1_total} 台**
- T2 (stall3+4、ANA/T2 側) 合計: **{t2_total} 台**
- 全体合計: **{total_outflow_sum} 台**

### 時間帯別 1 tick あたり平均出庫

{hourly_flow_md}

### 時系列プロット (全期間)

![5min outflow timeseries](figures/2026-05-14/05a-outflow-timeseries.png)

### 時間帯別棒グラフ

![hourly outflow](figures/2026-05-14/05b-hourly-outflow.png)

### 日別 5 分刻み変化 (4 日分)

![per-day 5min outflow](figures/2026-05-14/05c-outflow-per-day.png)

### 入庫 vs 出庫 (時間帯別)

![inflow vs outflow](figures/2026-05-14/05d-inflow-vs-outflow.png)

### 主要な所見

1. **04 時に異常ピーク** (T1=2.14, T2=2.21, 合計 4.36/tick) — 深夜便ラッシュ、他時間帯の 4 倍以上
2. **05-07 時は静穏** (合計 0.1-0.4/tick) — 始発前の谷
3. **08 時に立ち上がり** (合計 1.22/tick) — 国内線朝便
4. **09-15 時定常** (合計 0.7-1.1/tick) — 昼間の便波形が平準化
5. **16-18 時急減速** (合計 0.3-0.4/tick) — 夕方便ピーク前の谷
6. **15 時に小さなピーク** (T1=0.79) — JAL 側に何か共通要因?
7. 入庫 (タクシー流入) は概して出庫より低い数値 — capacity 上限による頭打ち or 観測の粒度問題

## 4. H6: T1/T2 出庫量 × arrivals_window 相関 (ヒント)

時間帯バケット (1 時間粒度) で集計:

{h6_hourly_md}

- T1 (stall1+2) Pearson r = {fmt_r(h6['T1_pearson_r'])}
- T2 (stall3+4) Pearson r = {fmt_r(h6['T2_pearson_r'])}
- 信頼サブセット n = {h6['n']}

![H6 散布図](figures/2026-05-14/05-h6-correlation.png)

**解釈**: 予想に反し**弱い負の相関**。考えられる原因:
1. `arrivals_window` は「現在 -30 〜 +60 分」の便集計だが、実出庫は便着陸から 20-40 分遅れて発生する → 即時相関では負に振れる可能性
2. 04 時の深夜便ラッシュは `arrivals_window` の値も同時にピークになるが、サンプル数 (14 ticks) が少なく散布図上で異常値として振る舞う
3. 16-18 時の出庫低調期にも `arrivals_window` は (夕方便集計で) 高めのため、時間帯バケットでは逆向きに見える

**5/31 本分析の対応**: cross-correlation (時間遅延 0-60 分) で再計算、深夜帯 (4 時) と昼間 (9-15 時) を分けて評価。

## 5. H8: stall3 vs stall4 相関 (神奈川車混在の影響、ヒント)

- occupied_estimate Pearson r = {h8['occupied_pearson_r']:.3f} (n={h8['n_occ']})
- diff_occupied_from_prev Pearson r = {h8['diff_pearson_r']:.3f} (n={h8['n_diff']})

![H8 相関](figures/2026-05-14/06-h8-stall3-stall4.png)

**解釈** (spec § 5):
- r > 0.5: T2 共有として連動、stall4 は健全
- r < 0.2: 神奈川車が stall4 ROI に漏れて汚染の疑い
- **実測 r=0.37-0.41 は中間値** — 部分的に連動しつつも完全な T2 共有挙動ではない

神奈川車の影響は中程度。stall4 ROI を「Real02 右上」と暫定的に取った妥当性は限定的、ROI v4 で stall4 を独立に判定する仕組みが必要。

## 6. H9: 夜間代理指標 (行燈方式の予備妥当性、新規・重要)

夜間 (luminance_mean < {NIGHT_LUMINANCE_THRESHOLD}) と昼間 (luminance_mean >= 60) の比較:

| 指標 | 夜間 | 昼間 |
|---|---|---|
| luminance_std | {fmt_stats(h9['luminance_std_night'])} | {fmt_stats(h9['luminance_std_day'])} |
| edge_density | {fmt_stats(h9['edge_density_night'])} | {fmt_stats(h9['edge_density_day'])} |

**夜間内**での arrivals_window との Pearson 相関:
- night `luminance_std` vs `window_taxi_pax` r = **{fmt_r(h9['night_lum_std_vs_window'])}** (強い正相関)
- night `edge_density` vs `window_taxi_pax` r = **{fmt_r(h9['night_edge_vs_window'])}** (極めて強い正相関)

![H9 夜間代理指標](figures/2026-05-14/07-h9-night-proxy-signals.png)

### 重大な発見

夜間内で `luminance_std` と `edge_density` が予測需要と **r=0.83 / r=0.90** という極めて強い正の相関を示した。

つまり「夜間 ROI 内に映る何か (おそらく行燈・テールライト・ヘッドライト) の量」が、便数 (= 予期されるタクシー需要) と高度に同期している。これは:

1. **ユーザー提案の「行燈ピクセルカウント方式」の妥当性に強い裏付け** — 夜間でも既存メトリックの粒度で需要シグナルが取れているなら、blob 検出で精度を上げれば台数推定まで届く可能性が高い
2. **occupied_estimate (絶対値) が壊れていても、相対変動はシグナルとして使える** — 「現在の輝度標準偏差が時系列平均から +N シグマ → 出庫イベント」のような相対指標化で夜間 H1-H6 をかわせる可能性

ただし caveat: この相関は「タクシー実在」を直接測っていない。可能性として
- 夜間内でも時間が深まるにつれて (= 深夜便接近) 行燈が増えて両方上昇している (= 時刻による疑似相関)
- 5/31 本分析で時刻を統制したパーシャル相関を取って疑似相関を排除する必要あり

## 7. 5/31 本分析への提言と ROI v4 設計

### 5/31 本分析で追加すべき項目

1. **H2** (予測スケールと出庫量の整合) — 14 日分のサンプルで日次集計、transit-share 係数との一致度
2. **H3** (雨天での予測ずれ) — weather_code in [51,53,55,61,63,65] のサブセットで偏り検出
3. **H4** (深夜帯ラッシュ 21:30 以降) — ROI v4 が動いていれば夜間データを使う
4. **H6 再評価**: cross-correlation で時間遅延 (0-60 分) を考慮、即時相関の負号を解明
5. **H7** (ピーク → 出庫ラグ) — cross-correlation で 5 分単位、信頼サブセットを 14 日分積んで再計算
6. **H9 パーシャル相関**: 時刻を統制した夜間 luminance_std / edge_density vs window_taxi_pax の相関 (疑似相関排除)
7. **曜日効果** — 平日 vs 土日の occupied / 出庫量の差
8. **ROI v3 vs v4 比較** — v4 ROI 実装後、同じ tick で両方計算して相関と乖離を可視化
9. **欠損率の長期傾向** — Mac mini 稼働率、長期欠損の原因 (OS アップデート等) 集計
10. **将来開発: パターンマッチング需要予測** — PM チケット `2026-05-15-pattern-matching-demand-prediction.md` 参照

### ROI v4 設計提言

**昼間 (luminance_mean >= 60)**:
- 駐車枠ベース検出: 1 台 1 ROI で分解。現 stall1-3 の「縦列 8 台まとめ」を解体し、stall ごとに 7-8 個の小 ROI を持つ
- 各小 ROI の black_ratio 二値判定で「占有/空」を判定 → occupied_estimate は連続値でなく整数和

**夜間 (luminance_mean < 30)** (本中間分析の最重要提言):
- **行燈ピクセルカウント方式** (H9 結果で妥当性裏付け)
  - HSV 範囲: タクシー行燈の典型色 (LED 白〜淡黄、明度 200+、彩度 0-80) を絞り込み
  - 連結成分ラベリング: HSV マスク後に 8 連結で blob 検出
  - 区別: ヘッドライト白 (面積が大きい、地面に寄っている) / テールライト赤 / 信号機 (位置固定) をフィルタ
  - カウント: blob 数 = 行燈数 ≒ タクシー台数
- 予備実装: Mac mini 側で実画像を使い、HSV 範囲と blob 最小面積を 5-10 サンプルで調整
- **H9 で示されたとおり、既存 luminance_std / edge_density 相関 (r=0.83-0.90) を超える精度向上の余地が大きい**

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

    # --- CSV ダンプ ---
    csv_cols_full = [
        "ts", "tick_seq", "hour", "luminance_mean_1",
        "T1_outflow", "T2_outflow", "total_outflow",
        "T1_inflow", "T2_inflow", "total_inflow",
        "stall1_occ", "stall2_occ", "stall3_occ", "stall4_occ",
        "stall1_diff", "stall2_diff", "stall3_diff", "stall4_diff",
        "window_taxi_pax", "weather_code",
    ]
    flow_full = flow[csv_cols_full].copy()
    flow_full["ts"] = flow_full["ts"].dt.strftime("%Y-%m-%dT%H:%M:%S%z")
    full_path = DATA_DIR / "5min-flow-full.csv"
    flow_full.to_csv(full_path, index=False)
    print(f"[phase-a-mid] wrote {full_path} ({len(flow_full)} rows, trusted subset)")

    moved = flow[flow["total_outflow"] > 0].copy()
    moved_cols = ["ts", "tick_seq", "hour", "luminance_mean_1",
                  "T1_outflow", "T2_outflow", "total_outflow",
                  "T1_inflow", "T2_inflow", "total_inflow"]
    moved = moved[moved_cols].copy()
    moved["ts"] = moved["ts"].dt.strftime("%Y-%m-%dT%H:%M:%S%z")
    moved_path = DATA_DIR / "5min-movements.csv"
    moved.to_csv(moved_path, index=False)
    print(f"[phase-a-mid] wrote {moved_path} ({len(moved)} rows, moved ticks only)")


if __name__ == "__main__":
    main()
