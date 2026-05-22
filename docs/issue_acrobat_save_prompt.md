# Issue: PecoTool生成PDFをAcrobatで開くと未変更でも「保存しますか？」が出る

作成日: 2026-05-22

対応状況: 原因特定済み。自動テストで検証可能な修正は実装済み。Acrobat 7.0でのA/B確認では保存確認ダイアログが残るため、マージ前に追加調査が必要。

## 背景

PecoToolで保存したPDFをAdobe Acrobatで開き、Acrobat上では何も編集せず閉じようとしても「保存しますか？」の確認が表示される。

## 結論

最有力原因は、PecoTool内部の復元用データ `PecoToolBBoxes` をPDFのInfo辞書へ巨大なカスタム文書プロパティとして保存していること。

現在の保存処理は `bboxMeta` 全体を `PDFHexString.fromText(JSON.stringify(...))` でInfo辞書の `/PecoToolBBoxes` に書き込む。

- 保存オーケストレーション + main-thread fallback経路: `src/utils/pdfSaver.ts`
- worker経路: `src/utils/pdf.worker.ts`
- 読み戻し経路: `src/utils/pdfMetadataLoader.ts`

この値はAcrobatから見ると「Document Properties > Custom」のカスタム文書プロパティになる。実測では、既存の保存済みPDFで `PecoToolBBoxes` が数MB規模になっていた。

## 調査結果

対象ファイル:

- `test/OCR_08_長期給付制度の概説_searchable.pdf`
- `test/OCR_08_長期給付制度の概説_searchable_edited.pdf`
- `test/OCR_08_長期給付制度の概説_searchable_e2_3c_large_meta.pdf`
- `test/OCR_08_長期給付制度の概説_searchable_acrobat_compat_repaired.pdf`

確認結果:

| ファイル | `/PecoToolBBoxes` | hex文字数 | デコード後概算 |
| --- | ---: | ---: | ---: |
| 元PDF `searchable.pdf` | なし | 0 | 0 |
| `searchable_edited.pdf` | あり | 15,049,360 | 約 7.5 MB |
| `searchable_e2_3c_large_meta.pdf` | あり | 14,837,620 | 約 7.4 MB |
| `searchable_acrobat_compat_repaired.pdf` | あり | 14,381,680 | 約 7.2 MB |

pdfjsの `getMetadata()` でも、保存後PDFの `PecoToolBBoxes` は `info.Custom.PecoToolBBoxes` として読まれることを確認した。

```text
元PDF:
customKeys=["OriginalFileName","ConversionTimestamp"]

保存後PDF:
customKeys=["OriginalFileName","ConversionTimestamp","PecoToolBBoxes"]
customPecoLen=3762339
```

一方で、既存のAcrobat互換監査テストは通過している。

```text
npx vitest run src/__tests__/unit/pdfSaver.acrobat7compat.test.ts --pool=forks --maxWorkers=1
Test Files  1 passed
Tests       4 passed | 1 skipped
```

そのため、今回の症状はPDF本文の `BT...ET` 崩れやxref stream/object stream問題より、Acrobatが開封時に巨大カスタム文書プロパティをメタデータとして正規化・同期し、文書をdirty扱いにしている可能性が高い。最終確証にはAcrobat実機でのA/B確認を行う。

補足:

- Acrobatで作成したカスタム文書プロパティはInfo辞書だけでなくXMP metadata streamにも現れることがある。
- 現在のPecoTool出力はInfo辞書だけへ独自の大容量データを入れており、Acrobatのメタデータ管理対象に内部データが露出している。
- `PecoToolBBoxes` はOCR編集状態の復元用であり、ユーザーがAcrobatの文書プロパティとして編集・閲覧する情報ではない。

## 該当コード

- `src/utils/pdfSaver.ts`
  - 既存 `/PecoToolBBoxes` 読み取り
  - 保存時に `infoDict.set(PDFName.of('PecoToolBBoxes'), PDFHexString.fromText(JSON.stringify(bboxMeta)))`
- `src/utils/pdf.worker.ts`
  - worker保存経路でも同一処理
- `src/utils/pdfMetadataLoader.ts`
  - `info.Custom.PecoToolBBoxes` / `info.PecoToolBBoxes` から読み戻し
- `src/utils/pdfReachabilityGc.ts`
  - 新形式の専用streamは `/Root` から到達可能にする必要がある

## 修正方針

### 方針A: 内部データをInfo辞書からPDF内の専用streamへ移す

推奨。

`PecoToolBBoxes` をInfo辞書のカスタムプロパティとして保存するのをやめ、Catalog配下のPecoTool専用辞書、またはMetadata対象外の専用indirect streamへ保存する。

例:

```text
/Catalog
  /PecoTool <<
    /BBoxes 123 0 R
    /Version 1
  >>

123 0 obj
<< /Type /PecoToolData /Subtype /BBoxes /Filter /FlateDecode /Length ... >>
stream
  JSONまたは圧縮JSON
endstream
endobj
```

