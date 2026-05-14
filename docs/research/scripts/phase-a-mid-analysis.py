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


def main() -> None:
    FIGURES_DIR.mkdir(parents=True, exist_ok=True)
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


if __name__ == "__main__":
    main()
