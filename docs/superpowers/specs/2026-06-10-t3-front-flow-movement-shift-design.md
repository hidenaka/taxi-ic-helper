# T3 前方プール 流れ計測（movement-shift 移植）設計書

> 作成: 2026-06-10
> 対象: taxi-ic-helper / 羽田 T3 第3待機所「前方（Real108）」のタクシー列の流れ速度計測
> 関連: `2026-05-21-t3-pool-fill-observation-design.md`（T3 埋まり具合・稼働中）、
>      T1/T2 movement-shift 系（`scripts/movement-shift-tick.mjs` / `scripts/lib/advance-counter.mjs` / `scripts/lib/advance-forecast.mjs`）
> 外部レビュー: Codex（2026-06-10）の指摘を反映（ROI 粒度・極性・フレーム鮮度・段階化）

## 目的

T1/T2 で稼働中の「列移動の回数 → 流れ具合」計測方式を、T3 第3待機所の**前方（Real108＝乗り場へ出ていく側）**に移植する。「T3 の列がどれくらいの速さで流れているか（捌けているか／詰まっているか）」を相対指標で出し、既存の T3 埋まり具合（fill 率）と並べて乗務員の「行く価値あるか」判断材料にする。

個々の台数は数えない。**列が前に動く／前が捌けるイベントの単位時間あたり頻度**を測る相対フロー指標。

## 背景

### T1/T2 の既存「流れ計測」パイプライン（移植元）

| 段 | 実装 | 役割 |
|---|---|---|
| 観測 | `movement-shift-tick.mjs`（60秒） | 乗り場先頭エリアの面密度 `frontDensity`（昼=平均輝度／夜=行灯の光点割合×係数）を記録 → `movement-shift-history.jsonl` |
| 計数 | `advance-counter.mjs::detectReplenishments` | 先頭密度の時系列の「立ち上がりエッジ（手薄→補充）」を持続条件＋debounce で 1 イベントに |
| 集計 | `advance-counter.mjs::binCountsByWindow` | 15分窓ごとのイベント数＝流れ具合 |
| 予測 | `advance-forecast.mjs` / `publish-advance-forecast.mjs` | 流れ回数の時系列から予測を生成・配信 |

これらの**純関数（`frontSignal` / `detectReplenishments` / `detectAdvances` / `medianSmooth` / `binCountsByWindow`）は画像 I/O から独立**しており、そのまま再利用できる。

### なぜ T3 でこの方式なら成立するか

- 過去 spec（`2026-05-20-t3-slot-occupancy`）の「9レーンのマス目で在台数→出庫カウント」は **Real106/107 にレーンが映らず棄却**された。
- 流れ計測は**個々のレーン／台を解像する必要がなく、前方エリアの密度の時間変化だけ見る**。Real108 は前方プールが正面に映っており、密度変化は観測できる。5/21 の棄却理由（レーン非解像）に抵触しない。

### 既存 T3 fill 率との関係

`t3-pool-fill.json`（埋まり具合：空き/半分/混雑）とは**別軸の指標**。fill 率＝「今どれだけ溜まっているか（量）」、本指標＝「どれだけ動いているか（流速）」。両者を並べて「後方満杯＋前方が速く流れる＝大量供給で回転中」「前方が動かない＝詰まり」を読む。

## 外部レビュー（Codex）で判明したリスクと対応

| # | リスク | 対応（本設計に反映） |
|---|---|---|
| R1 | T1/T2 は「狭い先頭2列」で密度変化≒列前進。T3 前方は**広い貯留域**で、詰め方・車線変更・局所再配置でも密度が動く | ROI を fill 用の広い矩形ではなく**出口直前の細い gate ROI**に絞る（§設計1） |
| R2 | fill 用 `areas.front` の流用はフロー検出に鈍い | gate ROI を新規定義。将来 2ROI（出口側／補充側）に拡張可能な構造 |
| R3 | 前方＝出口側の一次信号は「出庫で**減る**（下降エッジ）」のはず。`立ち上がり=補充=流れ` を当てると符号違い／遅延を数える | **極性を決め打ちしない。生の `frontDensity` を記録し、上昇・下降の両エッジ計数を併記**。極性は実データ検証後に確定（§段階化 Phase 2） |
| R4 | ttc 画像の実更新は不規則・キャッシュ混入。60秒 tick で**同一フレーム連打** → persistSec/debounce が無意味化 | **ETag/Last-Modified で重複排除**。履歴行に**フレームの実 Last-Modified（`frame_ts`）を記録し、計数の時刻軸に使う**（§設計3）。実測で更新は約1〜2分間隔と確認済み |
| R5 | `persistSec=120s` は T1/T2 の時定数の持ち込み。T3 の広いプールに合うか不明 | Phase 1 はログ専用。**1日分のデータで感度分析**してから閾値確定（§段階化 Phase 2） |
| R6 | `b5(frontDensity)` 単独は計測実験としては妥当だが予測入力としては弱い（lag がないと「流れた」か「枯れた」か区別不可） | Phase 1〜2 はログ＋オフライン検証に限定。**advance-forecast 接続は Phase 3 に分離**し、検証が通ってから |

