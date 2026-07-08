import { describe, it, expect, beforeEach } from "vitest";
import { useReportStore, HISTORY_LIMIT } from "../../store/reportStore";
import type { ConfidenceMatrix } from "../../store/reportStore";
import { buildTemplateCsv } from "../../logic/templateCsv";
import type { CsvOptions } from "../../types/report";

const SAMPLE_RECT = { x: 0, y: 0, width: 100, height: 30 };

beforeEach(() => {
  useReportStore.setState({
    template: { fields: [] },
    cells: new Map(),
    confidences: new Map(),
    edited: new Map(),
    past: [],
    future: [],
    mode: "idle",
    selectedFieldId: null,
    pageOffsets: new Map(),
  });
});

/** 欄を追加して id 配列を返す（addField は undo 対象外なので履歴は汚れない） */
function makeFields(names: string[]): string[] {
  names.forEach((n) => useReportStore.getState().addField(SAMPLE_RECT, n));
  return useReportStore.getState().template.fields.map((f) => f.id);
}

/** ページ1に1段のセルを設定する（setCells 経由＝履歴クリアされた初期状態になる） */
function seedCells(pairs: [string, string][], page = 1) {
  useReportStore.getState().setCells(new Map([[page, [new Map(pairs)]]]));
}

function cellValue(page: number, row: number, fieldId: string): string | undefined {
  return useReportStore.getState().cells.get(page)?.[row]?.get(fieldId);
}

describe("undo/redo: セル編集", () => {
  it("setCellValue を undo すると編集前の値に戻る", () => {
    const [id] = makeFields(["金額"]);
    seedCells([[id, "100"]]);
    useReportStore.getState().setCellValue(1, id, "200");
    expect(cellValue(1, 0, id)).toBe("200");

    useReportStore.getState().undo();
    expect(cellValue(1, 0, id)).toBe("100");
  });

  it("undo 後に redo すると編集後の値が再現される", () => {
    const [id] = makeFields(["金額"]);
    seedCells([[id, "100"]]);
    useReportStore.getState().setCellValue(1, id, "200");
    useReportStore.getState().undo();
    useReportStore.getState().redo();
    expect(cellValue(1, 0, id)).toBe("200");
  });

  it("履歴が空のとき undo は no-op（エラーも状態変化もなし）", () => {
    const [id] = makeFields(["金額"]);
    seedCells([[id, "100"]]);
    const before = useReportStore.getState().cells;
    useReportStore.getState().undo();
    expect(useReportStore.getState().cells).toBe(before);
  });

  it("future が空のとき redo は no-op", () => {
    const [id] = makeFields(["金額"]);
    seedCells([[id, "100"]]);
    useReportStore.getState().setCellValue(1, id, "200");
    const before = useReportStore.getState().cells;
    useReportStore.getState().redo();
    expect(useReportStore.getState().cells).toBe(before);
  });

  it("同じ値の setCellValue（no-op）は履歴に積まれない", () => {
    const [id] = makeFields(["金額"]);
    seedCells([[id, "100"]]);
    useReportStore.getState().setCellValue(1, id, "100");
    expect(useReportStore.getState().past).toHaveLength(0);
  });

  it("undo 後に新しい操作をすると future（redo 履歴）がクリアされる", () => {
    const [id] = makeFields(["金額"]);
    seedCells([[id, "100"]]);
    useReportStore.getState().setCellValue(1, id, "200");
    useReportStore.getState().undo();
    expect(useReportStore.getState().future).toHaveLength(1);

    useReportStore.getState().setCellValue(1, id, "300");
    expect(useReportStore.getState().future).toHaveLength(0);
    useReportStore.getState().redo(); // no-op
    expect(cellValue(1, 0, id)).toBe("300");
  });

  it("複数操作を連続 undo で順に巻き戻せる", () => {
    const [id] = makeFields(["金額"]);
    seedCells([[id, "100"]]);
    useReportStore.getState().setCellValue(1, id, "200");
    useReportStore.getState().setCellValue(1, id, "300");
    useReportStore.getState().clearCellValue(1, id);
    expect(cellValue(1, 0, id)).toBe("");

    useReportStore.getState().undo();
    expect(cellValue(1, 0, id)).toBe("300");
    useReportStore.getState().undo();
    expect(cellValue(1, 0, id)).toBe("200");
    useReportStore.getState().undo();
    expect(cellValue(1, 0, id)).toBe("100");
    expect(useReportStore.getState().past).toHaveLength(0);
  });

  it("履歴は HISTORY_LIMIT 件で頭打ちになり最古から破棄される", () => {
    const [id] = makeFields(["金額"]);
    seedCells([[id, "v0"]]);
    const total = HISTORY_LIMIT + 5;
    for (let i = 1; i <= total; i++) {
      useReportStore.getState().setCellValue(1, id, `v${i}`);
    }
    expect(useReportStore.getState().past).toHaveLength(HISTORY_LIMIT);

    // 全部 undo すると「最古が破棄された地点」= v(total - HISTORY_LIMIT) で止まる
    for (let i = 0; i < HISTORY_LIMIT + 10; i++) {
      useReportStore.getState().undo();
    }
    expect(cellValue(1, 0, id)).toBe(`v${total - HISTORY_LIMIT}`);
  });
});

