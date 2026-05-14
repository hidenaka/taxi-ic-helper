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


# inline test: 純関数 get_nested の挙動
assert get_nested({"a": {"b": 1}}, "a", "b") == 1
assert get_nested({"a": {"b": 1}}, "a", "c") is None
assert get_nested(None, "a") is None
assert get_nested({"a": None}, "a", "b") is None


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