## 採用アプローチ

**まず「ログ専用の生信号収集」として導入し、極性・閾値・予測接続は実データ検証後に確定する段階設計。**

T1/T2 の純関数を再利用しつつ、T3 固有の「広い貯留域・出口側極性・フレーム鮮度」リスクを実データで潰してから本接続する。

### 不採用

- **fill 用 `areas.front`（広 ROI）をそのまま流れ計測に流用** — R1/R2。鈍くて誤検出が多い
- **`detectReplenishments`（立ち上がり=補充）を即本接続** — R3。極性未検証のまま予測に入れると逆符号リスク
- **tick 時刻を計数の時刻軸に使う** — R4。同一フレーム連打で時刻がずれる。`frame_ts`（Last-Modified）を使う
- **b3（クロス相関 lag）の同時導入** — MVP スコープ外。Phase 1 は b5（面密度）のみ。lag は前方の流速方向が確定してから別フェーズで検討

## 設計

### 1. gate ROI 定義（新ファイル `data/t3-front-flow-rois.json`）

Real108 の**出口直前の細い帯状 ROI** を 1 個定義する。fill 用 `t3-pool-rois.json` とは別ファイル（用途・粒度が違うため混ぜない）。

```json
{
  "_meta": { "image_size": [1024, 576], "note": "T3 前方(Real108) 流れ計測用 gate ROI。出口直前の細い帯。座標は校正で確定" },
  "schema_version": 1,
  "camera": "Real108",
  "gate": { "x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0 },
  "params": {
    "nightLum": 60,
    "lanternK": 4,
    "lanternT": 50
  }
}
```

- `gate`: 出口直前の細い矩形（正規化）。校正フェーズで実画像から確定（spec 時点はプレースホルダー 0.0）
- 将来 2ROI 化（`gate_exit` / `gate_supply`）したくなったらこのファイルに追記して拡張
- `params`: 昼夜出し分けの定数（T1/T2 の `frontSignal` opts と同形）

### 2. 面密度信号の算出（既存純関数を流用）

`scripts/lib/advance-counter.mjs::frontSignal(img, box, opts)` をそのまま使う。`box` に gate ROI（正規化 → `{x0,x1,y0,y1}` 形式）を渡す。

- 昼（box 平均輝度 ≥ nightLum）= 平均輝度
- 夜 = 行灯の光点割合 × lanternK

T3 固有の画像解析ロジック追加は**なし**。

### 3. 観測 tick（新設・60秒・フレーム重複排除つき）

新ファイル `scripts/t3-front-flow-tick.mjs`。`movement-shift-tick.mjs` をベースに以下を変更：

| 項目 | 内容 |
|---|---|
| 取得画像 | `https://ttc.taxi-inf.jp/Real108.jpg` を都度 fetch（T1/T2 のようなアーカイブは無いため直接取得） |
| **重複排除（必須）** | レスポンスの `Last-Modified`／`ETag` を `data/t3-front-flow-state.json` に保持。**前回と同じフレームなら history に追記しない**（同一フレーム連打防止）。判定は `Last-Modified` 優先、無ければ画像バイト列の md5 |
| **時刻軸** | 履歴行に `frame_ts`（Last-Modified を JST ISO 化）と `tick_ts`（観測時刻）の両方を記録。**後段の計数は `frame_ts` を時刻軸に使う** |
| 信号 | gate ROI で `frontSignal` → `frontDensity` |
| 出力 | `data/t3-front-flow-history.jsonl` に追記 |
| 失敗時 | try/catch で握り exit 0（本流の observe/forecast を止めない） |

履歴行スキーマ：

```json
{
  "schema_version": 1,
  "frame_ts": "2026-06-10T02:18:11+09:00",
  "tick_ts":  "2026-06-10T02:19:36+09:00",
  "camera": "Real108",
  "is_night": false,
  "front_density": 84.2,
  "frame_hash": "af655cd..."
}
```

`frame_ts` が前行と同じ tick は**書き込まない**（dedup 済み）。これにより `times[]` が実フレーム時刻になり、`persistSec` / `debounce` が意味を持つ。

### 4. オフライン分析（新設・両極性を併記）

新ファイル `scripts/t3-front-flow-report.mjs`（`movement-advance-report.mjs` 相当）。`t3-front-flow-history.jsonl` を読み、**極性を決め打ちせず両方を出す**：

- `medianSmooth` でノイズ除去
- 上昇エッジ計数：`detectReplenishments(values, frame_ts_sec, opts)`（補充＝詰め）
- 下降エッジ計数：`detectAdvances` または上昇/下降対称版で「枯渇＝出庫」を計数（R3：前方は下降が一次信号の可能性）
- `binCountsByWindow` で 15分／1時間窓に集計
- 既存 `t3-pool-fill.json` の時系列との相関を併記（どちらの極性が fill 率の減少と整合するか）

出力 `data/t3-front-flow-report.json`（検証用・上書き）：

