/**
 * pdf.worker.ts の self.onmessage ハンドラ（SAVE_PDF 経路）をユニットテストする。
 *
 * 実体（座標変換・PDF 書き換え等）は pdfSaverCore.buildPdfDocumentCore が担う（不変条件 S-14）。
 * pdf.worker.ts はその薄いアダプタ殻であり、責務は:
 *   1. メッセージから originalPdfBytes を解決する（bytes 直渡し / url fetch の2経路）
 *   2. buildPdfDocumentCore を呼び、成功/失敗を Worker レスポンスに変換する
 *   3. 失敗時も必ず ERROR 応答を返す（#425「保存worker宙吊り」の回帰防止）
 *
 * このテストでは buildPdfDocumentCore をモックし、上記アダプタ挙動のみを検証する。
 * core 自体の正しさ（座標・フォント埋め込み等）は pdfSaverCore.test.ts /
 * saverWorkerEquivalence.test.ts など他のテストが担う。
 *
 * jsdom 環境では self === window === globalThis のため、worker モジュールが
 * 登録する self.onmessage は globalThis.onmessage から取得できる
 * （thumbnailWorkerClose.test.ts と同じパターン）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const buildPdfDocumentCoreMock = vi.fn();

vi.mock('../../utils/pdfSaverCore', () => ({
  buildPdfDocumentCore: (...args: unknown[]) => buildPdfDocumentCoreMock(...args),
}));

type WorkerMessage = { type: string; [key: string]: unknown };
type OnMessage = (e: MessageEvent<unknown>) => void | Promise<void>;

let originalPostMessage: unknown;
let originalOnMessage: unknown;
let originalFetch: unknown;

/** worker モジュールを新規ロードし、onmessage と post 記録を返す（既定の postMessage スタブ使用） */
async function importWorker(): Promise<{ onmessage: OnMessage; posted: WorkerMessage[] }> {
  vi.resetModules();
  const posted: WorkerMessage[] = [];
  (globalThis as Record<string, unknown>).postMessage = (msg: unknown) => {
    posted.push(msg as WorkerMessage);
  };
  await import('../../utils/pdf.worker');
  const onmessage = (globalThis as { onmessage?: OnMessage | null }).onmessage;
  if (!onmessage) throw new Error('pdf.worker did not register self.onmessage');
  return { onmessage, posted };
}

/** transfer list (postMessage 第2引数) も記録したい場合用のロード */
async function importWorkerWithTransferCapture(): Promise<{
  onmessage: OnMessage;
  calls: Array<{ msg: unknown; transfer?: Transferable[] }>;
}> {
  vi.resetModules();
  const calls: Array<{ msg: unknown; transfer?: Transferable[] }> = [];
  (globalThis as Record<string, unknown>).postMessage = (msg: unknown, transfer?: Transferable[]) => {
    calls.push({ msg, transfer });
  };
  await import('../../utils/pdf.worker');
  const onmessage = (globalThis as { onmessage?: OnMessage | null }).onmessage;
  if (!onmessage) throw new Error('pdf.worker did not register self.onmessage');
  return { onmessage, calls };
}

function send(onmessage: OnMessage, data: unknown) {
  return onmessage({ data } as MessageEvent<unknown>);
}

const baseDocumentState = { pages: {}, totalPages: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  originalPostMessage = (globalThis as Record<string, unknown>).postMessage;
  originalOnMessage = (globalThis as Record<string, unknown>).onmessage;
  originalFetch = (globalThis as Record<string, unknown>).fetch;
});

afterEach(() => {
  (globalThis as Record<string, unknown>).postMessage = originalPostMessage;
  (globalThis as Record<string, unknown>).onmessage = originalOnMessage;
  (globalThis as Record<string, unknown>).fetch = originalFetch;
});

