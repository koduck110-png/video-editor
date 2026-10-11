# かんたん動画編集

Chrome で開くだけで使える動画編集ソフトです。インストールもサーバーも不要です。
読み込んだ動画・画像・音楽は**パソコン（ブラウザ）の中だけで処理され、どこにも送られません。**

公開ページ: https://koduck110-png.github.io/video-editor/

## できること（段階1）

- 動画・画像・音楽の読み込み（ドラッグ＆ドロップ／「ファイルを読み込む」ボタン）
- タイムライン（映像・文字・音声トラック）
  - 素材を並べる、ドラッグで動かす、端をつまんで長さを変える
  - 再生位置（白い線）で分割、削除、拡大・縮小
- プレビュー（再生・一時停止・好きな位置へ移動）
- 文字入れ（文字・大きさ・色・縁取り・位置）
- 書き出し：1920×1080 / 30fps の MP4（音声付き）をダウンロード
- 元に戻す・やり直し（Ctrl+Z / Ctrl+Y）

## キーボード操作

| キー | 動作 |
| --- | --- |
| スペース | 再生・一時停止 |
| Ctrl+Z / Ctrl+Y | 元に戻す / やり直し |
| Ctrl+B | 分割 |
| Delete | 選んだクリップを削除 |
| ← / → | 1コマ移動（Shift で1秒） |
| Ctrl+マウスホイール | タイムラインの拡大・縮小 |

## 開発者向け

```bash
npm install
npm run dev        # 開発用サーバー
npm run build      # dist/ に組み立て
npm run test:e2e   # 組み立て後、実際のブラウザで 読み込み→分割→文字→書き出し を確認
```

- Vite + React + TypeScript
- 書き出しは WebCodecs + [Mediabunny](https://mediabunny.dev/)（H.264 / AAC。ブラウザが AAC を作れない場合は `@mediabunny/aac-encoder` を使用）
- `main` ブランチに push すると GitHub Actions が GitHub Pages へ公開します（`.github/workflows/deploy.yml`）
- `npm run test:e2e` で H.264 / AAC を確かめるには、Google Chrome（または Chrome for Testing）の場所を `CHROME_PATH` で指定してください。指定しない場合は Playwright の Chromium で VP9 / Opus の代わりの形式を確かめます。