```json
{
  "schemaVersion": 1,
  "generatedAt": "...",
  "windowMin": 15,
  "rising":  [ { "windowStart": "...", "count": 3 } ],
  "falling": [ { "windowStart": "...", "count": 5 } ],
  "params": { "absThreshold": "...", "persistSec": "...", "debounceSec": "..." }
}
```

### 5. Mac mini 側の配線

- **launchd**: `jp.taxi-ic-helper.t3-front-flow` を新設（`StartInterval=60`, `RunAtLoad=false`）。`install-movement-shift-launchd.sh` を参考にインストールスクリプト or 手順を用意
- **`observe-tick-local.sh`**: `git add` 対象に `data/t3-front-flow-history.jsonl` を追加
- **`.gitattributes`**: `data/t3-front-flow-history.jsonl merge=union`（append-only 衝突回避、既存 history 系と同じ扱い）
- `data/t3-front-flow-state.json`・`data/t3-front-flow-report.json` は再生成系（pull 前 checkout 対象）

## 段階化（フェーズ）

| Phase | 内容 | 完了条件 |
|---|---|---|
| **Phase 1（本 spec の実装スコープ）** | gate ROI 校正 ＋ 60秒 tick（dedup つき）で `t3-front-flow-history.jsonl` にログ収集。**予測には未接続** | Mac mini で 24h 連続ログが溜まり、`frame_ts` が約1〜2分刻みで重複なく並ぶ |
| **Phase 2（別 spec）** | 1日分で感度分析。極性（上昇 vs 下降）・`absThreshold`・`persistSec` を確定。`t3-pool-fill.json` との相関で「流れ」の妥当性を検証 | どちらの極性・閾値が現実の捌け方と整合するか目視＋相関で確定 |
| **Phase 3（別 spec）** | 確定した極性・閾値で `advance-forecast` 相当に接続。日報アプリ T3 ページに「流れ具合」を表示 | 流れ予測が配信され、表示される |

## データフロー（Phase 1）

```
Real108.jpg（ttc・実更新 約1〜2分）
    │  60秒 tick が fetch
    ├─ Last-Modified/ETag が前回と同じ → skip（dedup）
    └─ 新フレーム → gate ROI を frontSignal → front_density
            │
            └─ t3-front-flow-history.jsonl に追記（frame_ts 付き）
                    │  （Phase 2 のオフライン分析）
                    └─ medianSmooth → 上昇/下降エッジ計数 → binCountsByWindow
                            → t3-front-flow-report.json（検証用）
```

## テスト方針（TDD）

純関数中心。実画像・校正・極性は目視＋実データ。

### 流用（テスト追加なし）

- `frontSignal` / `meanGrayInBox` / `brightPixelRatio` / `pickFrontSignal`（既存テスト済み）
- `detectReplenishments` / `detectAdvances` / `medianSmooth` / `binCountsByWindow`（既存テスト済み）

### 新規追加するテスト

| 対象 | テスト内容 |
|---|---|
| gate ROI パース（`t3-front-flow-rois.json`） | schema_version=1、`camera`/`gate`/`params` 抽出、ROI 欠損時の throw |
| フレーム重複排除（純関数として切り出す） | 同一 `Last-Modified` 連続 → 2回目以降 skip 判定、異なる → 採用 |
| 履歴行ビルダー（純関数） | `frame_ts`/`tick_ts`/`front_density`/`frame_hash` を持つ行を組み立てる |
| `t3-front-flow-tick.mjs` の try/catch 挙動 | 例外時 exit 0、既存 observe/forecast 不変（モック） |

校正・極性確定・閾値調整は TDD 対象外（Phase 2 で実データ）。

## スコープ外

- **極性・閾値の確定**（Phase 2）
- **予測接続・日報アプリ表示**（Phase 3）
- **b3（クロス相関 lag）方式**の同時導入
- **2ROI（出口側／補充側）化** — Phase 1 は gate 1個。構造は拡張可能にしておく
- **後方 Real109 の流れ計測** — まず前方のみ
- 台数の正確なカウント

## 既存への影響

ゼロ。すべて `t3-front-flow-*` プレフィックスで新設。既存 `movement-shift-tick.mjs` / `t3-pool-fill.mjs` / `observe-taxi-pool.mjs` の既存処理・forecast は不変。新 tick は独立 launchd ジョブで、失敗しても本流に影響しない。

## 成功基準

1. **コード**: `scripts/t3-front-flow-tick.mjs`・`scripts/lib`（dedup/行ビルダー純関数）・`data/t3-front-flow-rois.json`（校正後実値）・新 launchd ジョブが main に commit され、Mac mini の次 tick から `t3-front-flow-history.jsonl` への追記が走る
2. **テスト**: 新規純関数テストが pass、既存テストが回帰なし
3. **重複排除**: 同一フレーム期間に複数 tick が走っても history に重複行が出ない（`frame_ts` がユニーク）
4. **校正**: gate ROI が目視で「出口直前の帯」に重なる
5. **実データ**: 24h ログで `front_density` が時間帯（深夜=低い／混雑時=変動大）と整合し、Phase 2 の感度分析に使える粒度（約1〜2分刻み）で溜まる
