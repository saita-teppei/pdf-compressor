# ADR-001: PDF圧縮処理をクライアント側で実行する

- Status: Accepted
- Date: 2026-09-01

## Context

PDF圧縮Webアプリでは、ユーザーが圧縮条件を選択し、実際に圧縮した結果のファイルサイズを確認したうえでダウンロードできることを要求する。また、複数条件を自動的に試す探索モードを将来的に追加する可能性がある。

PDFは内容によって圧縮結果が大きく変化するため、サイズを正確に表示するには対象条件で実際にPDFを生成する必要がある。ユーザーPDFをサーバーへ送信する方式は、プライバシー、転送時間、サーバー側のCPU・メモリ・ストレージ負荷が発生する。

## Decision

PDF圧縮処理は原則としてブラウザ上で実行する。Cloudflare Workerは静的アセット配信等に限定し、PDF本体をサーバーへ送信しない。

重いPDF処理はWeb Worker内で実行し、UIスレッドをブロックしない構成とする。PDF圧縮エンジンはWebAssemblyを第一候補とし、Ghostscript WASMを有力候補として評価する。

通常モードではユーザーが設定を変更して「圧縮」を実行し、生成されたPDFの実サイズ、元サイズ、削減率を表示する。ダウンロードは生成済みBlob等からクライアント側で行う。

将来の探索モードでは、複数のDPI・画質・色設定等をジョブとして順次または並列に実行し、各条件の実測サイズを比較する。探索処理も原則クライアント側とし、必要になった場合のみサーバー側ジョブ実行を別ADRで検討する。

## Alternatives Considered

### 1. Cloudflare WorkerでPDF圧縮

WASMをWorkerにロードして圧縮する方式。Cloudflare WorkersはWASMモジュールを実行できるため技術的には可能だが、PDFをアップロードする必要があり、CPU・メモリ・実行時間等の制約を受ける。探索モードで多数の圧縮を行う場合は特に不利。

### 2. 外部サーバー／コンテナでGhostscript等を実行

最も実績のある構成だが、PDFアップロード、サーバーコスト、プライバシー、ジョブ管理が必要になる。本ツールの主要ユースケースには過剰と判断した。

### 3. ブラウザ上でPDF.js + Canvas + PDF生成ライブラリを組み合わせる

スキャンPDFをページ画像として再構成する用途では実現可能。ただし、一般的なPDF構造を維持したまま圧縮する能力は専用PDF処理エンジンに劣る可能性がある。圧縮エンジンとしてはGhostscript WASM等を優先評価する。

### 4. pdfcpuをWASM化してブラウザ実行

ブラウザ上でpdfcpuをWASM実行する実例が存在する。ただし、既存のブラウザ向けGhostscript WASM実装と比較して、必要な圧縮機能・安定性・バンドルサイズ等を検証する必要があるため、第一候補とはしない。

## Consequences

### Positive

- PDFをサーバーへ送信せずに処理できる
- 通常の圧縮処理と探索処理を同じ実行基盤で実装できる
- 実際に生成したPDFの正確なファイルサイズを表示できる
- Cloudflare側のバックエンドコスト・ジョブ管理を最小化できる
- オフラインに近い利用形態へ発展可能

### Negative

- ブラウザのCPU・メモリ性能に処理時間が依存する
- WASMモジュールのサイズが大きくなる可能性がある
- 大容量PDFでは入力PDF・出力PDF・処理用メモリが同時に必要となる
- iOS/Android等のモバイルブラウザでは大規模な探索処理が重くなる可能性がある
- Ghostscript等のライセンス条件を実装・配布前に確認する必要がある

## Implementation Direction

初期実装では以下を想定する。

1. Cloudflare Pages/Workersで静的Webアプリを配信
2. PDF Fileをブラウザで取得
3. Web WorkerへPDFと圧縮パラメータをTransferableとして渡す
4. WASM圧縮エンジンでPDFを生成
5. 出力Blobのsizeを計測
6. UIへ結果を返す
7. ユーザーが選択した結果だけBlobをダウンロード

探索モードでは、全組み合わせを無制限に実行せず、候補数・PDFサイズ・端末性能に応じて上限を設ける。結果はサイズだけでなく処理時間も記録する。

## Evidence

GhostscriptをWebAssemblyへコンパイルし、ブラウザ内でPDFを圧縮する実例が存在する。また、Web Worker内でGhostscript WASMを実行する実装例も存在する。Cloudflare Workers自身もWASMモジュールをJavaScript/TypeScriptからロードして実行できる。

- https://shubhamjha.com/blog/webassembly-pdf-compression-ghostscript-browser
- https://github.com/laurentmmeyer/ghostscript-pdf-compress.wasm
- https://developers.cloudflare.com/workers/runtime-apis/webassembly/javascript/
- https://github.com/LaserKaspar/go-wasm-pdfcpu

## Revisit Conditions

以下の場合は本ADRを再検討する。

- モバイル端末で許容できない処理時間・メモリ使用量が発生する
- 数十〜数百条件の探索を常用する必要が生じる
- 数百MB級のPDFを安定して処理する必要が生じる
- ブラウザ向けWASM PDFエンジンのライセンスまたは機能上の問題が判明する
- サーバー側での共有・保存・バッチ処理が要求される