describe("undo/redo: 段操作と confidences の整合", () => {
  it("removeRowAt を undo すると段と confidences が削除前に完全復元される", () => {
    const [idA, idB] = makeFields(["明細", "金額"]);
    useReportStore.getState().setCells(
      new Map([
        [
          1,
          [
            new Map([
              [idA, "りんご"],
              [idB, "100"],
            ]),
            new Map([[idA, "みかん"]]),
          ],
        ],
      ])
    );
    const conf: ConfidenceMatrix = new Map([
      [1, [new Map([[idA, 0.9]]), new Map([[idA, 0.3]])]],
    ]);
    useReportStore.getState().setConfidences(conf);

    useReportStore.getState().removeRowAt(1, 1);
    expect(useReportStore.getState().cells.get(1)).toHaveLength(1);
    expect(useReportStore.getState().confidences.has(1)).toBe(false);

    useReportStore.getState().undo();
    expect(useReportStore.getState().cells.get(1)).toHaveLength(2);
    expect(cellValue(1, 1, idA)).toBe("みかん");
    expect(useReportStore.getState().confidences.get(1)?.[1]?.get(idA)).toBe(0.3);
  });

  it("moveCellValue(swap) を undo すると from/to の値と confidence が戻る", () => {
    const [idA, idB] = makeFields(["A", "B"]);
    seedCells([
      [idA, "あ"],
      [idB, "い"],
    ]);
    useReportStore
      .getState()
      .setConfidences(new Map([[1, [new Map([[idA, 0.8], [idB, 0.4]])]]]));

    useReportStore.getState().moveCellValue(1, idA, idB, "swap");
    expect(cellValue(1, 0, idA)).toBe("い");
    expect(cellValue(1, 0, idB)).toBe("あ");

    useReportStore.getState().undo();
    expect(cellValue(1, 0, idA)).toBe("あ");
    expect(cellValue(1, 0, idB)).toBe("い");
    expect(useReportStore.getState().confidences.get(1)?.[0]?.get(idA)).toBe(0.8);
    expect(useReportStore.getState().confidences.get(1)?.[0]?.get(idB)).toBe(0.4);
  });

  it("splitCellByNewlines を undo すると分割前の1段に戻る", () => {
    const [id] = makeFields(["明細"]);
    seedCells([[id, "りんご\nみかん\nばなな"]]);
    useReportStore.getState().splitCellByNewlines(1, 0, id);
    expect(useReportStore.getState().cells.get(1)).toHaveLength(3);

    useReportStore.getState().undo();
    expect(useReportStore.getState().cells.get(1)).toHaveLength(1);
    expect(cellValue(1, 0, id)).toBe("りんご\nみかん\nばなな");
  });
});

