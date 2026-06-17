# 羽田プール現地案内テキストの取得と乗り場(号)補正 — 設計 (Phase 1)

- 日付: 2026-06-17
- 対象リポジトリ: taxi-ic-helper(取得) / taxi-daily-report(表示)
- 方針: 段階式(A)。Phase 1=取得＋器＋生テキスト掲示。Phase 2=便→号パーサ(実テキスト確保後)

## 1. 背景・目的
到着便ビューは各便の乗り場(号 1〜4 = 折口)を表示しているが、これは ODPT/羽田公式APIに号が無いため、ターミナル/wingからの**静的マッピングで推定**している。通常便は合うが、**深夜の遅延便はイレギュラーで実際の折口が通常と異なる**(例: 通常4号→今夜は3号)。タクシーセンターのプール状況サイト(カメラ画像と同一サイト)は、遅延時に**どの便がどの乗り場に着くかをテキストで掲示**する。これを取得し、号を現地案内に合わせて補正、変化を `4→3` のように可視化する。

## 2. 用語
- **号 / 折口**: タクシープールの乗り場番号(1〜4)。
- **推定号 (`poolLane`)**: 現行の静的マッピング由来。
- **確定号 (`poolLaneConfirmed`)**: センター案内テキスト由来(出ている時のみ)。
- **末尾規制**: 入構できる車のナンバー末尾(奇数/偶数)。入構可否に直結。

## 3. データソース
- `https://ttc.taxi-inf.jp/index.php` … 第1待機所南側。`<td>` に掲示テキスト(現状: `末尾規制【奇数】`＋常設お知らせリンク)。カメラ画像 Real01_line.jpg と同居。
- `https://ttc.taxi-inf.jp/no23.php` … 第3・第4待機所。`<td>` に掲示テキスト。
- No4TaxiStand.php / No5TaxiStand.php … 定型文(プライバシー注記)のみ=対象外。
- 特性: 30秒で自動リフレッシュ、no-cache、**国内IP前提**(米国GitHub Actionsからは弾かれるリスク→取得はMac miniで)。遅延案内は不定期(主に深夜・悪天候)。

## 4. アーキテクチャ / データフロー
```
ttc.taxi-inf.jp (index.php / no23.php)
  ↓ Mac miniで取得(JP IP・カメラと同経路)
scripts/fetch-pool-notice.mjs → data/pool-notice.json
  ↓ observe-tick が commit & push(git-safe-sync 堅牢化済み)
relay-taxi-data.yml が tools/data/pool-notice.json をアプリへ配信
  ↓
日報アプリ 到着便ビューが pool-notice.json を読み、号の補正(4→3)/末尾規制/生テキストを表示
```

## 5. Phase 1 スコープ(作るもの)
1. `scripts/fetch-pool-notice.mjs`(taxi-ic-helper)
   - index.php / no23.php を取得 → `<td>` 抽出 → タグ除去でプレーン化(改行保持)。
   - **常設お知らせの除去**: `【…について】` 見出し＋ `tokyo-tc.or.jp` URL 行を落とし、当日の運用テキストだけを `liveText` に残す。
   - **高信頼の構造化2点のみ**:
     - `tailRegulation`: `末尾規制【奇数|偶数】` を正規表現で抽出(`"奇数"|"偶数"|null`)。
     - `hasFlightNotice`: 便名(JL/NH/便/航空)＋号/乗り場/待機所＋時刻(HH:MM)/遅延 の語があるか(真偽)。
   - `flightNoticeText`: 遅延便関連と判定した抜粋(無ければ空)。
   - 出力 `data/pool-notice.json`(tracked・配信)。取得失敗時は**前回JSONを保持**(空上書きしない)。
   - 追記 `data/pool-notice-history.jsonl`(**ローカルのみ**=生履歴局所保持の方針に従う。Phase 2 の実例教師)。
