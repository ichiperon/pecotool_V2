# PecoTool v2

PDF 内テキストの OCR 抽出・編集・上書き保存を行う Windows デスクトップアプリケーション (v1.6.2)。

## 概要

既存 PDF の各ページに対して OCR を実行し、抽出したテキストをバウンディングボックス単位で編集・並び替え・グループ化し、元 PDF に上書き保存 (または別名保存) できるツールです。日本語縦書き/横書き混在ドキュメントの整形を主な用途として想定しています。

## 主な機能

- PDF OCR 抽出 (Windows OCR / PaddleOCR 相当のバックエンド対応)
- バウンディングボックス描画・編集・複数選択・グループ化
- 日本語縦書き/横書きの自動判別とソート
- テキストプレビュー / OCR カード UI による直接編集
- Undo / Redo (最大 100 段階)
- PDF 上書き保存 (圧縮対応) および別名保存
- 自動バックアップと復元
- サムネイルパネルによるページ横断操作

## 技術スタック

- Tauri v2 (Rust バックエンド) + React 19 + TypeScript + Vite
- `pdfjs-dist` — PDF レンダリング
- `@cantoo/pdf-lib` + `@pdf-lib/fontkit` — PDF 生成・フォント埋め込み
- `zustand` — 状態管理
- `@dnd-kit/*` — ドラッグ & ドロップ
- `react-virtuoso` — 仮想スクロール
- `framer-motion` — アニメーション

## セットアップ

### 必要環境

- Node.js 20 以上
- Rust (stable) + Tauri v2 のビルド要件 (Windows の場合は MSVC ツールチェイン)
- Windows 10/11

### インストール

```bash
npm install
```

### 開発起動

```bash
npm run tauri dev
```

Web のみ起動する場合:

```bash
npm run dev
```

### 本番ビルド

```bash
npm run tauri build
```

## テスト

- ユニット / 結合テスト (Vitest):

  ```bash
  npm run test
  ```

  ウォッチモード:

  ```bash
  npm run test:watch
  ```

- E2E テスト (Playwright):

  ```bash
  npm run test:e2e
  ```

## ディレクトリ構成 (抜粋)

- `src/` — React フロントエンド
  - `components/` — UI コンポーネント
  - `store/` — zustand ストア
  - `utils/` — PDF / OCR ロジック
  - `hooks/` — カスタムフック
  - `__tests__/` — ユニット / 結合テスト
- `src-tauri/` — Tauri (Rust) サイド
- `docs/` — 要件定義・テスト仕様書
- `tests/` — E2E テスト

## ドキュメント

- 要件定義: [docs/requirements.md](docs/requirements.md)
- テスト要件: [docs/TEST_REQUIREMENTS.md](docs/TEST_REQUIREMENTS.md)

## ライセンス

Private (社内利用)
