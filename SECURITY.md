# セキュリティ方針

- Date: 2026-09-02
- Related: ADR-001（完全クライアント側処理）, ADR-004（配信・CSP）, COMPLIANCE.md

## 脆弱性の報告

GitHub の [Security Advisories](https://github.com/saita-teppei/pdf-compressor/security/advisories/new)
から非公開で報告してください。公開 Issue には**書かないで**ください。

## 本サービスの攻撃面

PDF はサーバーへ送信されず、ブラウザ内で処理されます（ADR-001）。したがってサーバー側に
利用者データは存在しません。攻撃面は次の3つに限られます。

1. **配信物の改ざん** — 静的アセットと WASM。CSP（`svelte.config.js` の `kit.csp`, hash モード）と
   `static/_headers` で緩和。`pdfcpu.wasm` のみ jsdelivr から取得し、**版固定＋SHA-256 検証**を行う
   （ADR-004, `src/lib/engines/pdfcpu-engine.ts`）。
2. **ビルドパイプラインへの不正コード混入** — 下記「リポジトリ／CI の保護」。
3. **悪意ある PDF による WASM エンジンの異常動作** — 処理は Web Worker 内に隔離され、
   出力が入力を超える場合は元ファイルを維持する（"don't grow" ガード, ADR-007/010）。

## リポジトリ／CI の保護（設定済み）

| 対象 | 設定 |
|---|---|
| `main` への force push / ブランチ削除 | **禁止（バイパス不可）** — ルールセット「main: 履歴保護」 |
| `main` への直接 push | PR 必須（承認1件・stale レビュー破棄・スレッド解決必須）。**リポジトリ管理者のみバイパス可** |
| フォークからの PR の Actions 実行 | **全外部コントリビューターに承認必須**（`all_external_contributors`） |
| Actions の `GITHUB_TOKEN` 既定権限 | `read`（書き込みが要るジョブは `permissions:` で明示的に付与する） |
| Actions の参照方法 | **コミット SHA でのピン留めを必須化**（タグ・ブランチ参照は不可） |
| Secret scanning / push protection | 有効 |
| Dependabot alerts / security updates | 有効 |

## ワークフローを追加する際の規則

1. `pull_request_target` を**使わない**。フォークの内容を特権コンテキストで実行してしまう。
   ビルド・テストは `pull_request` で行う。
2. PR で動くジョブに**シークレットを渡さない**。デプロイ用の資格情報を要するジョブは
   `push`（`main`）か手動トリガに限定する。
3. `permissions:` を各ジョブで最小に宣言する。
4. サードパーティ Action は**コミット SHA で固定**する（設定で強制済み）。

## 未確認の項目

- **Cloudflare Workers Builds のフォーク PR ビルド設定** — 実際のデプロイはこの経路で動いており、
  GitHub Actions の承認制はここには適用されない。フォークの PR をビルドする設定になっている場合、
  PR 内の `package.json`（postinstall）やビルド設定から任意コードがビルド環境で実行され、
  デプロイ資格情報に到達しうる。Cloudflare ダッシュボード → Workers → pdf-compressor →
  Settings → Builds で、ビルド対象ブランチと PR ビルドの扱いを確認すること。
