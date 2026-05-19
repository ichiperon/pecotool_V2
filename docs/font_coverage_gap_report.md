# 採用フォント網羅性 洗い出し報告書

## 1. 目的

本報告書は、Ver 1.6.4で採用したOCRテキスト層用フォント群について、対応できる文字範囲と対応できない可能性が高い文字・記号を洗い出すことを目的とする。

対象はPDFの見た目ではなく、Acrobat等で範囲選択・検索・コピーに使用される透明OCRテキスト層である。

## 2. 対象フォント

| 用途 | フォント | 文字数 | SHA256 |
|---|---:|---:|---|
| Windows主フォント | C:\Windows\Fonts\meiryo.ttc から抽出した Meiryo | 17,189 | PC環境依存 |
| Meiryo未取得時の主フォント / CJK補完 | NotoSansCJKjp-Regular.otf | 44,810 | 68A3FC98800B2A27B371F2FB79991DAF3633BD89309D4FFAA6946FD587F375B5 |
| 希少漢字補完 | IPAmjMincho.ttf | 54,581 | A3E84F495F3C388DB7A1473BF1985C1C076D0C814100F10A027CA6853EB1E8CB |
| ラテン文字補完 | NotoSans-Regular.ttf | 2,841 | B85C38ECEA8A7CFB39C24E395A4007474FA5A4FC864F6EE33309EB4948D232D5 |
| 記号補完 | NotoSansSymbols-Regular.ttf | 840 | 8F02F31959BBDF6061547A188248E13F84DC5FDD940326EC494675F453F072BB |
| 記号補完 | NotoSansSymbols2-Regular.ttf | 2,655 | 630846D528DBE4C4981370A4D0A9475A1FD1491A129BB411F8E157CDB5DE13C6 |

Meiryoを含む採用フォント群の対応コードポイント数は、重複除外後で `78,051` 文字である。

## 3. 調査方法

`@pdf-lib/fontkit` を使用し、各フォントの `characterSet` から実際に収録されているUnicodeコードポイントを抽出した。

その後、採用フォント群の和集合を作成し、実務OCRで影響が出やすいUnicodeブロック単位で対応率を算出した。

注意点として、フォントにコードポイントが存在することは「テキスト層へ埋め込める」ことの必要条件であり、異体字シーケンス、複合絵文字、ゼロ幅接合子を含む絵文字シーケンス、結合文字列の表示・コピー結果まで完全保証するものではない。

## 4. 全件一覧

本文には集計結果を記載し、未対応候補の全件は別添CSVに記載した。

- 全未対応候補一覧: `docs/font_coverage_missing_all.csv`
- ブロック別集計一覧: `docs/font_coverage_summary.csv`
- 全未対応候補件数: `31,947`

`font_coverage_missing_all.csv` は以下の列を持つ。

| 列 | 内容 |
|---|---|
| `range` | Unicodeブロック名 |
| `codePoint` | Unicodeコードポイント |
| `character` | 該当文字 |
| `decimalCodePoint` | 10進数コードポイント |

## 5. 主要ブロック別の対応状況

| 分類 | 総数 | 対応 | 未対応 | 対応率 | 未対応例 |
|---|---:|---:|---:|---:|---|
| Basic Latin | 95 | 95 | 0 | 100.0% | なし |
| Latin-1 Supplement | 96 | 96 | 0 | 100.0% | なし |
| Hiragana | 96 | 93 | 3 | 96.9% | `぀ U+3040`, `゗ U+3097`, `゘ U+3098` |
| Katakana | 96 | 96 | 0 | 100.0% | なし |
| Katakana Phonetic Extensions | 16 | 16 | 0 | 100.0% | なし |
| CJK Symbols and Punctuation | 64 | 64 | 0 | 100.0% | なし |
| Enclosed Alphanumerics | 160 | 160 | 0 | 100.0% | なし |
| Enclosed CJK Letters and Months | 256 | 255 | 1 | 99.6% | `㈟ U+321F` |
| Box Drawing | 128 | 128 | 0 | 100.0% | なし |
| Block Elements | 32 | 32 | 0 | 100.0% | なし |
| Geometric Shapes | 96 | 96 | 0 | 100.0% | なし |
| Miscellaneous Symbols | 256 | 256 | 0 | 100.0% | なし |
| Dingbats | 192 | 180 | 12 | 93.8% | `✅ U+2705`, `✨ U+2728`, `❌ U+274C` |
| Arrows | 112 | 34 | 78 | 30.4% | `↚ U+219A`, `↛ U+219B`, `↜ U+219C` |
| Mathematical Operators | 256 | 81 | 175 | 31.6% | `∁ U+2201`, `∄ U+2204`, `∌ U+220C` |
| Miscellaneous Technical | 256 | 141 | 115 | 55.1% | `⌐ U+2310`, `⌙ U+2319`, `⌠ U+2320` |
| CJK Unified Ideographs | 20,992 | 20,976 | 16 | 99.9% | 全16件を `font_coverage_missing_all.csv` に記載 |
| CJK Extension A | 6,592 | 6,582 | 10 | 99.8% | 全10件を `font_coverage_missing_all.csv` に記載 |
| CJK Compatibility Ideographs | 512 | 366 | 146 | 71.5% | 全146件を `font_coverage_missing_all.csv` に記載 |
| CJK Extension B | 42,720 | 26,967 | 15,753 | 63.1% | 全15,753件を `font_coverage_missing_all.csv` に記載 |
| CJK Extension C | 4,160 | 434 | 3,726 | 10.4% | 全3,726件を `font_coverage_missing_all.csv` に記載 |
| CJK Extension D | 224 | 131 | 93 | 58.5% | 全93件を `font_coverage_missing_all.csv` に記載 |
| CJK Extension E | 5,776 | 611 | 5,165 | 10.6% | 全5,165件を `font_coverage_missing_all.csv` に記載 |
| CJK Extension F | 7,488 | 1,646 | 5,842 | 22.0% | 全5,842件を `font_coverage_missing_all.csv` に記載 |
| Misc Symbols and Pictographs | 768 | 296 | 472 | 38.5% | `🌀 U+1F300`, `🌁 U+1F301` |
| Emoticons | 80 | 1 | 79 | 1.3% | `😀 U+1F600`, `😂 U+1F602` |
| Supplemental Symbols and Pictographs | 256 | 2 | 254 | 0.8% | 全254件を `font_coverage_missing_all.csv` に記載 |
| Variation Selectors | 16 | 1 | 15 | 6.3% | `U+FE01` 以降の多く |
| Variation Selectors Supplement | 240 | 0 | 240 | 0.0% | `U+E0100` 以降 |

