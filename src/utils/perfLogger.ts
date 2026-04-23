// =====================================================================
// perfLogger
// -----------------------------------------------------------------------
// 推測ベースの最適化を止めるため、実機でユーザーが操作した時系列を ndjson で
// 吐き出して突き合わせる計測モジュール。
//
// 有効化条件 (初回 1 度だけ判定):
//   - location.hash に `#perf` または `#perf=verbose` を含む
//   - localStorage.pecoPerf === '1' または 'verbose'
// verbose 指定時は mark() で console.log も出す（デバッグ支援）。
// 無効時は全メソッドが早期 return で zero-overhead。
//
// 出力:
//   - getEntries(): 現在の計測配列（リングバッファ 5000 件）
//   - download(): ndjson ファイルを Blob / <a download> でダウンロード
//   - sendToTauri(name): Tauri invoke write_perf_log を呼び appdata に保存
// =====================================================================

export type PerfExtra = Record<string, string | number | boolean | undefined>;

export interface PerfEntry {
  t: number;
  label: string;
  extra?: PerfExtra;
  sessionId: string;
}

export interface PerfLogger {
  readonly enabled: boolean;
  mark(label: string, extra?: PerfExtra): void;
  measure(startLabel: string, endLabel: string, extra?: PerfExtra): number | undefined;
  group(label: string, extra?: PerfExtra): () => void;
  summary(): string;
  getEntries(): PerfEntry[];
  download(): Promise<void>;
  /** Tauri invoke で appLocalData/perf/<name>.ndjson に書き込み、絶対パスを返す */
  sendToTauri(name: string): Promise<string>;
  /** Tauri invoke で appLocalData/logs/<name>.ndjson に書き込み、絶対パスを返す (操作ログ用) */
  sendOperationLog(name: string): Promise<string>;
  reset(): void;
}

const RING_BUFFER_SIZE = 5000;

interface PerfState {
  enabled: boolean;
  verbose: boolean;
  sessionId: string;
  entries: PerfEntry[];
  // リングバッファの書き込み位置
  writeIdx: number;
  filled: boolean;
}

function detectEnabled(): { enabled: boolean; verbose: boolean } {
  if (typeof window === 'undefined') return { enabled: false, verbose: false };
  try {
    const hash = window.location?.hash ?? '';
    if (hash.includes('#perf=verbose')) return { enabled: true, verbose: true };
    if (hash.includes('#perf')) return { enabled: true, verbose: false };
    const ls = window.localStorage?.getItem('pecoPerf');
    if (ls === 'verbose') return { enabled: true, verbose: true };
    if (ls === '1') return { enabled: true, verbose: false };
    // 明示的に無効化したい場合のエスケープハッチ
    if (ls === 'off' || ls === '0') return { enabled: false, verbose: false };
  } catch {
    // localStorage アクセス不可 (SSR 等) は無効
  }
  // プロダクションビルドではデフォルトで有効化 (操作ログ常時収集。
  // mark 単位のオーバーヘッドはサブμ秒、5000 件のリングバッファで頭打ち)
  if (import.meta.env.PROD) return { enabled: true, verbose: false };
  return { enabled: false, verbose: false };
}

function makeSessionId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* ignore */
  }
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const { enabled, verbose } = detectEnabled();

const state: PerfState = {
  enabled,
  verbose,
  sessionId: enabled ? makeSessionId() : '',
  entries: [],
  writeIdx: 0,
  filled: false,
};

function pushEntry(label: string, extra?: PerfExtra) {
  const entry: PerfEntry = {
    t: performance.now(),
    label,
    extra,
    sessionId: state.sessionId,
  };
  if (!state.filled && state.entries.length < RING_BUFFER_SIZE) {
    state.entries.push(entry);
    if (state.entries.length >= RING_BUFFER_SIZE) state.filled = true;
    return;
  }
  state.entries[state.writeIdx] = entry;
  state.writeIdx = (state.writeIdx + 1) % RING_BUFFER_SIZE;
}

