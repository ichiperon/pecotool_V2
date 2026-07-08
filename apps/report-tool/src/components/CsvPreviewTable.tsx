import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
  type FC,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { useReportStore } from "../store/reportStore";
import { usePdfStore } from "../store/pdfStore";
import { makeAnnouncement } from "../lib/announce";
import {
  listReviewTargets,
  countReviewTargets,
  LOW_CONFIDENCE_THRESHOLD,
} from "../logic/reviewTargets";

/** フォーカス位置（段対応） */
interface FocusPos {
  pageNum: number;
  rowIndex: number;
  fieldIndex: number;
}

/** ポインタードラッグの進行状態を保持する ref の型 */
interface DragRefState {
  pageNum: number;
  rowIndex: number;
  fieldId: string;
  pointerId: number;
  startX: number;
  startY: number;
  /** 移動量が閾値を超えたらドラッグ開始と判定 */
  started: boolean;
}

/** ドラッグ開始と判定するポインター移動量の閾値 (px) */
const DRAG_THRESHOLD = 5;

interface CsvPreviewTableProps {
  /**
   * 確認画面で左の PDF ビューアと同期する「現在のページ番号」。
   * 指定された行に --current クラスを付けて scrollIntoView する。
   * 省略した場合は同期しない（ステップ①②④での従来動作）。
   */
  activePage?: number;
  /**
   * 単一ページ再 OCR の実行中ページ番号。
   * 該当行にロード中スタイルを付ける。
   * 省略した場合は再 OCR UI なし。
   */
  reocrTarget?: number | null;
}

