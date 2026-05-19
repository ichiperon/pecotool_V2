# フォント拡張およびスキップ文字通知対応 報告書

## 1. 対象

- 対象バージョン: Ver 1.6.4
- 対象機能: PDF保存時のOCRテキスト層再生成処理
- 対象課題:
  - OCRテキスト層へ埋め込む文字の対応範囲を広げる
  - それでも埋め込めない文字があった場合に、利用者または開発者が把握できるようにする

## 2. 追加対応の概要

今回、PDF保存時に使用するフォント構成を見直し、従来よりも日本語・希少漢字・記号の対応範囲を広げた。

あわせて、PDFテキスト層へ埋め込めない文字が発生した場合に、保存処理を中断せず、該当文字を除外したうえでコンソールおよび画面通知に内容を出す処理を追加した。

## 3. フォント構成の変更

### 3.1 変更前

- 主フォント: IPAexGothic
- fallback:
  - NotoSans-Regular
  - NotoSansSymbols-Regular
  - NotoSansSymbols2-Regular

### 3.2 変更後

- 主フォント:
  - WindowsのMeiryoを優先
  - Meiryoを取得できない場合はNotoSansCJKjp-Regular
- fallback:
  - IPAmjMincho
  - NotoSansCJKjp-Regular
  - NotoSans-Regular
  - NotoSansSymbols-Regular
  - NotoSansSymbols2-Regular

### 3.3 目的

- Meiryo:
  - Windows標準環境での主フォントとして使用し、別OCRツールとの文字幅・見た目の基準を近づける。
- NotoSansCJKjp-Regular:
  - 通常の日本語本文、英数字、かな、カナ、一般的な漢字を広く担当する。
  - Meiryoを取得できない環境では主フォントとして使用する。
- IPAmjMincho:
  - 行政系・戸籍系・人名系などで出やすい希少漢字の補完を担当する。
- NotoSans-Regular:
  - ラテン文字などの補完を担当する。
- NotoSansSymbols-Regular / NotoSansSymbols2-Regular:
  - 記号類、丸数字、特殊記号などの補完を担当する。

## 4. スキップ文字通知の追加

### 4.1 追加した動作

PDF保存時に、以下の文字を検出した場合はOCRテキスト層へ埋め込まず、除外する。

- 制御文字
  - 例: `U+0000`
  - 理由: PDFのコピー用テキスト層に混入すると、Ctrl+Aコピーや貼り付け時の欠落・途切れの原因になり得るため。
- 採用フォント群で対応できない文字
  - 例: 対応フォントがない外字・未収録文字
  - 理由: 無理に埋め込むと、Acrobat側で文字化け、NULL化、コピー欠落の原因になり得るため。

### 4.2 コンソール出力例

```json
[
  {
    "char": "\u0000",
    "codePoint": "U+0000",
    "count": 60,
    "pages": [1, 3, 9, 10, 11, 13, 14, 15, 17, 19],
    "reason": "control-character"
  }
]
```

この例は、特定の漢字が弾かれたのではなく、不可視の制御文字 `U+0000` が合計60個除外されたことを示す。

### 4.3 漢字がフォント未対応で弾かれた場合

漢字や記号がフォント未対応で弾かれた場合は、以下のように出力される。

```json
[
  {
    "char": "暟",
    "codePoint": "U+669F",
    "count": 1,
    "pages": [3],
    "reason": "unsupported-font"
  }
]
```

`reason` が `unsupported-font` の場合、その文字は現在採用しているフォント群ではPDFテキスト層へ安全に埋め込めなかったことを示す。

## 5. 画面通知

保存完了時にスキップ文字が存在する場合、通常の保存完了トーストに加えて、以下のような文言を表示する。

```text
保存しました。(xx MB) PDFテキスト層に埋め込めない文字を除外しました: U+0000 ほか
```

名前を付けて保存の場合も同様に、保存完了メッセージへスキップ文字情報を付加する。

## 6. 保存処理への影響

- スキップ文字があっても保存処理は継続する。
- スキップ対象はPDFの見た目の画像には影響しない。
- 影響するのは、Acrobat等で範囲選択・Ctrl+A・コピーした際のテキスト層のみ。
- 制御文字は見た目に存在しない文字であるため、除外しても表示内容には影響しない。
- フォント未対応文字は、PDFテキスト層から除外されるため、コピー結果からは欠落する可能性がある。ただし、Acrobat側でエラーや不正なNULL文字として扱われるより安全な動作とした。

## 7. 修正ファイル

- `src/hooks/useFontLoader.ts`
  - WindowsのMeiryoを優先し、失敗時は同梱NotoSansCJKjp-Regularへfallbackする構成へ変更。
- `src/utils/pdfSkippedTextChars.ts`
  - スキップ文字の集計・整形処理を追加。
- `src/utils/pdfWorkerTypes.ts`
  - Workerからスキップ文字情報を返す型を追加。
- `src/utils/pdfSaver.ts`
  - main thread保存経路でスキップ文字を収集。
  - 未対応文字を検出して記録。
- `src/utils/pdf.worker.ts`
  - worker保存経路でスキップ文字を収集。
  - 保存完了時にスキップ文字情報をmain threadへ返却。
- `src/hooks/useFileOperations.ts`
  - 保存完了時にコンソール警告および画面通知を出す処理を追加。
- `src/__tests__/integration/helpers/realPdfFixtures.ts`
  - テスト用フォント構成を同梱補完フォント構成へ変更。
- `src/__tests__/integration/tjErrorRegression.test.ts`
  - 実PDFでスキップ文字通知が発生することを検証。

## 8. 検証結果

以下の検証を実施し、すべて成功した。

- `npx tsc --noEmit`
- `npx vitest run src/__tests__/integration/tjErrorRegression.test.ts --pool=forks --maxWorkers=1`
  - 2件成功
- `npx vitest run src/__tests__/unit/useFileOperations.test.ts src/__tests__/unit/pdfSaver.stripTextBlocks.repro.test.ts src/__tests__/unit/pdfSaver.acrobat7compat.test.ts --pool=forks --maxWorkers=1`
  - 17件成功
  - 1件skip
- `npx vitest run src/__tests__/integration/realPdfAcrobatCompatScenarios.test.ts --pool=forks --maxWorkers=1`
  - 4件成功
- `npm run build`
  - 成功
- `npm run tauri build`
  - 成功

## 9. 配布物

- 配置先: `dist-bin/pecotool-v2_1.6.4_x64-setup.exe`
- サイズ: `53,018,312 bytes`
- SHA256: `898FCA71B1814A72474F55A67E552025EF0F79337E217C7504FB6DA8F8D75CDD`

## 10. 残る注意点

今回のフォント構成により対応範囲は広がったが、Unicode上の全ての文字を完全に網羅するものではない。

そのため、今後も採用フォントに存在しない外字・異体字・特殊記号が入力された場合は、`unsupported-font` として通知される可能性がある。

この場合でも、保存処理自体は失敗させず、Acrobat側で不正な文字やNULL文字として扱われることを避ける方針としている。