describe('pdf.worker SAVE_PDF メッセージハンドリング', () => {
  describe('エラー経路（#425 回帰: 失敗しても必ず ERROR 応答が返り、宙吊りにならない）', () => {
    it('buildPdfDocumentCore が Error を throw した場合、ERROR メッセージが postMessage される', async () => {
      buildPdfDocumentCoreMock.mockRejectedValue(new Error('boom'));
      const { onmessage, posted } = await importWorker();

      await send(onmessage, {
        type: 'SAVE_PDF',
        data: { bytes: new Uint8Array([1, 2, 3]), documentState: baseDocumentState },
      });

      expect(posted).toHaveLength(1);
      expect(posted[0]).toEqual({ type: 'ERROR', message: 'boom' });
    });

    it('buildPdfDocumentCore が Error でない値を throw した場合も String化して ERROR 応答する', async () => {
      buildPdfDocumentCoreMock.mockRejectedValue('raw-string-failure');
      const { onmessage, posted } = await importWorker();

      await send(onmessage, {
        type: 'SAVE_PDF',
        data: { bytes: new Uint8Array([1]), documentState: baseDocumentState },
      });

      expect(posted).toHaveLength(1);
      expect(posted[0]).toEqual({ type: 'ERROR', message: 'raw-string-failure' });
    });

    it('url 経路で fetch が HTTP エラーを返した場合も ERROR 応答が返る（buildPdfDocumentCore まで到達しない）', async () => {
      (globalThis as Record<string, unknown>).fetch = vi
        .fn()
        .mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });
      const { onmessage, posted } = await importWorker();

      await send(onmessage, {
        type: 'SAVE_PDF',
        data: { url: 'http://localhost/missing.pdf', documentState: baseDocumentState },
      });

      expect(posted).toHaveLength(1);
      expect(posted[0].type).toBe('ERROR');
      expect((posted[0] as { message: string }).message).toContain('404');
      expect(buildPdfDocumentCoreMock).not.toHaveBeenCalled();
    });

    it('bytes も url も欠落したペイロードは ERROR 応答になる（例外がキャッチされ postMessage される）', async () => {
      const { onmessage, posted } = await importWorker();

      await send(onmessage, {
        type: 'SAVE_PDF',
        data: { documentState: baseDocumentState },
      });

      expect(posted).toHaveLength(1);
      expect(posted[0].type).toBe('ERROR');
      expect((posted[0] as { message: string }).message).toContain('missing both bytes and url');
      expect(buildPdfDocumentCoreMock).not.toHaveBeenCalled();
    });
  });

  describe('成功経路', () => {
    it('bytes 経路: buildPdfDocumentCore の結果が SAVE_PDF_SUCCESS として postMessage される', async () => {
      const savedBytes = new Uint8Array([9, 9, 9]);
      buildPdfDocumentCoreMock.mockResolvedValue({ savedBytes, skippedChars: [] });
      const { onmessage, posted } = await importWorker();

      await send(onmessage, {
        type: 'SAVE_PDF',
        data: { bytes: new Uint8Array([1, 2, 3]), documentState: baseDocumentState },
      });

      expect(posted).toHaveLength(1);
      expect(posted[0].type).toBe('SAVE_PDF_SUCCESS');
      expect(posted[0].data).toBe(savedBytes);
      expect(posted[0].skippedChars).toEqual([]);
    });

    it('url 経路: fetch した bytes が buildPdfDocumentCore の第1引数として渡る', async () => {
      const fetchedBuffer = new Uint8Array([5, 6, 7]).buffer;
      (globalThis as Record<string, unknown>).fetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(fetchedBuffer),
      });
      const savedBytes = new Uint8Array([4, 4, 4]);
      buildPdfDocumentCoreMock.mockResolvedValue({ savedBytes, skippedChars: [] });
      const { onmessage, posted } = await importWorker();

      await send(onmessage, {
        type: 'SAVE_PDF',
        data: { url: 'http://localhost/a.pdf', documentState: baseDocumentState },
      });

      expect(posted).toHaveLength(1);
      expect(posted[0].type).toBe('SAVE_PDF_SUCCESS');
      const passedBytes = buildPdfDocumentCoreMock.mock.calls[0][0] as Uint8Array;
      expect(Array.from(passedBytes)).toEqual([5, 6, 7]);
    });

    it('bytes と url の両方が指定された場合、bytes を優先し fetch しない', async () => {
      const savedBytes = new Uint8Array([1]);
      buildPdfDocumentCoreMock.mockResolvedValue({ savedBytes, skippedChars: [] });
      const fetchMock = vi.fn();
      (globalThis as Record<string, unknown>).fetch = fetchMock;
      const { onmessage, posted } = await importWorker();

      await send(onmessage, {
        type: 'SAVE_PDF',
        data: {
          bytes: new Uint8Array([2, 2]),
          url: 'http://localhost/unused.pdf',
          documentState: baseDocumentState,
        },
      });

      expect(posted).toHaveLength(1);
      expect(posted[0].type).toBe('SAVE_PDF_SUCCESS');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('transferables（postMessage 第2引数の transfer list）', () => {
    it('成功応答は savedBytes.buffer を transfer list に含めて postMessage する（呼び出し側ヒープへの所有権返却）', async () => {
      const savedBytes = new Uint8Array([1, 2, 3, 4]);
      buildPdfDocumentCoreMock.mockResolvedValue({ savedBytes, skippedChars: [] });
      const { onmessage, calls } = await importWorkerWithTransferCapture();

      await send(onmessage, {
        type: 'SAVE_PDF',
        data: { bytes: new Uint8Array([9]), documentState: baseDocumentState },
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].transfer).toEqual([savedBytes.buffer]);
    });

    it('ERROR 応答は transfer list なしで postMessage する（転送すべきバッファが無い）', async () => {
      buildPdfDocumentCoreMock.mockRejectedValue(new Error('fail'));
      const { onmessage, calls } = await importWorkerWithTransferCapture();

      await send(onmessage, {
        type: 'SAVE_PDF',
        data: { bytes: new Uint8Array([1]), documentState: baseDocumentState },
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].transfer).toBeUndefined();
    });
  });

  describe('不正/未知メッセージ', () => {
    it('未知の type は無視される（例外を投げず postMessage もしない）', async () => {
      const { onmessage, posted } = await importWorker();

      // SavePdfWorkerRequest の型上は 'SAVE_PDF' のみだが、実行時の防御的分岐
      // （default ケース）を検証するため意図的に型を外れたメッセージを送る。
      expect(() => send(onmessage, { type: 'UNKNOWN_TYPE' })).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(posted).toHaveLength(0);
      expect(buildPdfDocumentCoreMock).not.toHaveBeenCalled();
    });
  });
});