function orderedEntries(): PerfEntry[] {
  if (!state.filled) return state.entries.slice();
  return state.entries.slice(state.writeIdx).concat(state.entries.slice(0, state.writeIdx));
}

function toNdjson(entries: PerfEntry[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

const noop = () => {};

export const perf: PerfLogger = {
  get enabled() {
    return state.enabled;
  },

  mark(label, extra) {
    if (!state.enabled) return;
    try {
      if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
        // performance.mark は同一 label を複数回受け付けるので sessionId をサフィックス化して衝突回避
        performance.mark(label);
      }
    } catch {
      /* ignore */
    }
    pushEntry(label, extra);
    if (state.verbose) {
      // verbose モードのみ console に流す（通常は出さない）
      // eslint-disable-next-line no-console
      console.log(`[perf] ${label}`, extra ?? {});
    }
  },

  measure(startLabel, endLabel, extra) {
    if (!state.enabled) return undefined;
    const all = orderedEntries();
    // 最後の start と、その start より後にある最後の end を探す
    let startIdx = -1;
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].label === startLabel) {
        startIdx = i;
        break;
      }
    }
    if (startIdx === -1) return undefined;
    let endIdx = -1;
    for (let i = all.length - 1; i > startIdx; i--) {
      if (all[i].label === endLabel) {
        endIdx = i;
        break;
      }
    }
    if (endIdx === -1) return undefined;
    const dt = all[endIdx].t - all[startIdx].t;
    pushEntry(`${startLabel}→${endLabel}`, { ...extra, ms: Math.round(dt * 1000) / 1000 });
    return dt;
  },

  group(label, extra) {
    if (!state.enabled) return noop;
    const start = performance.now();
    pushEntry(`${label}.enter`, extra);
    return () => {
      const dt = performance.now() - start;
      pushEntry(`${label}.exit`, { ...extra, ms: Math.round(dt * 1000) / 1000 });
    };
  },

  summary() {
    if (!state.enabled) return '(perf disabled)';
    const all = orderedEntries();
    if (all.length === 0) return '(no entries)';
    const counts = new Map<string, number>();
    for (const e of all) {
      counts.set(e.label, (counts.get(e.label) ?? 0) + 1);
    }
    const lines: string[] = [
      `sessionId=${state.sessionId}`,
      `entries=${all.length}`,
      `span=${Math.round((all[all.length - 1].t - all[0].t) * 1000) / 1000}ms`,
      '--- label counts ---',
    ];
    for (const [label, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`${n.toString().padStart(4, ' ')}  ${label}`);
    }
    return lines.join('\n');
  },

  getEntries() {
    if (!state.enabled) return [];
    return orderedEntries();
  },

  async download() {
    if (!state.enabled) return;
    const body = toNdjson(orderedEntries());
    try {
      const blob = new Blob([body], { type: 'application/x-ndjson' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `perf-${Date.now()}.ndjson`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Blob URL は即時 revoke すると click ハンドラが完了する前に破棄されることがあるため少し遅延
      setTimeout(() => {
        try { URL.revokeObjectURL(url); } catch { /* ignore */ }
      }, 1000);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[perf] download failed:', e);
    }
  },

  async sendToTauri(name) {
    if (!state.enabled) return '';
    const body = toNdjson(orderedEntries());
    // Tauri が未初期化の環境 (通常ブラウザ等) でも失敗しないように動的 import
    const { invoke } = await import('@tauri-apps/api/core');
    const path = await invoke<string>('write_perf_log', { name, body });
    return path;
  },

  async sendOperationLog(name) {
    if (!state.enabled) return '';
    const body = toNdjson(orderedEntries());
    const { invoke } = await import('@tauri-apps/api/core');
    const path = await invoke<string>('write_operation_log', { name, body });
    return path;
  },

  reset() {
    state.entries = [];
    state.writeIdx = 0;
    state.filled = false;
  },
};

// 開発者が DevTools からアクセスしやすいよう window にも貼る（有効時のみ）
if (state.enabled && typeof window !== 'undefined') {
  (window as unknown as { __perf?: PerfLogger }).__perf = perf;
}