describe("undo/redo: ページオフセット", () => {
  it("setPageOffset を undo するとオフセットが戻る", () => {
    useReportStore.getState().setPageOffset(2, 5, -3);
    expect(useReportStore.getState().pageOffsets.get(2)).toEqual({ dx: 5, dy: -3 });

    useReportStore.getState().undo();
    expect(useReportStore.getState().pageOffsets.has(2)).toBe(false);
  });

  it("nudgePageOffset(0,0) は no-op で履歴に積まれない", () => {
    useReportStore.getState().nudgePageOffset(1, 0, 0);
    expect(useReportStore.getState().past).toHaveLength(0);
  });

  it("clearPageOffset はオフセットがあるときだけ履歴に積まれる", () => {
    useReportStore.getState().clearPageOffset(1); // 何もない → no-op
    expect(useReportStore.getState().past).toHaveLength(0);

    useReportStore.getState().setPageOffset(1, 2, 2);
    useReportStore.getState().clearPageOffset(1);
    expect(useReportStore.getState().past).toHaveLength(2);

    useReportStore.getState().undo();
    expect(useReportStore.getState().pageOffsets.get(1)).toEqual({ dx: 2, dy: 2 });
  });
});

describe("ロード境界での履歴クリア", () => {
  it("setCells（OCR 取り込み）で履歴が消える", () => {
    const [id] = makeFields(["金額"]);
    seedCells([[id, "100"]]);
    useReportStore.getState().setCellValue(1, id, "200");
    expect(useReportStore.getState().past).toHaveLength(1);

    seedCells([[id, "999"]]);
    expect(useReportStore.getState().past).toHaveLength(0);
    expect(useReportStore.getState().future).toHaveLength(0);
  });

  it("setCellsForPage（単一ページ再 OCR）で履歴が消える", () => {
    const [id] = makeFields(["金額"]);
    seedCells([[id, "100"]]);
    useReportStore.getState().setCellValue(1, id, "200");

    useReportStore.getState().setCellsForPage(1, new Map([[id, "555"]]));
    expect(useReportStore.getState().past).toHaveLength(0);
    // undo しても再 OCR 前の値には戻らない（境界を跨がない）
    useReportStore.getState().undo();
    expect(cellValue(1, 0, id)).toBe("555");
  });

  it("replaceTemplateFields（テンプレ読込）で履歴が消える", () => {
    const [id] = makeFields(["金額"]);
    seedCells([[id, "100"]]);
    useReportStore.getState().setCellValue(1, id, "200");

    useReportStore.getState().replaceTemplateFields([
      { id: "new-1", name: "新欄", color: "#7cb9e8", rect: SAMPLE_RECT },
    ]);
    expect(useReportStore.getState().past).toHaveLength(0);
    // undo しても旧テンプレ時代の cells は復活しない（孤児 fieldId 防止）
    useReportStore.getState().undo();
    expect(useReportStore.getState().cells.size).toBe(0);
  });

  it("resetExtractedData / clearTemplate で履歴が消える", () => {
    const [id] = makeFields(["金額"]);
    seedCells([[id, "100"]]);
    useReportStore.getState().setCellValue(1, id, "200");
    useReportStore.getState().resetExtractedData();
    expect(useReportStore.getState().past).toHaveLength(0);

    useReportStore.getState().setPageOffset(1, 1, 1);
    useReportStore.getState().clearTemplate();
    expect(useReportStore.getState().past).toHaveLength(0);
  });
});

