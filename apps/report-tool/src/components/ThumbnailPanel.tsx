import { useEffect, useRef, useState, type FC } from "react";
import { usePdfStore } from "../store/pdfStore";
import { renderPageOffscreen } from "../lib/ocrCrop";

/** サムネイル描画スケール（0.25 = 25%縮小）。MVP は全件描画。大量ページ(100+)では lazy 化を検討する。 */
const THUMBNAIL_RENDER_SCALE = 0.25;

interface ThumbnailItem {
  pageNumber: number;
  dataUrl: string;
}

const ThumbnailPanel: FC = () => {
  const filePath = usePdfStore((s) => s.filePath);
  const numPages = usePdfStore((s) => s.numPages);
  const currentPage = usePdfStore((s) => s.currentPage);
  const setCurrentPage = usePdfStore((s) => s.setCurrentPage);

  const [thumbnails, setThumbnails] = useState<ThumbnailItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // pdfDoc の破棄をマウント解除・filePath 変更時に行うための ref
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfDocRef = useRef<any>(null);
  // レンダリング中断フラグ（filePath 変更時に古いレンダリングを止める）
  const abortRef = useRef(false);

  useEffect(() => {
    if (!filePath || numPages === 0) {
      setThumbnails([]);
      return;
    }

    let cancelled = false;
    abortRef.current = false;

    const load = async () => {
      setIsLoading(true);
      setThumbnails([]);

      try {
        const [pdfjsLib, { readFile }] = await Promise.all([
          import("pdfjs-dist"),
          import("@tauri-apps/plugin-fs"),
        ]);

        if (cancelled) return;

        const bytes = await readFile(filePath);
        if (cancelled) return;

        const pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
        if (cancelled) {
          pdfDoc.destroy().catch(() => {});
          return;
        }

        // 古いドキュメントを破棄
        if (pdfDocRef.current) {
          pdfDocRef.current.destroy().catch(() => {});
        }
        pdfDocRef.current = pdfDoc;

        const items: ThumbnailItem[] = [];

        for (let i = 1; i <= numPages; i++) {
          if (cancelled || abortRef.current) break;

          let canvas: HTMLCanvasElement | null = null;
          try {
            const { canvas: c } = await renderPageOffscreen(
              pdfDoc,
              i,
              THUMBNAIL_RENDER_SCALE
            );
            canvas = c;

            if (cancelled || abortRef.current) {
              canvas.width = 0;
              canvas.height = 0;
              break;
            }

            const dataUrl = canvas.toDataURL("image/jpeg", 0.75);
            items.push({ pageNumber: i, dataUrl });
            // 描画が完了したページから順次表示
            setThumbnails((prev) => [...prev, { pageNumber: i, dataUrl }]);
          } catch {
            // ページレンダリング失敗は無視して次ページへ
          } finally {
            if (canvas) {
              canvas.width = 0;
              canvas.height = 0;
            }
          }

          // UI スレッドを解放
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      } catch {
        // PDF 読み込み失敗（Tauri 外環境等）は空のまま
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
      abortRef.current = true;
    };
  }, [filePath, numPages]);

  // コンポーネント解除時に pdfDoc を破棄
  useEffect(() => {
    return () => {
      abortRef.current = true;
      if (pdfDocRef.current) {
        pdfDocRef.current.destroy().catch(() => {});
        pdfDocRef.current = null;
      }
    };
  }, []);

  if (!filePath) {
    return (
      <div className="thumbnail-panel thumbnail-panel--empty">
        <p className="thumbnail-panel__empty-label">PDF 未読込</p>
        <p className="thumbnail-panel__empty-sub">
          PDF を開くと
          <br />
          サムネイルが表示されます
        </p>
      </div>
    );
  }

  if (isLoading && thumbnails.length === 0) {
    return (
      <div className="thumbnail-panel thumbnail-panel--loading" aria-busy="true" aria-label="サムネイル読込中">
        <p className="thumbnail-panel__loading-label">読込中...</p>
      </div>
    );
  }

  return (
    <div className="thumbnail-panel" aria-label={`全 ${numPages} ページ`}>
      <ol className="thumbnail-panel__list">
        {thumbnails.map(({ pageNumber, dataUrl }) => (
          <li key={pageNumber} className="thumbnail-panel__item">
            <button
              type="button"
              className={`thumbnail-panel__btn${currentPage === pageNumber ? " thumbnail-panel__btn--active" : ""}`}
              onClick={() => setCurrentPage(pageNumber)}
              aria-current={currentPage === pageNumber ? "true" : undefined}
              aria-label={`${pageNumber} ページ目`}
            >
              <img
                src={dataUrl}
                alt={`${pageNumber} ページ目のサムネイル`}
                className="thumbnail-panel__img"
              />
              <span className="thumbnail-panel__page-num" aria-hidden="true">
                {pageNumber}
              </span>
            </button>
          </li>
        ))}
        {isLoading && thumbnails.length > 0 && (
          <li className="thumbnail-panel__loading-more" aria-live="polite">
            読込中...
          </li>
        )}
      </ol>
    </div>
  );
};

export default ThumbnailPanel;
