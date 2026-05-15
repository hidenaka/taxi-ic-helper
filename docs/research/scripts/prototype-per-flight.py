#!/usr/bin/env python3
"""便ごとの予測 → 実出庫 突き合わせプロトタイプ。

中間分析 (2026-05-14) でラグ分析パイプラインの実証が必要と判明。
現存 data/arrivals.json (今日分 542 便) と data/taxi-pool-history.jsonl
(今日分の v3 信頼サブセット) を突き合わせ、便単位の予測 vs 実出庫を
試算する。

設計上の限界 (本実行で明確化):
- 1 日分しかサンプルがない (5/15 観測時刻まで)
- 過去便の status="到着" は 1 日内のみ
- 5/31 本分析では複数日 × 複数 snapshot で精度向上

出力:
- figures/2026-05-14/10-prototype-per-flight.png
- レポート末尾には組み込まず、別途分析結果を stdout で報告
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from importlib import util

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd

REPO_ROOT = Path(__file__).resolve().parents[3]
ARRIVALS_PATH = REPO_ROOT / "data" / "arrivals.json"
JSONL_PATH = REPO_ROOT / "data" / "taxi-pool-history.jsonl"
FIGURES_DIR = REPO_ROOT / "docs" / "research" / "figures" / "2026-05-14"

JST = timezone(timedelta(hours=9))

# 既存スクリプトから関数を再利用
_spec = util.spec_from_file_location("mid_analysis",
                                      REPO_ROOT / "docs" / "research" / "scripts" / "phase-a-mid-analysis.py")
_mid = util.module_from_spec(_spec)
_spec.loader.exec_module(_mid)


def parse_hhmm_to_today(hhmm: str, anchor_date: datetime.date) -> datetime | None:
    """HH:MM 文字列を anchor_date の datetime (JST) に変換。null は None。"""
    if not hhmm:
        return None
    try:
        h, m = hhmm.split(":")
        return datetime(anchor_date.year, anchor_date.month, anchor_date.day,
                        int(h), int(m), tzinfo=JST)
    except (ValueError, AttributeError):
        return None


def compute_per_flight_outflow(flights: list[dict], flow_df: pd.DataFrame,
                                target_date: datetime.date,
                                window_before_min: int = 5,
                                window_after_min: int = 25) -> pd.DataFrame:
    """各便について「lobbyExitTime - N 分 ~ lobbyExitTime + M 分」の出庫合計を計算。

    flow_df は信頼サブセット (5min tick)、すでに ts/T1_outflow/T2_outflow/total_outflow が揃っている前提。
    戻り値: 便単位の DataFrame ['flightNumber', 'airline', 'terminal', 'from',
                                'scheduled_dt', 'lobby_exit_dt', 'estimatedTaxiPax',
                                'window_total_outflow', 'window_T1_outflow',
                                'window_T2_outflow', 'window_tick_count']
    """
    flow_df = flow_df.copy()
    flow_df["ts"] = pd.to_datetime(flow_df["ts"])

    rows = []
    for f in flights:
        lobby = parse_hhmm_to_today(f.get("lobbyExitTime"), target_date)
        sched = parse_hhmm_to_today(f.get("scheduledTime"), target_date)
        if lobby is None:
            continue
        before = lobby - timedelta(minutes=window_before_min)
        after = lobby + timedelta(minutes=window_after_min)
        mask = (flow_df["ts"] >= before) & (flow_df["ts"] <= after)
        sub = flow_df[mask]
        rows.append({
            "flightNumber": f.get("flightNumber"),
            "airline": f.get("airline"),
            "terminal": f.get("terminal"),
            "from": f.get("from"),
            "scheduled_dt": sched,
            "lobby_exit_dt": lobby,
            "estimatedTaxiPax": f.get("estimatedTaxiPax", 0),
            "window_total_outflow": int(sub["total_outflow"].sum()) if len(sub) else 0,
            "window_T1_outflow": int(sub["T1_outflow"].sum()) if len(sub) else 0,
            "window_T2_outflow": int(sub["T2_outflow"].sum()) if len(sub) else 0,
            "window_tick_count": len(sub),
        })
    return pd.DataFrame(rows)


def main():
    if not ARRIVALS_PATH.exists():
        print(f"ERROR: {ARRIVALS_PATH} not found", file=sys.stderr)
        sys.exit(1)
    arrivals = json.loads(ARRIVALS_PATH.read_text(encoding="utf-8"))
    flights = arrivals.get("flights", [])
    updated_at = arrivals.get("updatedAt")
    print(f"[proto] arrivals.json: {len(flights)} flights, updatedAt={updated_at}")

    # arrivals.json の updatedAt の日付を target_date にする
    updated_dt = pd.to_datetime(updated_at)
    target_date = updated_dt.date()
    print(f"[proto] target_date={target_date}")

    # jsonl から信頼サブセットを作る
    df = _mid.load_jsonl(JSONL_PATH)
    df = _mid.expand_v3_fields(df)
    trusted = _mid.define_trusted_subset(df)
    flow = _mid.compute_outflow_per_tick(trusted)
    flow["ts"] = pd.to_datetime(flow["ts"])
    flow["date"] = flow["ts"].dt.date

    # target_date 部分だけ取り出す
    today_flow = flow[flow["date"] == target_date].copy()
    print(f"[proto] today's flow rows (trusted subset, {target_date}): {len(today_flow)}")
    if len(today_flow) == 0:
        print("[proto] WARNING: 今日分の信頼サブセットが 0 行。観測時刻が早すぎ / 夜間データ除外で空。")
        # それでも便→出庫マッピングのプロトタイプは動かす (出庫 0 で全便埋まる)
    today_flow_ts_range = (today_flow["ts"].min(), today_flow["ts"].max()) if len(today_flow) else (None, None)
    print(f"[proto] today's flow ts range: {today_flow_ts_range}")

    # 便単位の突き合わせ
    per_flight = compute_per_flight_outflow(flights, today_flow, target_date)
    print(f"[proto] per_flight rows: {len(per_flight)}")

    # arrivals.json の更新時刻より過去にロビー出口を予定する便だけ「実観測対象」とする
    # (= 既に出庫イベントが完了しているはずの便)
    past_flights = per_flight[per_flight["lobby_exit_dt"] <= updated_dt].copy()
    print(f"[proto] 既に lobbyExitTime を過ぎた便: {len(past_flights)} / {len(per_flight)}")

    # 重要: 観測 ROI は第1-第4乗り場 = T1/T2 のみ。
    # T3 は物理的に別乗り場 (国際線ターミナル) で画像に映っていない。
    # T3 便は別集計とし、メイン分析からは除外する。
    t3_flights = past_flights[past_flights["terminal"] == "T3"].copy()
    past_flights = past_flights[past_flights["terminal"].isin(["T1", "T2"])].copy()
    print(f"[proto] 観測対象 (T1+T2) 便: {len(past_flights)}, 観測対象外 (T3) 便: {len(t3_flights)}")

    # 集計: 便ごとの予測 vs 観測出庫
    if len(past_flights) > 0:
        print("\n[proto] === 過去便 (lobby exit time が既に過ぎた便) のサンプル ===")
        sample = past_flights.sort_values("lobby_exit_dt")[
            ["flightNumber", "airline", "terminal", "from", "lobby_exit_dt",
             "estimatedTaxiPax", "window_total_outflow", "window_T1_outflow",
             "window_T2_outflow", "window_tick_count"]
        ].head(40)
        print(sample.to_string(index=False))

        # 集計: estimatedTaxiPax と window_total_outflow の相関
        corr = past_flights[["estimatedTaxiPax", "window_total_outflow"]].corr().iloc[0, 1]
        print(f"\n[proto] estimatedTaxiPax vs window_total_outflow (n={len(past_flights)}) Pearson r = {corr:.3f}")

        # ターミナル別集計
        print("\n[proto] === ターミナル別の予測 vs 実観測合計 ===")
        by_terminal = past_flights.groupby("terminal").agg(
            n_flights=("flightNumber", "count"),
            sum_estimatedTaxiPax=("estimatedTaxiPax", "sum"),
            sum_window_total_outflow=("window_total_outflow", "sum"),
            sum_window_T1=("window_T1_outflow", "sum"),
            sum_window_T2=("window_T2_outflow", "sum"),
        )
        print(by_terminal.to_string())

        # figure 10: 便ごとの予測 vs 実観測 散布図
        fig, axes = plt.subplots(1, 2, figsize=(12, 5))
        for ax, terminal_filter, title_suffix in [
            (axes[0], None, "all terminals"),
            (axes[1], ["T1", "T2"], "T1+T2 only"),
        ]:
            sub = past_flights
            if terminal_filter:
                sub = past_flights[past_flights["terminal"].isin(terminal_filter)]
            if len(sub) == 0:
                ax.text(0.5, 0.5, "no data", ha="center", transform=ax.transAxes)
                ax.set_title(f"per-flight: predicted vs observed ({title_suffix}, n=0)")
                continue
            ax.scatter(sub["estimatedTaxiPax"], sub["window_total_outflow"], s=30, alpha=0.6)
            for _, row in sub.iterrows():
                if row["window_total_outflow"] > 0 or row["estimatedTaxiPax"] > 20:
                    ax.annotate(row["flightNumber"],
                                (row["estimatedTaxiPax"], row["window_total_outflow"]),
                                fontsize=7, alpha=0.7)
            ax.set_xlabel("estimatedTaxiPax (predicted)")
            ax.set_ylabel(f"window_total_outflow (lobby_exit -5min ~ +25min)")
            r = sub[["estimatedTaxiPax", "window_total_outflow"]].corr().iloc[0, 1]
            ax.set_title(f"per-flight: predicted vs observed ({title_suffix}, n={len(sub)}, r={r:.3f})")
            ax.grid(True, alpha=0.3)
        fig.suptitle(f"Per-flight prediction vs observed outflow PROTOTYPE ({target_date}, 1 day only)",
                     y=1.02, fontsize=10)
        fig.tight_layout()
        out = FIGURES_DIR / "10-prototype-per-flight.png"
        fig.savefig(out, dpi=120, bbox_inches="tight")
        plt.close(fig)
        print(f"\n[proto] wrote {out}")
    else:
        print("[proto] 過去便なし、散布図スキップ。arrivals.json の更新時刻が古いか、観測がほとんど始まっていない")

    # 個別便: T1+T2 ピーク tick との突き合わせ
    if len(today_flow) > 0:
        print("\n[proto] === 今日の出庫ピーク tick 上位 5 件 ===")
        top_ticks = today_flow.sort_values("total_outflow", ascending=False).head(5)
        for _, tick_row in top_ticks.iterrows():
            tick_ts = tick_row["ts"]
            print(f"\n  tick {tick_ts.strftime('%H:%M')}  T1={int(tick_row['T1_outflow'])} T2={int(tick_row['T2_outflow'])} total={int(tick_row['total_outflow'])}")
            # この tick の前 30 分以内に lobby_exit_dt がある便
            before = tick_ts - timedelta(minutes=30)
            after = tick_ts + timedelta(minutes=5)
            candidate_flights = per_flight[
                (per_flight["lobby_exit_dt"] >= before)
                & (per_flight["lobby_exit_dt"] <= after)
            ].sort_values("lobby_exit_dt")
            if len(candidate_flights) == 0:
                print("    (このピーク tick の前 30 分以内にロビー出口を予定する便なし)")
            else:
                for _, fr in candidate_flights.iterrows():
                    print(f"    {fr['flightNumber']}({fr['airline']}) "
                          f"{fr['from']}→{fr['terminal']} "
                          f"sched={fr['scheduled_dt'].strftime('%H:%M') if pd.notna(fr['scheduled_dt']) else 'n/a'} "
                          f"lobby={fr['lobby_exit_dt'].strftime('%H:%M')} "
                          f"taxiPax_pred={fr['estimatedTaxiPax']}")


if __name__ == "__main__":
    main()
