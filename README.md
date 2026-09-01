# PDF圧縮（ブラウザ内処理）

完全クライアント側で動作するPDF圧縮アプリ。**PDFはサーバーへ送信しません**（ADR-001）。
SvelteKit + `adapter-static`（ADR-009）で静的サイトとしてビルドし、Cloudflare Pages に配信する。

ソースコード: <https://github.com/saita-teppei/pdf-compressor>（AGPL-3.0）

設計上の決定は各 ADR（リポジトリ直下 `ADR-*.md`）と `docs/` を参照。実測知見は `docs/benchmark/RESULTS.md`。

## 機能（MVP）

- **完全クライアント処理**：WASM 圧縮エンジンを Web Worker で実行（ADR-001/008）
- **コンテンツ別ルーティング＋肥大化ガード**（ADR-010）：pdfcpu の inspect で種別判定し、
  スキャン/画像→Ghostscript、テキスト/2値→pdfcpu を自動選択。出力が入力を超える場合は元ファイルを維持
- **プリセット / マニュアル**：自動（既定・DPI適応）/ プリセット(max/balanced/quality) / 手動(DPI・画質・カラー)
- **複数ファイル・進捗・キャンセル・ZIP一括DL・比較一覧**（ADR-007）
- **機能保全の事前提示**（ADR-006）：署名/フォーム/タグ付きの警告、暗号化PDFの非対応明示
- **a11y**（axe 違反0）・**i18n**（日本語/英語, Paraglide）
- **PWA**：インストール可能。アプリシェルはオフライン動作（WASM は初回取得後 IndexedDB キャッシュ, ADR-004）

## 開発

```bash
npm install
npm run dev        # 開発サーバ
npm run check      # paraglide compile + svelte-check（型チェック）
npm run build      # 本番ビルド → build/
npm run preview    # build/ をローカル配信
```

主なディレクトリ:

```
src/routes/            +page.svelte（UI）/ +layout.svelte（SW登録・head）/ +layout.ts（prerender）
src/lib/engines/       CompressionEngine 実装（gs / pdfcpu / idb-cache）＋契約
src/lib/worker/        compress.worker.ts（Comlink公開）/ client.ts（メイン側）
src/lib/routing/       inspect.ts（種別判定・ルーティング・ガード, ADR-010）
messages/              i18n メッセージ（ja/en, Paraglide）
static/                _headers（配信ヘッダ）/ icon.svg
docs/benchmark/        Node 実測ハーネス（harness/）＋ 実ブラウザ計測 PoC（browser/）
```

## セキュリティヘッダ / CSP（ADR-004）

- **CSP は SvelteKit `kit.csp`（hash モード）で各HTMLの `<meta>` に出力**（静的配信のためヘッダを持てない）。
  inline ブートストラップ script はビルド毎にハッシュ化。`script-src 'self' 'wasm-unsafe-eval' <hash>`、
  `worker-src 'self' blob:`、`connect-src 'self'`（外部接続なし）等。
- `static/_headers`：`frame-ancestors 'none'` などヘッダ専用項目＋不変アセットの長期キャッシュ。
  meta の主CSPとは**重複させない**（ビルド毎ハッシュとの競合回避）。

## Cloudflare へのデプロイ（Workers Static Assets）

`adapter-static` の出力 `build/` を **Cloudflare Workers の静的アセット**として配信する（SSR無し, ADR-001/004）。
`wrangler.toml` の `[assets]` を使う。`build/_headers` も適用される。

```bash
npm run build
CLOUDFLARE_ACCOUNT_ID=<account-id> npx wrangler deploy
```

- 公開URL例: `https://pdf-compressor.prkn.workers.dev`
- **注意（25 MiB/ファイル上限）**: `pdfcpu.wasm`(≈30MB) は Workers/Pages の 25 MiB 上限を超えるため**アプリに同梱せず**、
  jsdelivr から**版固定＋SHA-256検証**で取得する（`src/lib/engines/pdfcpu-engine.ts`）。`gs.wasm`(16MB) は自己ホスト。
  取得するのは公開バイナリのみで、**PDF本体は送信しない**（ADR-001）。CSP は `connect-src` に jsdelivr のみ許可。

> ライセンス: アプリ全体 **AGPL-3.0**（Ghostscript WASM が AGPL のため, ADR-003）。依存一覧は `THIRD-PARTY-NOTICES.md`。
