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


if __name__ == "__main__":
    main()
