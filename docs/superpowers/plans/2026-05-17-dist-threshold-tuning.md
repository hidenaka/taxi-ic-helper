# DIST_THRESHOLD の値設定 実装 Plan（C 後半）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** トラッカーのマッチ許容半径 `DIST_THRESHOLD` を、実測ジッター（`matched_dists` 3154 サンプル）に基づき `0.06` から `0.025` に変更する。

**Architecture:** `scripts/track_vehicles.py` の定数 `DIST_THRESHOLD` を 1 行変更するのみ。`update_tracks` 純関数は `dist_threshold` を引数で受けるためロジック不変。既存テストは閾値を明示引数で渡しており定数非依存のため不変。

**Tech Stack:** Python 3（`unittest`）。新依存なし。

**Spec:** `docs/superpowers/specs/2026-05-17-dist-threshold-tuning-design.md`

**git 運用:** main 直 push 運用（feature branch なし）。worktree 不要、main workdir で作業。Task の最後に commit → `git pull --rebase --autostash origin main` → `git push origin main`。コミットは scripts のみ、観測データ（`data/*`）は混ぜない（`git diff --cached --name-only` で確認、混入時 `git restore --staged data/<file>`）。コミットメッセージ末尾に `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`。

**作業ディレクトリ:** `/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係`（以下、全パスはここからの相対）。

**テストコマンド:** `.venv.nosync/bin/python3 -m unittest tests.test_track_vehicles tests.test_detect_vehicles -v`

---

## File Structure

| ファイル | 役割 | Task |
|---|---|---|
| `scripts/track_vehicles.py` | **改修**。定数 `DIST_THRESHOLD` を 0.06 → 0.025（1 行 + コメント）。 | 1 |

テスト追加なし: `update_tracks` のマッチアルゴリズムは既存 unittest（閾値を明示引数で渡す）が閾値非依存に検証済み。`DIST_THRESHOLD` は deploy パラメータでありロジックではないため、変更の検証は構文/import チェック + 既存 unittest 回帰（結果不変）で行う。

---

## Task 1: `DIST_THRESHOLD` を 0.025 に変更

**Files:**
- Modify: `scripts/track_vehicles.py`（定数 `DIST_THRESHOLD`）

- [ ] **Step 1: 定数を変更**

`scripts/track_vehicles.py` の現在の定数行:

```python
DIST_THRESHOLD = 0.06
```

を、以下に置換:

```python
DIST_THRESHOLD = 0.025  # 実測ジッター由来 (matched_dists 累積94%が ≤0.025、駐車間隔 0.035 未満)
```

> この行は定数ブロック内（`MAX_MISSED = 2` の次の行）にある。`MAX_MISSED` や他の定数は変更しない。

- [ ] **Step 2: 構文・import チェック**

Run: `.venv.nosync/bin/python3 -m py_compile scripts/track_vehicles.py && .venv.nosync/bin/python3 -c "import sys; sys.path.insert(0, 'scripts'); import track_vehicles; print('DIST_THRESHOLD=' + str(track_vehicles.DIST_THRESHOLD))"`
Expected: `DIST_THRESHOLD=0.025`（構文エラーなし、定数が 0.025 になっている）

- [ ] **Step 3: Python unittest 回帰**

Run: `.venv.nosync/bin/python3 -m unittest tests.test_track_vehicles tests.test_detect_vehicles 2>&1 | tail -4`
Expected: PASS — `OK`（track 29 + detect 13 = 42 tests、fail 0）。テストは `update_tracks` に閾値を明示引数で渡すため、定数変更の影響を受けず結果は不変。

- [ ] **Step 4: コミット**

```bash
git add scripts/track_vehicles.py
git diff --cached --name-only   # scripts/track_vehicles.py のみ。data/ が混ざっていないこと
git commit -m "$(cat <<'EOF'
feat: DIST_THRESHOLD を 0.06 → 0.025 に適正化（C 後半）

実測ジッター 3154 サンプル分析: 累積94%が ≤0.025、駐車間隔 0.035 未満。
隣の駐車車への誤マッチを排除。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git pull --rebase --autostash origin main && git push origin main
```

---

## 完了後

- Python unittest 全 pass（track 29 + detect 13 = 42、結果不変）。`npm test` は不変（JS 系は触らない）。
- 次の track tick（Mac mini）から新しい `DIST_THRESHOLD=0.025` でフレーム間マッチが行われる。0.035 を超える誤マッチが排除される。
- `update_tracks` のロジック・引数シグネチャは不変。

**Mac mini デプロイ:** `~/repos/taxi-ic-helper` で `git pull` のみ（observe-tick が自動実行）。新依存なし、launchd 変更なし。

**後続（本 plan のスコープ外・要再測定）:** デプロイ後に `matched_dists` を再蓄積し、real01_line のマッチ距離分布が締まったか確認。締まらず 0.03 付近に厚いままなら、貪欲＋距離マッチを IoU ベース等に変える別タスクへエスカレーション（spec スコープ外節）。
