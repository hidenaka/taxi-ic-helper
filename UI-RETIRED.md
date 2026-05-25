# taxi-ic-helper の UI ページは廃止しました (2026-05)

このリポジトリの UI ページ (index.html / arrivals.html / forecast.html / ic.html) と
GitHub Pages 公開 (.github/workflows/pages.yml) は廃止しました。

- **UI は日報アプリ (taxi-daily-report の `tools/`) に移管済み**。ユーザーはそちらを使う。
- データは `.github/workflows/relay-taxi-data.yml` が
  `data/{arrivals,stall-ensemble,stall-actuals,t3-pool-fill}.json` を
  日報リポ(dev/prod)の `tools/data/` へ配信する (Pages 経由ではない)。
- **このリポは引き続き必要**: Mac mini 観測 (`scripts/`)、データ生成、relay 配信。
- `js/` は移管前のUIロジックで現在は未使用だが、`tests/` 15本が依存しているため温存
  (完全削除は tests ごと別途)。

ライブ公開を完全に止めるには GitHub の Settings → Pages → Source を None にする
(コード側だけでは最後のデプロイがしばらく残る)。