describe("undo/redo: 往復・複数ページ・復元の深掘り", () => {
  it("undo→redo→undo の往復で値と履歴長が安定する（冪等性）", () => {
    const [id] = makeFields(["金額"]);
    seedCells([[id, "100"]]);
    useReportStore.getState().setCellValue(1, id, "200");

    for (let i = 0; i < 3; i++) {
      useReportStore.getState().undo();
      expect(cellValue(1, 0, id)).toBe("100");
      expect(useReportStore.getState().past).toHaveLength(0);
      expect(useReportStore.getState().future).toHaveLength(1);

      useReportStore.getState().redo();
      expect(cellValue(1, 0, id)).toBe("200");
      expect(useReportStore.getState().past).toHaveLength(1);
      expect(useReportStore.getState().future).toHaveLength(0);
    }
  });

  it("複数ページまたぎ: undo は直近操作のページだけ戻し、他ページの編集は保持する", () => {
    const [id] = makeFields(["金額"]);
    useReportStore.getState().setCells(
      new Map([
        [1, [new Map([[id, "p1"]])]],
        [2, [new Map([[id, "p2"]])]],
      ])
    );
    useReportStore.getState().setCellValue(1, id, "p1改");
    useReportStore.getState().setCellValue(2, id, "p2改");

    useReportStore.getState().undo();
    expect(cellValue(2, 0, id)).toBe("p2"); // 直近＝ページ2の編集が戻る
    expect(cellValue(1, 0, id)).toBe("p1改"); // ページ1の編集は保持

    useReportStore.getState().undo();
    expect(cellValue(1, 0, id)).toBe("p1");
  });

  it("insertRowAt を undo すると段数と confidences が挿入前に復元される", () => {
    const [id] = makeFields(["明細"]);
    useReportStore
      .getState()
      .setCells(new Map([[1, [new Map([[id, "1段目"]]), new Map([[id, "2段目"]])]]]));
    const conf: ConfidenceMatrix = new Map([
      [1, [new Map([[id, 0.9]]), new Map([[id, 0.4]])]],
    ]);
    useReportStore.getState().setConfidences(conf);

    useReportStore.getState().insertRowAt(1, 0);
    expect(useReportStore.getState().cells.get(1)).toHaveLength(3);
    expect(useReportStore.getState().confidences.has(1)).toBe(false); // 段構造変更で破棄

    useReportStore.getState().undo();
    expect(useReportStore.getState().cells.get(1)).toHaveLength(2);
    expect(useReportStore.getState().confidences.get(1)?.[0]?.get(id)).toBe(0.9);
    expect(useReportStore.getState().confidences.get(1)?.[1]?.get(id)).toBe(0.4);
  });

  it("moveCellValue(move) を undo すると空になった from と上書きされた to の両方が戻る", () => {
    const [idA, idB] = makeFields(["A", "B"]);
    seedCells([
      [idA, "あ"],
      [idB, "い"],
    ]);
    useReportStore.getState().moveCellValue(1, idA, idB, "move");
    expect(cellValue(1, 0, idA)).toBe("");
    expect(cellValue(1, 0, idB)).toBe("あ");

    useReportStore.getState().undo();
    expect(cellValue(1, 0, idA)).toBe("あ");
    expect(cellValue(1, 0, idB)).toBe("い");
  });

  it("setCellValue が新規段を生成した場合、undo で段数ごと元に戻る", () => {
    const [id] = makeFields(["明細"]);
    seedCells([[id, "1段目"]]);
    useReportStore.getState().setCellValue(1, id, "3段目", 2); // 段 index 2 → 空段を埋めて3段化
    expect(useReportStore.getState().cells.get(1)).toHaveLength(3);

    useReportStore.getState().undo();
    expect(useReportStore.getState().cells.get(1)).toHaveLength(1);
    expect(cellValue(1, 0, id)).toBe("1段目");
  });

  it("履歴上限まで積んだ後も redo チェーンで最新まで完全に戻れる", () => {
    const [id] = makeFields(["金額"]);
    seedCells([[id, "v0"]]);
    const total = HISTORY_LIMIT + 5;
    for (let i = 1; i <= total; i++) {
      useReportStore.getState().setCellValue(1, id, `v${i}`);
    }
    for (let i = 0; i < HISTORY_LIMIT; i++) {
      useReportStore.getState().undo();
    }
    expect(cellValue(1, 0, id)).toBe(`v${total - HISTORY_LIMIT}`);

    for (let i = 0; i < HISTORY_LIMIT; i++) {
      useReportStore.getState().redo();
    }
    expect(cellValue(1, 0, id)).toBe(`v${total}`);
    expect(useReportStore.getState().future).toHaveLength(0);
    expect(useReportStore.getState().past).toHaveLength(HISTORY_LIMIT);
  });
});