## 6. 実務上のリスク分類

### 5.1 低リスク

通常の日本語OCRで出やすい以下は概ね対応済みである。

- 英数字
- ひらがな
- カタカナ
- 一般的な漢字
- 日本語句読点
- 丸数字
- ローマ数字
- 株式会社記号
- 単位記号
- 罫線
- 黒丸
- 白丸
- 三角
- 星
- 四角

確認済み文字:

| 文字 | コードポイント | 状態 |
|---|---|---|
| `①` | U+2460 | 対応 |
| `㈱` | U+3231 | 対応 |
| `㍿` | U+337F | 対応 |
| `Ⅰ` | U+2160 | 対応 |
| `㎜` | U+339C | 対応 |
| `㎡` | U+33A1 | 対応 |
| `℡` | U+2121 | 対応 |
| `〒` | U+3012 | 対応 |
| `→` | U+2192 | 対応 |
| `✓` | U+2713 | 対応 |
| `☑` | U+2611 | 対応 |
| `⚠` | U+26A0 | 対応 |

### 5.2 中リスク

出現頻度は低いが、仕様書・図面・理系文書・技術資料では出る可能性がある。

- 矢印の特殊バリエーション: 未対応78件
- 数学演算子の特殊記号: 未対応175件
- 技術記号: 未対応115件
- Dingbats: 未対応12件

これらがOCRテキストとして発生した場合、`unsupported-font` として通知される可能性がある。

### 5.3 高リスク

以下は採用フォント群では広く対応できない。

- 絵文字: Emoticons範囲で未対応79件
- カラー絵文字由来の記号: Misc Symbols and Pictographs範囲で未対応472件、Supplemental Symbols and Pictographs範囲で未対応254件
- CJK Extension C以降の超希少漢字
- 異体字セレクタ
  - Variation Selectorsで未対応15件
  - Variation Selectors Supplementで未対応240件

これらは文書の見た目画像には残るが、透明OCRテキスト層では除外される可能性が高い。

## 7. 人名・外字系の確認

今回問題視された文字および人名・地名で問題になりやすい文字を確認した。

| 文字 | コードポイント | 状態 |
|---|---|---|
| `髙` | U+9AD9 | 対応 |
| `﨑` | U+FA11 | 対応 |
| `𠮷` | U+20BB7 | 対応 |
| `㐂` | U+3402 | 対応 |
| `暟` | U+669F | 対応 |
| `𩸽` | U+29E3D | 対応 |
| `𡈽` | U+2123D | 対応 |
| `𣘺` | U+2363A | 対応 |
| `𫝆` | U+2B746 | 対応 |

この結果から、今回問題になった `暟` は現行フォント構成では対応済みである。

## 8. スキップ通知との関係

保存時に採用フォント群で対応できない文字が出た場合、コンソールには以下のように出力される。

```json
{
  "char": "😀",
  "codePoint": "U+1F600",
  "count": 1,
  "pages": [3],
  "reason": "unsupported-font"
}
```

制御文字が出た場合は、フォント未対応ではなくPDFテキスト層に入れるべきではない文字として除外される。

```json
{
  "char": "\u0000",
  "codePoint": "U+0000",
  "count": 60,
  "pages": [1, 3, 9],
  "reason": "control-character"
}
```

`control-character` は文字形の問題ではなく、コピー・貼り付け時の欠落や途切れを防ぐための安全処理である。

## 9. 判断

現行フォント構成は、通常の日本語業務文書・OCR文書・人名に出やすい希少漢字のうち、上記「人名・外字系の確認」に記載した文字については対応済みである。

一方、以下を完全に網羅する構成ではない。

- 絵文字
- カラー絵文字互換記号
- 高度な数学・技術記号
- CJK Extension C以降の超希少漢字
- 異体字セレクタを含む厳密なIVS表現

ただし、これらはOCR業務PDFでは頻度が低く、発生した場合も現在の実装でコンソールおよび画面通知により検知できる。

## 10. 推奨運用

- 現時点ではフォントをさらに増やすより、Meiryo優先 + 同梱補完フォント構成を維持する。
- `unsupported-font` が実務データで頻出した場合に、その文字群に対して追加フォントを検討する。
- `control-character` はフォント追加では解消しないため、現行通り除外する。
- 異体字セレクタは、必要になった段階で「ベース文字のみ残す」か「IVS対応フォント・処理を追加する」かを別途判断する。

## 11. 結論

本ツールの現行フォント構成で、通常の日本語OCR用途に必要な文字は概ね網羅できている。

未対応候補として優先的に把握すべきものは、絵文字、特殊数学記号、特殊技術記号、CJK拡張C以降、異体字セレクタである。

これらが実データで発生した場合は `unsupported-font` としてログおよび画面通知に出るため、現時点では「起きた場合に検知して個別判断する」運用が妥当である。