期待効果:

- Acrobatの「文書プロパティ」から内部データを外せる
- 数MBのJSONをPDF stringではなくstreamとして保存できる
- Flate圧縮でファイルサイズを下げられる
- 既存の大容量Info文字列によるAcrobat dirty化を回避できる

### 方針B: 後方互換読み込みだけ残す

既存PDFを壊さないため、読み込み時は以下の順で探索する。

1. 新形式 `/Catalog/PecoTool/BBoxes` stream
2. 旧形式 `info.Custom.PecoToolBBoxes`
3. 旧形式 `info.PecoToolBBoxes`

保存時は新形式のみへ書き出す。旧形式が存在するPDFを保存した場合は、Info辞書から `/PecoToolBBoxes` を削除する。

### 方針C: Acrobat再現確認を受け入れ条件に入れる

自動テストだけではAcrobatのdirty flagを直接検出しにくい。修正PRでは以下を手動確認項目として必須にする。

1. 旧形式PDFをPecoToolで開く
2. 何か1箇所編集して保存
3. 保存後PDFをAcrobatで開く
4. 何も変更せず閉じる
5. 「保存しますか？」が出ないこと

## 実装タスク

- [x] `pdfSaver.ts` にPecoTool専用metadata stream書き込み処理を追加する
- [x] `pdf.worker.ts` に同一処理を反映する
- [x] `pdfMetadataLoader.ts` を新形式優先、旧形式fallbackに変更する
- [x] 保存時に旧 `/PecoToolBBoxes` Infoエントリを削除する
- [x] 旧形式PDFから新形式PDFへ移行される回帰テストを追加する
- [x] 新形式保存後に Info 辞書の `/PecoToolBBoxes` が存在しないことをテストする
- [x] 旧形式PDFをdirty pageありで保存した場合、旧Infoメタが削除され、新形式streamへ移行されることをテストする
- [x] 新形式streamが `/Root` から到達可能で、`sweepUnreachableObjects()` に削除されないことをテストする
- [ ] Acrobat手動確認結果をPRに記録する

## Acrobat実機確認メモ

2026-05-22 にローカルの Adobe Acrobat 7.0 Professional で確認した。

確認時は日本語パスを Acrobat 7.0 が開けなかったため、`tmp/acrobat_ab/` 配下のASCIIパスへコピーして確認した。

| PDF | 形式 | 結果 |
| --- | --- | --- |
| `original-no-pecotool.pdf` | 原本、PecoToolメタなし | 保存確認なしで閉じられる |
| `legacy-info-large.pdf` | 旧 `/Info/PecoToolBBoxes` | 「変更を保存しますか？」が出る |
| `private-stream-large.pdf` | 新 `/Catalog/PecoTool/BBoxes` | 「変更を保存しますか？」が出る |
| `private-stream-small.pdf` | 新 `/Catalog/PecoTool/BBoxes` | 「変更を保存しますか？」が出る |
| `private-stream-small-no-pecotool.pdf` | 新形式PDFから `/Catalog/PecoTool` を削除 | 「変更を保存しますか？」が出る |
| `synthetic-input.pdf` | PecoTool保存前のpdf-lib合成入力 | 保存確認なしで閉じられる |

この結果から、Acrobat 7.0 に限ると、巨大Info辞書だけでなく PecoTool の保存後PDFに含まれる別の差分でも dirty 扱いになっている可能性がある。

Acrobat 7.0は古い製品のため、ターゲットが現行 Acrobat の場合は現行版で同じA/B確認を行う。それでも新形式PDFで保存確認が出る場合、このissueは未解決として追加原因を調査する。

## 受け入れ条件

- PecoToolで保存したPDFにInfo辞書の `/PecoToolBBoxes` が残らない
- PecoTool自身は保存後PDFを従来どおり再読込できる
- 既存の旧形式PDFも読み込める
- 旧形式PDFを保存した場合、非dirty pageの既存bboxメタも新形式streamで保持される
- Acrobatで開いて閉じるだけでは保存確認が出ない
- `npx vitest run src/__tests__/unit/pdfSaver.acrobat7compat.test.ts --pool=forks --maxWorkers=1` が通る
- PDF保存系のacceptance testが通る

## 参考

- Adobe Acrobat Document Properties / Metadata overview: https://helpx.adobe.com/acrobat/using/pdf-properties-metadata.html
- Adobe Acrobat SDK Metadata overview: https://opensource.adobe.com/dc-acrobat-sdk-docs/library/overview/Overview_Metadata.html
- Acrobatで追加したカスタムメタデータがInfo辞書とXMP metadata streamの両方に現れる例: https://kb.itextpdf.com/itext/how-to-add-delete-retrieve-information-from-a-pdf-