describe("undo/redo: no-op 経路は履歴を積まない（Ctrl+Z 空振り防止）", () => {
  it("removeRowAt の最終1段ガード（no-op）は履歴に積まれない", () => {
    const [id] = makeFields(["明細"]);
    seedCells([[id, "唯一の段"]]);
    useReportStore.getState().removeRowAt(1, 0); // 最後の1段 → no-op
    expect(useReportStore.getState().past).toHaveLength(0);
    expect(cellValue(1, 0, id)).toBe("唯一の段");
  });

  it("splitCellByNewlines の1要素 no-op は履歴に積まれない", () => {
    const [id] = makeFields(["明細"]);
    seedCells([[id, "改行なし"]]);
    useReportStore.getState().splitCellByNewlines(1, 0, id);
    expect(useReportStore.getState().past).toHaveLength(0);
  });
});

describe("undo/redo × CSV エクスポート整合（受入基準）", () => {
  const CSV_OPTS: CsvOptions = {
    includeFileName: false,
    includePageNumber: false,
    emptyValue: "",
    normalizeNumbers: false,
  };

  /** 現在の store state から CSV を組み立てる（エクスポート時と同じ入力経路） */
  function csvNow(pageNumbers: number[] = [1]): string {
    const s = useReportStore.getState();
    return buildTemplateCsv(s.template, s.cells, CSV_OPTS, { pageNumbers });
  }

  it("セル編集を undo した後の CSV には undo 前の値が出ない", () => {
    const [id] = makeFields(["金額"]);
    seedCells([[id, "100"]]);
    useReportStore.getState().setCellValue(1, id, "200");
    expect(csvNow()).toContain("200");

    useReportStore.getState().undo();
    const csv = csvNow();
    expect(csv).not.toContain("200"); // 編集後の値が漏れない
    expect(csv.split("\r\n")[1]).toBe("100"); // データ行は undo 後の state と一致

    useReportStore.getState().redo();
    expect(csvNow().split("\r\n")[1]).toBe("200");
  });

  it("明細分割 → CSV 複数行 → undo → CSV が1行に戻る（縦持ち展開と履歴の整合）", () => {
    const [id] = makeFields(["明細"]);
    useReportStore.getState().setFieldLineItem(id, true);
    seedCells([[id, "りんご\nみかん\nばなな"]]);

    useReportStore.getState().splitCellByNewlines(1, 0, id);
    const splitCsv = csvNow();
    expect(splitCsv.split("\r\n")).toHaveLength(4); // ヘッダ + 3段
    expect(splitCsv).toContain("みかん");

    useReportStore.getState().undo();
    const undoneCsv = csvNow();
    // 1段に戻る: ヘッダ + 改行入り値のクオート行（値内の \n で行数は増えるが段は1）
    expect(useReportStore.getState().cells.get(1)).toHaveLength(1);
    expect(undoneCsv).toContain('"りんご\nみかん\nばなな"');

    useReportStore.getState().redo();
    expect(csvNow().split("\r\n")).toHaveLength(4);
  });
});