2. `scripts/lib/pool-notice.mjs`: 抽出・除去・末尾規制・hasFlightNotice の純関数(テスト対象)。
3. スケジューリング: `observe-tick-local.sh` に `node scripts/fetch-pool-notice.mjs || true` を追加(5分間隔・fail-safe)。`data/pool-notice.json` を git add リストに追加。コミット要否ゲートは既存の `advance-forecast.json`(毎tick変化)のままで同乗。
4. 配信: `relay-taxi-data.yml` の paths と FILES に `data/pool-notice.json` を追加。
5. データモデル拡張(arrivals): 各便に `poolLaneConfirmed`(既定 null)と `poolLaneSource`(`"estimate"|"center-notice"`)を持たせる**器だけ**用意。Phase 1 では常に null(パーサ未実装のため)。
6. アプリ表示(taxi-daily-report 到着便ビュー):
   - `tools/data/pool-notice.json` を読み込む。
   - `hasFlightNotice` の時だけ「🚖 タクシーセンター現地案内(◯:◯◯時点)」として `liveText` をそのまま掲示(私たちの推定でなく**現地確定**として明確に区別)。
   - `tailRegulation` が出ていれば入構可否として目立つ位置に常時表示。
   - 号表示の補正器: 便に `poolLaneConfirmed` があり推定と異なれば `4→3` を強調＋「現地確定」マーク、同じなら「確認済」マーク、無ければ現行どおり。Phase 1 では発火しない(器のみ)。

## 6. データモデル
`data/pool-notice.json`:
```json
{
  "updatedAt": "2026-06-17T10:06:00+09:00",
  "sources": {
    "no1":  { "fetchedAt": "...", "ok": true },
    "no34": { "fetchedAt": "...", "ok": true }
  },
  "tailRegulation": "奇数",
  "liveText": "末尾規制【奇数】\nおもてなしレーンに入構する際は…",
  "hasFlightNotice": false,
  "flightNoticeText": ""
}
```
arrivals の各便(追加分): `poolLaneConfirmed: number|null`, `poolLaneSource: "estimate"|"center-notice"`。

## 7. アプリ表示ルール(到着便ビュー)
| 条件 | 表示 |
|---|---|
| 確定号あり かつ 推定≠確定 | **「4→3」**＋「現地確定」マーク |
| 確定号あり かつ 推定=確定 | 号＋「確認済」マーク |
| 確定号なし | 現行どおり(推定号のみ) |
| `hasFlightNotice` | 「🚖 タクシーセンター現地案内」バナーに `liveText` 掲示 |
| `tailRegulation` あり | 入構可否(奇数/偶数)を目立つ位置に |
| いずれも無し | バナー非表示(普段は邪魔しない) |

## 8. Phase 2(今回は作らない)
`data/pool-notice-history.jsonl` に実テキストが数件貯まったら `scripts/lib/pool-notice-parser.mjs` を**実テキストに対してTDDで**実装し、便→号(折口)を抽出。arrivals の `poolLaneConfirmed`/`poolLaneSource` を埋め、到着便ビューの `4→3` を発火。想像書式に対するパースは作らない(進入ガイドの「答えを知った検証はバイアス」の教訓)。

## 9. エラー処理 / 安全劣化
- 取得失敗(サイト落ち/タイムアウト/非200): 前回 `pool-notice.json` を保持。observe-tick からは `|| true` で fail-safe。
- HTML構造変化: `<td>` 抽出失敗 → `liveText` 空 → `hasFlightNotice=false` → バナー非表示で安全に劣化。
- パース誤り(Phase 2): 確定号が取れない便は推定号にフォールバック(現行動作)。

## 10. テスト(Phase 1)
- 取得済みの**実HTML(現 index.php / no23.php)を fixture** にして純関数をユニットテスト(`tests/pool-notice.test.mjs`, node:test):
  - `<td>` 抽出 → プレーン化(改行保持)。
  - 常設お知らせ除去(tokyo-tc.or.jp 行/`【…について】`)。
  - `tailRegulation` 抽出(`末尾規制【奇数】`→`"奇数"`)。
  - `hasFlightNotice` 判定(現状の通常テキスト→false。便名+号+時刻を含む合成例→true)。
- 既存全テスト緑を維持。

## 11. 非対象(YAGNI)
- 便→号パーサ本体(Phase 2)。
- No4/No5 待機所(定型文のみ)。
- 末尾規制以外の運用ルール(おもてなしレーン等)の構造化(生テキスト掲示で足りる)。
- カメラ画像のOCR(テキストは HTML にあるので不要)。

## 12. リスク / 未決
- 実テキストの書式が未確認 → Phase 1 でキャプチャして確保(自動・待ち)。
- ttc.taxi-inf.jp の国内IP制限 → Mac mini取得で回避(カメラで実績)。
- 取得間隔5分で遅延案内を取りこぼす可能性は低い(掲示は分単位では変わらない)。必要なら 60秒(t3-front-flowに同乗)へ移行可。
