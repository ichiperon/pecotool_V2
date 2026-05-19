import { useState, useEffect, useCallback } from 'react';
import { isTauriWindowNotFoundError } from '../utils/tauriWindowErrors';

export type ConsoleLogEntry = { level: 'error' | 'warn' | 'log'; message: string; time: string };

const MAX_LOG_LENGTH = 5000;
const MAX_LOG_ENTRIES = 300;
const TRUNCATED_SUFFIX = '... [truncated]';

type Subscriber = (entry: ConsoleLogEntry) => void;

const subscribers = new Set<Subscriber>();

function formatMessage(args: unknown[]): string {
  const message = args.map(a => {
    if (a instanceof Error) return `${a.message}${a.stack ? '\n' + a.stack : ''}`;
    if (typeof a === 'object' && a !== null) { try { return JSON.stringify(a); } catch { return String(a); } }
    return String(a);
  }).join(' ');
  if (message.length > MAX_LOG_LENGTH) {
    return message.slice(0, MAX_LOG_LENGTH - TRUNCATED_SUFFIX.length) + TRUNCATED_SUFFIX;
  }
  return message;
}

function emit(level: 'error' | 'warn' | 'log', args: unknown[]): void {
  if (args.some(isTauriWindowNotFoundError)) return;
  const entry: ConsoleLogEntry = {
    level,
    message: formatMessage(args),
    time: new Date().toLocaleTimeString('ja-JP'),
  };
  subscribers.forEach(sub => {
    try { sub(entry); } catch { /* ignore subscriber errors */ }
  });
}

// Module-level singleton: console を一度だけ上書きする。
// HMR で再評価されても globalThis のフラグで二重置換を防ぐ。
const PATCH_FLAG = '__pecotoolConsolePatched__';
type PatchedGlobal = typeof globalThis & { [PATCH_FLAG]?: boolean };

function patchConsoleOnce(): void {
  const g = globalThis as PatchedGlobal;
  if (g[PATCH_FLAG]) return;
  g[PATCH_FLAG] = true;

  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  const origLog = console.log.bind(console);

  console.error = (...args: unknown[]) => { origError(...args); emit('error', args); };
  console.warn = (...args: unknown[]) => { origWarn(...args); emit('warn', args); };
  console.log = (...args: unknown[]) => { origLog(...args); emit('log', args); };

  if (typeof window !== 'undefined') {
    window.addEventListener('error', (e: ErrorEvent) => {
      if (isTauriWindowNotFoundError(e.error) || isTauriWindowNotFoundError(e.message)) return;
      emit('error', [`[UncaughtError] ${e.message}`, e.error].filter(Boolean));
    });
    window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
      if (isTauriWindowNotFoundError(e.reason)) return;
      emit('error', [`[UnhandledRejection]`, e.reason].filter(Boolean));
    });
  }
}

patchConsoleOnce();

export function useConsoleLogs() {
  const [logs, setLogs] = useState<ConsoleLogEntry[]>([]);
  const [showConsole, setShowConsole] = useState(false);

  useEffect(() => {
    const sub: Subscriber = (entry) => {
      setLogs(prev => {
        const next = prev.length >= MAX_LOG_ENTRIES ? prev.slice(-(MAX_LOG_ENTRIES - 1)) : prev;
        return [...next, entry];
      });
    };
    subscribers.add(sub);
    return () => { subscribers.delete(sub); };
  }, []);

  const clearLogs = useCallback(() => setLogs([]), []);

  return { logs, showConsole, setShowConsole, clearLogs };
}
