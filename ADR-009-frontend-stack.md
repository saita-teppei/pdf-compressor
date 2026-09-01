# ADR-009: フロントエンド技術スタック

- Status: Accepted（フレームワーク確定。i18n/PWAの具体ライブラリは推奨＋確定可）
- Date: 2026-09-01
- Related: ADR-001, ADR-004, ADR-007, ADR-008, COMPLIANCE.md

## Context

ADR-008でエンジン契約とWorkerプールを確定したが、UIフレームワーク・状態管理・ビルド・i18n・a11y・テスト・PWA・Cloudflare配信アダプタが未決だった。本サービスは**完全クライアント側**で、重い処理はWASM+Worker側に閉じる（ADR-001/008）。したがってアプリシェルは軽量なほど有利で、16MB WASM（ADR-004）に対しアプリのバンドルを小さく保つことが望ましい。全依存はAGPL（ADR-003）と結合可能でなければならない。

## Decision

### 1. UIフレームワーク: Svelte / SvelteKit

- コンパイル時にランタイムがほぼ消え**バンドルが小さい**。WASM主体の本件と相性が良い。
- コンパイル時 a11y 警告、スコープCSS、`$state`（Svelte 5 runes）による状態管理が**追加依存なし**で揃う。
- ライセンス **MIT**（AGPL結合可）。

### 2. ビルド／配信アダプタ: Vite + `@sveltejs/adapter-static`

- SvelteKitのビルドは Vite（ADR-008の推奨と一致）。
- サーバールートを持たない完全クライアント構成のため **`adapter-static`（プリレンダリング／SPAフォールバック）** を採用。Cloudflare Pages に純静的アセットとして配信する（ADR-001「Workerは静的配信のみ」と整合）。
- `adapter-cloudflare` はSSR/Functions用のWorkerを増やすため**不採用**（本件はサーバー処理を持たない）。
- 配信ヘッダ（CSP等・ADR-004）は `_headers` で付与。COOP/COEPは不要（調査確定）。
- **更新（2026-09-02）**: 実際の配信先は Cloudflare **Pages ではなく Workers の Static Assets**（`wrangler.toml` の `[assets]`）。`adapter-static` の出力をそのまま配信する点と `_headers` が効く点は同じで、本決定（`adapter-static` 採用・`adapter-cloudflare` 不採用）は変わらない。

### 3. 状態管理: Svelte 5 runes（`$state` / `$derived` / stores）

- ジョブキュー・探索結果・進捗などは Svelte 標準のリアクティビティで管理。**外部状態管理ライブラリは追加しない**（バンドル最小化）。

### 4. Worker RPC: Comlink

- メイン↔Worker の Promise ベースRPC。入力は Transferable(`ArrayBuffer`) で受け渡し（`SharedArrayBuffer` 不使用・ADR-004/008）。
- ライセンス **Apache-2.0**（AGPL結合可）。

### 5. i18n（日本語／英語）: Paraglide (inlang) を推奨

- コンパイル時にメッセージをツリーシェイクでき**バンドル増を抑えられる**。ja/enの2ロケール要件（ADR-007）に十分。
- 代替: `svelte-i18n`（実行時ロード・実績豊富）。いずれも MIT。**どちらでも可、既定はParaglide**。

### 6. アクセシビリティ（a11y）

- Svelteのコンパイル時 a11y 警告を活かし、セマンティックHTML＋ARIAを徹底（ADR-007）。
- 検証に **axe**（`@axe-core/playwright`）を用い、E2Eでa11yチェックを自動化。

### 7. テスト基盤: Vitest + Playwright

- **Vitest**（単体・ロジック、正規化層/プールサイジング等）— Viteネイティブ。
- **Playwright**（E2E・実ブラウザでWASM/Worker/ファイル入出力を駆動）。ADR-005のベンチマークハーネス（実ブラウザ計測）とも基盤を共有できる。
- ライセンス: Vitest=MIT, Playwright=Apache-2.0（AGPL結合可）。

### 8. PWA: `vite-plugin-pwa`（Workbox）

- インストール可能なPWAを構成（ADR-004/007）。
- **注意**: 16MB WASMを既定でprecacheしない。アプリシェルはprecache、**WASMはランタイムキャッシュ（またはIndexedDB・ADR-004で実証）** とし、コンテンツハッシュで更新。オフライン可否はADR-004の方式選定に従う。
- ライセンス MIT。

### 9. スタイリング

- Svelteスコープドスタイル＋CSSカスタムプロパティでテーマ（ライト/ダーク）・レスポンシブ（モバイル/PC・ADR-007）。**重量級UIキットは採用しない**（バンドル最小化）。

## ライセンス点検（COMPLIANCE.md §4）

| 依存 | ライセンス | AGPL結合 |
|---|---|---|
| Svelte / SvelteKit / adapter-static | MIT | 可 |
| Vite / Vitest | MIT | 可 |
| Comlink | Apache-2.0 | 可 |
| Paraglide（または svelte-i18n） | MIT | 可 |
| Playwright / @axe-core/playwright | Apache-2.0 / MPL-2.0 | 可（開発依存） |
| vite-plugin-pwa (Workbox) | MIT | 可 |

いずれもAGPLv3と結合可能。確定版は `THIRD-PARTY-NOTICES.md` に反映する。

## Consequences

### Positive
- アプリシェルが軽量で、16MB WASMに対する初期ロードNFR（ADR-005）に余裕。
- 追加の状態管理ライブラリ不要で依存が最小。
- 完全静的配信でCloudflare Pagesと素直に整合（サーバー処理ゼロ）。
- E2E基盤をベンチマーク（ADR-005）と共有できる。

### Negative
- Reactに比べ既製コンポーネント資産は少ない（比較UI等は自作寄り）。
- Svelte 5 runes・Paraglide等は比較的新しく、チームの習熟が必要な場合がある。

## Revisit Conditions
- 既製コンポーネント資産が強く必要になった場合（React/Vueの再検討）。
- i18n要件が2ロケールを大きく超える場合（i18n方式の再検討）。
- SSR/サーバー機能が必要になった場合（adapter変更・ADR-001再検討）。