describe("nudge 連打の coalesce（レビュー指摘 P2）", () => {
  it("同一ページへの連続 nudge は履歴1エントリに合流し undo 1回でまとめて戻る", () => {
    useReportStore.getState().nudgePageOffset(1, 1, 0);
    useReportStore.getState().nudgePageOffset(1, 1, 0);
    useReportStore.getState().nudgePageOffset(1, 0, 1);
    expect(useReportStore.getState().pageOffsets.get(1)).toEqual({ dx: 2, dy: 1 });
    expect(useReportStore.getState().past).toHaveLength(1);

    useReportStore.getState().undo();
    expect(useReportStore.getState().pageOffsets.has(1)).toBe(false);
  });

  it("nudge 連打が HISTORY_LIMIT を押し流さない（先行のセル編集履歴が残る）", () => {
    const [id] = makeFields(["金額"]);
    seedCells([[id, "100"]]);
    useReportStore.getState().setCellValue(1, id, "200");

    for (let i = 0; i < HISTORY_LIMIT * 2; i++) {
      useReportStore.getState().nudgePageOffset(1, 1, 0);
    }
    // セル編集1 + nudge 合流1 = 2 エントリのみ
    expect(useReportStore.getState().past).toHaveLength(2);

    useReportStore.getState().undo(); // nudge 一括
    useReportStore.getState().undo(); // セル編集
    expect(cellValue(1, 0, id)).toBe("100");
  });

  it("間に別操作を挟むと nudge は新しいエントリになる", () => {
    const [id] = makeFields(["金額"]);
    seedCells([[id, "100"]]);
    useReportStore.getState().nudgePageOffset(1, 1, 0);
    useReportStore.getState().setCellValue(1, id, "200");
    useReportStore.getState().nudgePageOffset(1, 1, 0);
    expect(useReportStore.getState().past).toHaveLength(3);
  });

  it("別ページへの nudge は合流しない", () => {
    useReportStore.getState().nudgePageOffset(1, 1, 0);
    useReportStore.getState().nudgePageOffset(2, 1, 0);
    expect(useReportStore.getState().past).toHaveLength(2);
  });

  it("undo 直後の nudge は合流せず新エントリになる", () => {
    useReportStore.getState().nudgePageOffset(1, 1, 0);
    useReportStore.getState().nudgePageOffset(1, 1, 0);
    useReportStore.getState().undo();
    expect(useReportStore.getState().pageOffsets.has(1)).toBe(false);

    useReportStore.getState().nudgePageOffset(1, 5, 0);
    expect(useReportStore.getState().pageOffsets.get(1)).toEqual({ dx: 5, dy: 0 });
    useReportStore.getState().undo();
    expect(useReportStore.getState().pageOffsets.has(1)).toBe(false);
  });

  it("setPageOffset（ドラッグ確定）は合流せず1操作=1エントリのまま", () => {
    useReportStore.getState().setPageOffset(1, 1, 0);
    useReportStore.getState().setPageOffset(1, 2, 0);
    expect(useReportStore.getState().past).toHaveLength(2);
  });
});

describe("防御ガード（レビュー指摘 MINOR）", () => {
  it("removeRowAt の範囲外 rowIndex は no-op（履歴も confidences も変わらない）", () => {
    const [id] = makeFields(["明細"]);
    useReportStore
      .getState()
      .setCells(new Map([[1, [new Map([[id, "a"]]), new Map([[id, "b"]])]]]));
    useReportStore
      .getState()
      .setConfidences(new Map([[1, [new Map([[id, 0.9]]), new Map([[id, 0.8]])]]]));

    useReportStore.getState().removeRowAt(1, 5); // 範囲外
    expect(useReportStore.getState().past).toHaveLength(0);
    expect(useReportStore.getState().confidences.get(1)?.[0]?.get(id)).toBe(0.9);
    expect(useReportStore.getState().cells.get(1)).toHaveLength(2);

    useReportStore.getState().removeRowAt(1, -1); // 負数
    expect(useReportStore.getState().past).toHaveLength(0);
  });

  it("エントリ未存在（undefined）セルへの clearCellValue は no-op", () => {
    const [idA, idB] = makeFields(["A", "B"]);
    seedCells([[idA, "値あり"]]); // idB はエントリ自体なし

    useReportStore.getState().clearCellValue(1, idB);
    expect(useReportStore.getState().past).toHaveLength(0);
    expect(useReportStore.getState().edited.get(1)?.[0]?.has(idB)).not.toBe(true);
  });

  it("空値セルの splitCellToNextRow は no-op（空段が挿入されない）", () => {
    const [id] = makeFields(["明細"]);
    seedCells([[id, ""]]);
    useReportStore.getState().splitCellToNextRow(1, 0, id, 0);
    expect(useReportStore.getState().cells.get(1)).toHaveLength(1);
    expect(useReportStore.getState().past).toHaveLength(0);
  });
});