const CsvPreviewTable: FC<CsvPreviewTableProps> = ({ activePage, reocrTarget }) => {
  const fields = useReportStore((s) => s.template.fields);
  const cells = useReportStore((s) => s.cells);
  const confidences = useReportStore((s) => s.confidences);
  const edited = useReportStore((s) => s.edited);
  const excludedPages = useReportStore((s) => s.excludedPages);
  const setCells = useReportStore((s) => s.setCells);
  const setCellValue = useReportStore((s) => s.setCellValue);
  const clearCellValue = useReportStore((s) => s.clearCellValue);
  const moveCellValue = useReportStore((s) => s.moveCellValue);
  const insertRowAt = useReportStore((s) => s.insertRowAt);
  const removeRowAt = useReportStore((s) => s.removeRowAt);
  const splitCellToNextRow = useReportStore((s) => s.splitCellToNextRow);
  const splitCellByNewlines = useReportStore((s) => s.splitCellByNewlines);
  const undo = useReportStore((s) => s.undo);
  const redo = useReportStore((s) => s.redo);
  // primitive セレクタで購読し、履歴の中身ではなく有無の変化だけで再レンダーする
  const canUndo = useReportStore((s) => s.past.length > 0);
  const canRedo = useReportStore((s) => s.future.length > 0);
  const setCurrentPage = usePdfStore((s) => s.setCurrentPage);

  const pageNumbers = Array.from(cells.keys()).sort((a, b) => a - b);
  const hasData = pageNumbers.length > 0;
  const hasFields = fields.length > 0;

  // 編集状態（段対応）
  const [editPos, setEditPos] = useState<{ pageNum: number; rowIndex: number; fieldId: string } | null>(null);
  const [editValue, setEditValue] = useState("");
  // フォーカス位置（グリッドナビ用・段対応）
  const [focusPos, setFocusPos] = useState<FocusPos | null>(null);
  // ドラッグ状態（Pointer Events ベース）
  const [dragSource, setDragSource] = useState<{ pageNum: number; rowIndex: number; fieldId: string } | null>(null);
  const [dragOverPos, setDragOverPos] = useState<{ pageNum: number; fieldId: string } | null>(null);
  // aria-live 通知（toggle で同一テキスト連続セット時も再アナウンスを保証）
  const [announcement, setAnnouncement] = useState("");
  const announcementToggleRef = useRef(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const cellRefs = useRef<Map<string, HTMLTableCellElement>>(new Map());
  /** activePage 対応行の tr ref（scrollIntoView 用）— ページ先頭段のみ */
  const rowRefs = useRef<Map<number, HTMLTableRowElement>>(new Map());

  /**
   * ドラッグ進行状態を ref で保持する（setState を介さない）。
   */
  const dragRef = useRef<DragRefState | null>(null);

  /** セルキー: ページ:段:欄インデックス */
  const getCellKey = (pageNum: number, rowIndex: number, fieldIndex: number) =>
    `${pageNum}:${rowIndex}:${fieldIndex}`;

  /**
   * focusPos のフィールドインデックス・段インデックス・ページを有効範囲にクランプする。
   */
  const clampFocusPos = useCallback(
    (
      pos: FocusPos,
      currentFields: typeof fields,
      currentPageNumbers: typeof pageNumbers
    ): FocusPos | null => {
      if (currentFields.length === 0 || currentPageNumbers.length === 0) return null;
      const clampedFieldIndex = Math.min(pos.fieldIndex, currentFields.length - 1);
      const pageIdx = currentPageNumbers.indexOf(pos.pageNum);
      const resolvedPageIdx = pageIdx >= 0 ? pageIdx : Math.min(0, currentPageNumbers.length - 1);
      const clampedPageNum =
        currentPageNumbers[Math.min(resolvedPageIdx, currentPageNumbers.length - 1)];
      const pageRows = cells.get(clampedPageNum) ?? [];
      const maxRowIndex = Math.max(0, pageRows.length - 1);
      const clampedRowIndex = Math.min(pos.rowIndex, maxRowIndex);
      return { pageNum: clampedPageNum, rowIndex: clampedRowIndex, fieldIndex: clampedFieldIndex };
    },
    [cells]
  );

  // activePage が変化したとき該当行を scrollIntoView
  useEffect(() => {
    if (activePage == null) return;
    const rowEl = rowRefs.current.get(activePage);
    if (rowEl && typeof rowEl.scrollIntoView === "function") {
      rowEl.scrollIntoView({ block: "nearest" });
    }
  }, [activePage]);

  // 通知を発火するヘルパー
  const announce = useCallback((text: string) => {
    announcementToggleRef.current = !announcementToggleRef.current;
    setAnnouncement(makeAnnouncement(text, announcementToggleRef.current));
  }, []);

  // 要確認セル（低信頼・空）のドキュメント順リストと件数（ナビ・サマリチップ用）
  const reviewTargets = useMemo(
    () => listReviewTargets(cells, confidences, fields, excludedPages),
    [cells, confidences, fields, excludedPages]
  );
  const reviewCounts = useMemo(() => countReviewTargets(reviewTargets), [reviewTargets]);

  const fieldIndexById = useMemo(
    () => new Map(fields.map((f, i) => [f.id, i])),
    [fields]
  );

  /**
   * 「次の要確認セルへ」: 現在フォーカス位置よりドキュメント順で後ろにある
   * 最初の要確認セルへフォーカスを移す（末尾まで行ったら先頭へ循環）。
   * 確認画面では左 PDF のページも同期する。
   */
  const handleGoToNextReview = useCallback(() => {
    if (reviewTargets.length === 0) return;

    const pageOrder = new Map(pageNumbers.map((p, i) => [p, i]));
    // タプル逐次比較（page→row→field）。合成キーだと段・欄数の上限仮定が要る
    // （段1000超で桁あふれ）ため、上限仮定なしの比較にする。
    const isAfterFocus = (pageNum: number, rowIndex: number, fieldIndex: number): boolean => {
      if (!focusPos) return true;
      const pi = pageOrder.get(pageNum) ?? -1;
      const cp = pageOrder.get(focusPos.pageNum) ?? -1;
      if (pi !== cp) return pi > cp;
      if (rowIndex !== focusPos.rowIndex) return rowIndex > focusPos.rowIndex;
      return fieldIndex > focusPos.fieldIndex;
    };

    const next =
      reviewTargets.find((t) =>
        isAfterFocus(t.pageNum, t.rowIndex, fieldIndexById.get(t.fieldId) ?? 0)
      ) ?? reviewTargets[0]; // 末尾まで確認したら先頭へ循環

    const fieldIndex = fieldIndexById.get(next.fieldId) ?? 0;
    setFocusPos({ pageNum: next.pageNum, rowIndex: next.rowIndex, fieldIndex });
    if (activePage != null) {
      setCurrentPage(next.pageNum);
    }
    const fieldName = fields[fieldIndex]?.name ?? "";
    const kindLabel = next.kind === "lowConfidence" ? "低信頼" : "空";
    announce(
      `${next.pageNum}ページ目 段${next.rowIndex + 1} ${fieldName}（${kindLabel}）へ移動。要確認 残り${reviewTargets.length}件`
    );
  }, [reviewTargets, pageNumbers, focusPos, fieldIndexById, fields, activePage, setCurrentPage, announce]);

  /**
   * 編集開始。isLineItem フィールドは textarea、固定欄は input で開く。
   */
  const startEdit = useCallback(
    (pageNum: number, rowIndex: number, fieldId: string) => {
      const rows = cells.get(pageNum) ?? [];
      const row = rows[rowIndex] ?? new Map<string, string>();
      const value = row.get(fieldId) ?? "";
      setEditPos({ pageNum, rowIndex, fieldId });
      setEditValue(value);
    },
    [cells]
  );

  // 編集確定
  const commitEdit = useCallback(() => {
    if (!editPos) return;
    setCellValue(editPos.pageNum, editPos.fieldId, editValue, editPos.rowIndex);
    setEditPos(null);
  }, [editPos, editValue, setCellValue]);

  // 編集取消: フォーカスを親セル(td)へ確実に戻す
  const cancelEdit = useCallback(() => {
    if (!editPos) {
      setEditPos(null);
      return;
    }
    const fieldIndex = fields.findIndex((f) => f.id === editPos.fieldId);
    const safeFieldIndex = fieldIndex >= 0 ? fieldIndex : 0;
    setEditPos(null);
    const targetKey = getCellKey(editPos.pageNum, editPos.rowIndex, safeFieldIndex);
    requestAnimationFrame(() => {
      cellRefs.current.get(targetKey)?.focus();
    });
  }, [editPos, fields]);

  // input/textarea がマウントされたらフォーカス
  useEffect(() => {
    if (editPos) {
      const field = fields.find((f) => f.id === editPos.fieldId);
      if (field?.isLineItem) {
        if (textareaRef.current) {
          textareaRef.current.focus();
          textareaRef.current.select();
        }
      } else {
        if (inputRef.current) {
          inputRef.current.focus();
          inputRef.current.select();
        }
      }
    }
  }, [editPos, fields]);

  // セル削除
  const handleDelete = useCallback(
    (pageNum: number, rowIndex: number, fieldId: string, fieldName: string) => {
      clearCellValue(pageNum, fieldId, rowIndex);
      announce(`${pageNum}ページ目 ${fieldName} を削除しました`);
    },
    [clearCellValue, announce]
  );

  // 開発用: サンプルデータを注入
  const injectSampleData = () => {
    if (fields.length === 0) return;
    const sample = new Map<number, Map<string, string>[]>();
    for (let page = 1; page <= 3; page++) {
      const row = new Map<string, string>();
      fields.forEach((field, idx) => {
        if (page === 1 && idx === 0) {
          row.set(field.id, "");
        } else {
          row.set(field.id, `サンプル-P${page}-${field.name}`);
        }
      });
      sample.set(page, [row]);
    }
    setCells(sample);
  };

  /**
   * ページ内の全段を走査してフラットな (pageNum, rowIndex) ペアのリストを返す。
   * ↑↓ナビゲーションで段・ページを連続移動するために使う。
   */
  const getAllRows = useCallback((): { pageNum: number; rowIndex: number }[] => {
    const result: { pageNum: number; rowIndex: number }[] = [];
    for (const pageNum of pageNumbers) {
      const rows = cells.get(pageNum) ?? [];
      const rowCount = Math.max(rows.length, 1);
      for (let r = 0; r < rowCount; r++) {
        result.push({ pageNum, rowIndex: r });
      }
    }
    return result;
  }, [pageNumbers, cells]);

  // グリッドキーボードナビ（段対応）
  const handleCellKeyDown = useCallback(
    (
      e: KeyboardEvent<HTMLTableCellElement>,
      pageNum: number,
      rowIndex: number,
      fieldIndex: number
    ) => {
      // 編集中の input/textarea からバブリングしてきたキー操作は、専用ハンドラ
      // （handleInputKeyDown/handleTextareaKeyDown）で完結させる。ここで
      // Enter/F2/Delete/Backspace 等を再処理すると、コミット直前の古い cells
      // クロージャで startEdit や handleDelete が二重発火し、確定値の巻き戻りや
      // セル全体の誤消去につながる（BLOCKER）。OffsetAdjustOverlay の MA-4 と
      // 同じガードパターン。
      // #434 F8: セル内の×削除ボタン（tabIndex=-1 だがフォーカス可能）にフォーカス中の
      // Enter も同様にバブリングし、td の startEdit（Enter/F2 分岐）を誤発火させていた
      // （ed85c92 のガードは INPUT/TEXTAREA のみで BUTTON が漏れていた）。
      const eventTarget = e.target as HTMLElement | null;
      if (
        eventTarget &&
        (eventTarget.tagName === "INPUT" ||
          eventTarget.tagName === "TEXTAREA" ||
          eventTarget.tagName === "BUTTON")
      ) {
        return;
      }

      const fieldId = fields[fieldIndex]?.id;
      const fieldName = fields[fieldIndex]?.name ?? "";
      const isLineItem = fields[fieldIndex]?.isLineItem === true;

      // 固定欄かつ2段目以降（〃セル）は編集・削除・段操作を無視する。
      // 矢印キーによるナビゲーションは通常フローへ素通しする。
      const isDittoCellHere = !isLineItem && rowIndex > 0;
      if (isDittoCellHere) {
        const isNavKey = ["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown"].includes(e.key);
        if (!isNavKey) {
          e.preventDefault();
          return;
        }
        // 矢印は下の通常ナビロジックへ素通し
      }

      if (e.key === "Enter" || e.key === "F2") {
        e.preventDefault();
        startEdit(pageNum, rowIndex, fieldId);
        return;
      }

      // Alt 修飾キー付きは先に判定する（単体 Delete より前）
      // Alt+ArrowDown: 直下に空段挿入
      if (e.altKey && e.key === "ArrowDown") {
        e.preventDefault();
        insertRowAt(pageNum, rowIndex);
        const newRowIndex = rowIndex + 1;
        // 明細欄の最初のフィールドにフォーカス
        const firstLineItemIdx = fields.findIndex((f) => f.isLineItem);
        const targetFieldIdx = firstLineItemIdx >= 0 ? firstLineItemIdx : fieldIndex;
        setFocusPos({ pageNum, rowIndex: newRowIndex, fieldIndex: targetFieldIdx });
        announce(`${pageNum}ページ目 段${newRowIndex + 1}を挿入しました`);
        return;
      }

      // Alt+ArrowUp: 直上に空段挿入
      if (e.altKey && e.key === "ArrowUp") {
        e.preventDefault();
        insertRowAt(pageNum, rowIndex - 1);
        // 挿入された段はそのまま rowIndex の位置
        const firstLineItemIdx = fields.findIndex((f) => f.isLineItem);
        const targetFieldIdx = firstLineItemIdx >= 0 ? firstLineItemIdx : fieldIndex;
        setFocusPos({ pageNum, rowIndex, fieldIndex: targetFieldIdx });
        announce(`${pageNum}ページ目 段${rowIndex + 1}を挿入しました`);
        return;
      }

      // Alt+Delete: 段削除
      if (e.altKey && e.key === "Delete") {
        e.preventDefault();
        const rows = cells.get(pageNum) ?? [];
        if (rows.length <= 1) {
          announce(`${pageNum}ページ目 最後の段は削除できません`);
          return;
        }
        removeRowAt(pageNum, rowIndex);
        // 削除後のフォーカス: 同位置 or 前段
        const newRows = (cells.get(pageNum) ?? []).filter((_, i) => i !== rowIndex);
        const newRowIndex = Math.min(rowIndex, Math.max(0, newRows.length - 1));
        setFocusPos({ pageNum, rowIndex: newRowIndex, fieldIndex });
        announce(`${pageNum}ページ目 段${rowIndex + 1}を削除しました`);
        return;
      }

      // Delete/Backspace: セル値クリア（Alt なし）
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        handleDelete(pageNum, rowIndex, fieldId, fieldName);
        return;
      }

      if (e.key === "ArrowRight") {
        e.preventDefault();
        const nextFieldIdx = Math.min(fieldIndex + 1, fields.length - 1);
        setFocusPos({ pageNum, rowIndex, fieldIndex: nextFieldIdx });
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        const prevFieldIdx = Math.max(fieldIndex - 1, 0);
        setFocusPos({ pageNum, rowIndex, fieldIndex: prevFieldIdx });
        return;
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        const allRows = getAllRows();
        const currentIdx = allRows.findIndex(
          (r) => r.pageNum === pageNum && r.rowIndex === rowIndex
        );
        if (currentIdx >= 0 && currentIdx < allRows.length - 1) {
          const next = allRows[currentIdx + 1];
          setFocusPos({ pageNum: next.pageNum, rowIndex: next.rowIndex, fieldIndex });
        }
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        const allRows = getAllRows();
        const currentIdx = allRows.findIndex(
          (r) => r.pageNum === pageNum && r.rowIndex === rowIndex
        );
        if (currentIdx > 0) {
          const prev = allRows[currentIdx - 1];
          setFocusPos({ pageNum: prev.pageNum, rowIndex: prev.rowIndex, fieldIndex });
        }
        return;
      }
    },
    [fields, cells, getAllRows, startEdit, handleDelete, insertRowAt, removeRowAt, announce]
  );

  // focusPos が範囲外になったとき(欄/ページ削除後等)クランプする
  useEffect(() => {
    if (!focusPos) return;
    const clamped = clampFocusPos(focusPos, fields, pageNumbers);
    if (clamped === null) {
      setFocusPos(null);
      return;
    }
    if (
      clamped.fieldIndex !== focusPos.fieldIndex ||
      clamped.pageNum !== focusPos.pageNum ||
      clamped.rowIndex !== focusPos.rowIndex
    ) {
      setFocusPos(clamped);
    }
  }, [focusPos, fields, pageNumbers, clampFocusPos]);

  // フォーカス位置が変わったとき対応セルにフォーカスを当てる
  useEffect(() => {
    if (focusPos && !editPos) {
      const key = getCellKey(focusPos.pageNum, focusPos.rowIndex, focusPos.fieldIndex);
      const el = cellRefs.current.get(key);
      el?.focus();
    }
  }, [focusPos, editPos]);

  // input でのキー操作（固定欄）
  const handleInputKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>, pageNum: number, rowIndex: number, fieldIndex: number) => {
      if (e.key === "Enter") {
        // IME 変換確定の Enter はセル編集の commit に渡さない（変換確定しただけで
        // 編集が閉じてしまうのを防ぐ）。ブラウザの変換確定処理に委ねる。
        // keyCode 229 は isComposing が false で届く IME 確定キーの互換フォールバック
        // （Modal.tsx Issue #65 と同じ二重ガード）。
        if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
        e.preventDefault();
        commitEdit();
        const nextFieldIdx = fieldIndex + 1;
        if (nextFieldIdx < fields.length) {
          setFocusPos({ pageNum, rowIndex, fieldIndex: nextFieldIdx });
        }
        return;
      }
      if (e.key === "Escape") {
        // IME 変換中の Escape は変換候補のキャンセル用なので cancelEdit へ渡さない
        // （Modal.tsx Issue #65 と同じ方針・keyCode 229 は互換フォールバック）。
        if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
        e.preventDefault();
        cancelEdit();
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        commitEdit();
        const dir = e.shiftKey ? -1 : 1;
        const nextFieldIdx = fieldIndex + dir;
        if (nextFieldIdx >= 0 && nextFieldIdx < fields.length) {
          setFocusPos({ pageNum, rowIndex, fieldIndex: nextFieldIdx });
        }
      }
    },
    [commitEdit, cancelEdit, fields.length]
  );

  /**
   * textarea でのキー操作（明細欄）。
   * Ctrl+Enter で段分割、Escape でキャンセル、Tab で次欄へ。
   * 通常の Enter は改行（textarea デフォルト）。
   */
  const handleTextareaKeyDown = useCallback(
    (
      e: KeyboardEvent<HTMLTextAreaElement>,
      pageNum: number,
      rowIndex: number,
      fieldIndex: number,
      fieldId: string
    ) => {
      if (e.key === "Escape") {
        // IME 変換中の Escape は変換候補のキャンセル用なので cancelEdit へ渡さない
        // （Modal.tsx Issue #65 と同じ方針・keyCode 229 は互換フォールバック）。
        if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
        e.preventDefault();
        cancelEdit();
        return;
      }

      if (e.key === "Tab") {
        e.preventDefault();
        commitEdit();
        const dir = e.shiftKey ? -1 : 1;
        const nextFieldIdx = fieldIndex + dir;
        if (nextFieldIdx >= 0 && nextFieldIdx < fields.length) {
          setFocusPos({ pageNum, rowIndex, fieldIndex: nextFieldIdx });
        }
        return;
      }

      // Ctrl+Enter: 段分割
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        // IME 変換確定と Ctrl+Enter が競合するケースへの防御的ガード
        // （keyCode 229 は互換フォールバック）。
        if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
        e.preventDefault();
        const textarea = e.currentTarget;
        const cursorPos = textarea.selectionStart ?? 0;
        const selectionEnd = textarea.selectionEnd ?? 0;
        const currentValue = editValue;

        // まず編集中の値を確定してから分割アクションを呼ぶ
        setCellValue(pageNum, fieldId, currentValue, rowIndex);

        const hasNewlines = currentValue.includes("\n");
        // 全選択またはカーソルが先頭かつ改行あり → 一括分割
        if (hasNewlines && (cursorPos === 0 && selectionEnd === currentValue.length || cursorPos === selectionEnd && cursorPos === 0)) {
          splitCellByNewlines(pageNum, rowIndex, fieldId);
          // 一括分割後: 最後の新段の同欄へフォーカス
          requestAnimationFrame(() => {
            const rows = useReportStore.getState().cells.get(pageNum) ?? [];
            const lastRowIndex = rows.length - 1;
            setFocusPos({ pageNum, rowIndex: lastRowIndex, fieldIndex });
            setEditPos(null);
            announce(`${rows.length}段に分割しました`);
          });
        } else {
          // 逐次分割: カーソル位置で割る
          splitCellToNextRow(pageNum, rowIndex, fieldId, cursorPos);
          // 逐次分割後: 新段の同欄へフォーカス
          const newRowIndex = rowIndex + 1;
          setEditPos(null);
          setFocusPos({ pageNum, rowIndex: newRowIndex, fieldIndex });
          announce(`2段に分割しました`);
        }
        return;
      }
    },
    [editValue, commitEdit, cancelEdit, fields.length, setCellValue, splitCellByNewlines, splitCellToNextRow, announce]
  );

  // ドラッグ終了の共通クリーンアップ
  const cleanupDrag = useCallback(() => {
    dragRef.current = null;
    setDragSource(null);
    setDragOverPos(null);
  }, []);

  /**
   * Pointer Events ベースのドラッグ実装（段対応）。
   * 同一ページ・同一段内のみドロップ可能。
   */
  const handlePointerDown = useCallback(
    (
      e: PointerEvent<HTMLTableCellElement>,
      pageNum: number,
      rowIndex: number,
      fieldId: string
    ) => {
      if (editPos !== null) return;
      if ((e.target as HTMLElement).closest("button")) return;
      if (e.button !== 0) return;

      e.currentTarget.setPointerCapture?.(e.pointerId);

      dragRef.current = {
        pageNum,
        rowIndex,
        fieldId,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        started: false,
      };
    },
    [editPos]
  );

  const handlePointerMove = useCallback(
    (e: PointerEvent<HTMLTableCellElement>) => {
      const drag = dragRef.current;
      if (!drag) return;

      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      const dist = Math.hypot(dx, dy);

      if (!drag.started && dist >= DRAG_THRESHOLD) {
        drag.started = true;
        setDragSource({ pageNum: drag.pageNum, rowIndex: drag.rowIndex, fieldId: drag.fieldId });
      }

      if (!drag.started) return;

      const el = document.elementFromPoint(e.clientX, e.clientY);
      const tdEl = el?.closest("td[data-field-id]") as HTMLElement | null;

      if (!tdEl) {
        setDragOverPos(null);
        return;
      }

      const overPageNum = Number(tdEl.dataset.pageNum);
      const overRowIndex = Number(tdEl.dataset.rowIndex);
      const overFieldId = tdEl.dataset.fieldId ?? "";

      // ページ跨ぎ禁止・段跨ぎ禁止
      if (overPageNum !== drag.pageNum || overRowIndex !== drag.rowIndex) {
        setDragOverPos(null);
        return;
      }

      setDragOverPos({ pageNum: overPageNum, fieldId: overFieldId });
    },
    []
  );

  const handlePointerUp = useCallback(
    (e: PointerEvent<HTMLTableCellElement>) => {
      const drag = dragRef.current;
      if (!drag) return;

      if (drag.started && dragOverPos && dragOverPos.pageNum === drag.pageNum) {
        moveCellValue(drag.pageNum, drag.fieldId, dragOverPos.fieldId, "swap", drag.rowIndex);
        const fromField = fields.find((f) => f.id === drag.fieldId)?.name ?? "";
        const toField = fields.find((f) => f.id === dragOverPos.fieldId)?.name ?? "";
        announce(
          `${drag.pageNum}ページ目 段${drag.rowIndex + 1}: ${fromField} と ${toField} の値を移動しました`
        );
      }

      try {
        e.currentTarget.releasePointerCapture(drag.pointerId);
      } catch {
        // キャプチャが既に解放されている場合は無視
      }
      cleanupDrag();
    },
    [dragOverPos, moveCellValue, fields, announce, cleanupDrag]
  );

  const handlePointerCancel = useCallback(
    (e: PointerEvent<HTMLTableCellElement>) => {
      const drag = dragRef.current;
      if (drag) {
        try {
          e.currentTarget.releasePointerCapture(drag.pointerId);
        } catch {
          // キャプチャが既に解放されている場合は無視
        }
      }
      cleanupDrag();
    },
    [cleanupDrag]
  );

  if (!hasFields) {
    return (
      <div className="csv-preview csv-preview--empty">
        <p>欄テンプレートに欄を追加すると、ここにプレビューが表示されます。</p>
      </div>
    );
  }

  if (!hasData) {
    return (
      <div className="csv-preview csv-preview--empty">
        <p>OCR 後に値が表示されます。</p>
        {import.meta.env.DEV && (
          <button type="button" className="csv-preview__sample-btn" onClick={injectSampleData}>
            サンプルデータを挿入（開発用）
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="csv-preview">
      {/* aria-live 領域（削除・移動・分割のアナウンス） */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </div>

      <div className="csv-preview__toolbar">
        <span className="csv-preview__info">
          {pageNumbers.length} ページ / {fields.length} 欄
        </span>
        <div className="csv-preview__undo-group" role="group" aria-label="編集履歴">
          <button
            type="button"
            className="csv-preview__undo-btn"
            onClick={() => {
              undo();
              announce("元に戻しました");
            }}
            disabled={!canUndo}
            title="元に戻す (Ctrl+Z)"
            aria-label="元に戻す"
            aria-keyshortcuts="Control+Z"
          >
            ↶
          </button>
          <button
            type="button"
            className="csv-preview__undo-btn"
            onClick={() => {
              redo();
              announce("やり直しました");
            }}
            disabled={!canRedo}
            title="やり直す (Ctrl+Y)"
            aria-label="やり直す"
            aria-keyshortcuts="Control+Y Control+Shift+Z"
          >
            ↷
          </button>
        </div>
        {(reviewCounts.lowConfidence > 0 || reviewCounts.empty > 0) && (
          <div className="csv-preview__review-nav">
            {reviewCounts.lowConfidence > 0 && (
              <span
                className="csv-preview__review-chip csv-preview__review-chip--lowconf"
                title="OCR 信頼度が低いセルの残数"
              >
                ⚠ 低信頼 {reviewCounts.lowConfidence}
              </span>
            )}
            {reviewCounts.empty > 0 && (
              <span
                className="csv-preview__review-chip csv-preview__review-chip--empty"
                title="値が空のセルの残数"
              >
                空 {reviewCounts.empty}
              </span>
            )}
            <button
              type="button"
              className="csv-preview__review-next-btn"
              onClick={handleGoToNextReview}
              aria-label="次の要確認セルへ移動"
              title="次の要確認セル（低信頼・空）へ移動"
            >
              次の要確認 ▶
            </button>
          </div>
        )}
        {import.meta.env.DEV && (
          <button type="button" className="csv-preview__sample-btn" onClick={injectSampleData}>
            サンプル再挿入（開発用）
          </button>
        )}
      </div>

      <div className="csv-preview__table-wrapper">
        <table
          className="csv-preview__table"
          role="grid"
          aria-label={`OCR 結果編集テーブル: ${pageNumbers.length}ページ / ${fields.length}欄`}
        >
          <thead>
            <tr role="row">
              <th
                className="csv-preview__th csv-preview__th--page"
                role="columnheader"
                scope="col"
              >
                ページ
              </th>
              <th
                className="csv-preview__th csv-preview__th--rownum"
                role="columnheader"
                scope="col"
                aria-label="段番号"
              >
                段
              </th>
              {fields.map((field) => (
                <th key={field.id} className="csv-preview__th" role="columnheader" scope="col">
                  <span
                    className="csv-preview__field-badge"
                    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
                    style={{ "--field-color": field.color } as React.CSSProperties}
                    aria-hidden="true"
                  />
                  {field.name}
                  {field.isLineItem && (
                    <span className="csv-preview__lineitem-pill" aria-label="明細欄">
                      明細
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageNumbers.map((pageNum) => {
              const pageRows = cells.get(pageNum) ?? [new Map<string, string>()];
              const isDimmedPage = dragSource !== null && dragSource.pageNum !== pageNum;
              const isExcludedPage = excludedPages.has(pageNum);
              const isCurrentPage = activePage != null && activePage === pageNum;
              const isReocrLoading = reocrTarget != null && reocrTarget === pageNum;

              return pageRows.map((rowMap, rowIndex) => {
                const isFirstRow = rowIndex === 0;

                return (
                  <tr
                    key={`${pageNum}-${rowIndex}`}
                    ref={
                      isFirstRow
                        ? (el) => {
                            if (el) rowRefs.current.set(pageNum, el);
                            else rowRefs.current.delete(pageNum);
                          }
                        : undefined
                    }
                    role="row"
                    className={[
                      isDimmedPage ? "csv-preview__row--dimmed" : "",
                      isExcludedPage ? "csv-preview__row--excluded" : "",
                      isCurrentPage && isFirstRow ? "csv-preview__row--current" : "",
                      isReocrLoading ? "csv-preview__row--reocr-loading" : "",
                      !isFirstRow ? "csv-preview__row--continuation" : "",
                    ]
                      .filter(Boolean)
                      .join(" ") || undefined}
                    aria-description={isDimmedPage ? "このページへはドロップできません" : undefined}
                    onClick={() => {
                      if (activePage != null) {
                        setCurrentPage(pageNum);
                      }
                    }}
                  >
                    {/* ページ番号セル: 先頭段のみ表示 */}
                    {isFirstRow ? (
                      <td
                        className="csv-preview__td csv-preview__td--page"
                        role="rowheader"
                        aria-label={`${pageNum}ページ目${isExcludedPage ? "（除外中・CSVに出力されません）" : ""}`}
                      >
                        {pageNum}
                        {isExcludedPage && (
                          <span className="csv-preview__excluded-pill" aria-hidden="true">
                            除外
                          </span>
                        )}
                      </td>
                    ) : (
                      <td
                        className="csv-preview__td csv-preview__td--page csv-preview__td--page-continuation"
                        aria-hidden="true"
                      />
                    )}
                    {/* 段番号セル */}
                    <td
                      className="csv-preview__td csv-preview__td--rownum"
                      role="rowheader"
                      aria-label={`段${rowIndex + 1}`}
                    >
                      {rowIndex + 1}
                    </td>
                    {fields.map((field, fieldIndex) => {
                      const value = rowMap?.get(field.id) ?? "";
                      const isEmpty = value === "";
                      const isEditing =
                        editPos?.pageNum === pageNum &&
                        editPos?.rowIndex === rowIndex &&
                        editPos?.fieldId === field.id;
                      const isDragOver =
                        dragOverPos?.pageNum === pageNum &&
                        dragOverPos?.fieldId === field.id &&
                        dragSource?.rowIndex === rowIndex;
                      const isDragSource =
                        dragSource?.pageNum === pageNum &&
                        dragSource?.rowIndex === rowIndex &&
                        dragSource?.fieldId === field.id;
                      const cellKey = getCellKey(pageNum, rowIndex, fieldIndex);
                      const isLineItem = field.isLineItem === true;
                      // 固定欄かつ2段目以降: 〃表示（編集不可）
                      const isDittoCell = !isLineItem && rowIndex > 0;

                      // OCR 信頼度: 閾値以下かつ〃セル・空セル以外のとき低信頼強調
                      // （閾値は reviewTargets の列挙ロジックと共有 — 判定のズレ防止）
                      const pageConfRows = confidences.get(pageNum);
                      const cellConf = pageConfRows?.[rowIndex]?.get(field.id);
                      const isLowConfidence =
                        cellConf !== undefined &&
                        cellConf <= LOW_CONFIDENCE_THRESHOLD &&
                        !isDittoCell &&
                        !isEmpty;

                      // 手修正フラグ: 人が編集・削除・移動・分割で触ったセルの印
                      // （〃セルは対象外。空セルには表示する — 人が意図して空にした証跡）
                      const isEdited =
                        edited.get(pageNum)?.[rowIndex]?.has(field.id) === true &&
                        !isDittoCell;

                      // isFocused: roving tabindex 判定
                      const isFocused =
                        focusPos?.pageNum === pageNum &&
                        focusPos?.rowIndex === rowIndex &&
                        focusPos?.fieldIndex === fieldIndex;
                      const isInitialTabStop =
                        pageNum === pageNumbers[0] && rowIndex === 0 && fieldIndex === 0;

                      return (
                        <td
                          key={`${field.id}-${rowIndex}`}
                          ref={(el) => {
                            if (el) cellRefs.current.set(cellKey, el);
                            else cellRefs.current.delete(cellKey);
                          }}
                          className={[
                            "csv-preview__td",
                            isEmpty && !isDittoCell ? "csv-preview__td--empty" : "",
                            isDragOver ? "csv-preview__td--drag-over" : "",
                            isDragSource ? "csv-preview__td--drag-source" : "",
                            isDittoCell ? "csv-preview__td--ditto" : "",
                            isLineItem ? "csv-preview__td--lineitem" : "",
                            isLowConfidence ? "csv-preview__td--low-confidence" : "",
                            isEdited ? "csv-preview__td--edited" : "",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          role="gridcell"
                          aria-label={
                            isDittoCell
                              ? `${pageNum}ページ目 段${rowIndex + 1} ${field.name} 同上`
                              : `${pageNum}ページ目 段${rowIndex + 1} ${field.name} ${isEmpty ? "空" : value}${isLowConfidence ? "。信頼度低・要確認" : ""}${isEdited ? "。手修正済み" : ""}${isDittoCell ? "" : "。Delete キーで削除"}`
                          }
                          {...(isDimmedPage ? { "aria-disabled": "true" } : {})}
                          {...(isDittoCell ? { "aria-readonly": "true" } : {})}
                          tabIndex={
                            isFocused ? 0 : isInitialTabStop && !focusPos ? 0 : -1
                          }
                          data-page-num={pageNum}
                          data-row-index={rowIndex}
                          data-field-id={field.id}
                          title={isDittoCell ? "〃（固定欄は先頭段のみ編集可）" : isEmpty ? "空" : value}
                          onDoubleClick={() => {
                            if (!isDittoCell) startEdit(pageNum, rowIndex, field.id);
                          }}
                          onKeyDown={(e) =>
                            handleCellKeyDown(e, pageNum, rowIndex, fieldIndex)
                          }
                          onFocus={() =>
                            setFocusPos({ pageNum, rowIndex, fieldIndex })
                          }
                          onPointerDown={(e) => {
                            if (!isDittoCell) handlePointerDown(e, pageNum, rowIndex, field.id);
                          }}
                          onPointerMove={handlePointerMove}
                          onPointerUp={handlePointerUp}
                          onPointerCancel={handlePointerCancel}
                        >
                          {isDittoCell ? (
                            // 固定欄の2段目以降は〃（同上）表示
                            <span className="csv-preview__ditto-mark" aria-hidden="true">
                              〃
                            </span>
                          ) : isEditing ? (
                            isLineItem ? (
                              // 明細欄: textarea で複数行編集
                              <textarea
                                ref={textareaRef}
                                className="csv-preview__cell-textarea"
                                value={editValue}
                                rows={Math.max(2, (editValue.match(/\n/g) ?? []).length + 1)}
                                onChange={(e) => setEditValue(e.target.value)}
                                onBlur={commitEdit}
                                onKeyDown={(e) =>
                                  handleTextareaKeyDown(
                                    e,
                                    pageNum,
                                    rowIndex,
                                    fieldIndex,
                                    field.id
                                  )
                                }
                                aria-label={`${pageNum}ページ目 段${rowIndex + 1} ${field.name} 編集中（Ctrl+Enter で段分割）`}
                              />
                            ) : (
                              // 固定欄: 単一行 input
                              <input
                                ref={inputRef}
                                className="csv-preview__cell-input"
                                value={editValue}
                                onChange={(e) => setEditValue(e.target.value)}
                                onBlur={commitEdit}
                                onKeyDown={(e) =>
                                  handleInputKeyDown(e, pageNum, rowIndex, fieldIndex)
                                }
                                aria-label={`${pageNum}ページ目 段${rowIndex + 1} ${field.name} 編集中`}
                              />
                            )
                          ) : (
                            <>
                              {isEdited && (
                                <span
                                  className="csv-preview__edited-mark"
                                  title="手修正済み"
                                  aria-hidden="true"
                                >
                                  ✎
                                </span>
                              )}
                              {isEmpty ? (
                                <span className="csv-preview__empty-mark">(空)</span>
                              ) : (
                                <span className="csv-preview__cell-value">{value}</span>
                              )}
                              <button
                                type="button"
                                className="csv-preview__cell-clear-btn"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDelete(pageNum, rowIndex, field.id, field.name);
                                }}
                                tabIndex={-1}
                                aria-label={`${pageNum}ページ目 段${rowIndex + 1} ${field.name} を削除`}
                              >
                                ×
                              </button>
                            </>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              });
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default CsvPreviewTable;
