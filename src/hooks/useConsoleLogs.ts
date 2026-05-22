import { useState, useEffect, useCallback } from 'react';
import { isTauriWindowNotFoundError } from '../utils/tauriWindowErrors';

export type ConsoleLogEntry = { level: 'error' | 'warn' | 'log'; message: string; time: string };

const MAX_LOG_LENGTH = 5000;
const MAX_LOG_ENTRIES = 300;
const TRUNCATED_SUFFIX = '... [truncated]';

type Subscriber = (entry: ConsoleLogEntry) => void;

const subscribers = new Set<Subscriber>();
let windowListenersAttached = false;
let onWindowError: ((e: ErrorEvent) => void) | null = null;
let onUnhandledRejection: ((e: PromiseRejectionEvent) => void) | null = null;

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
  if (subscribers.size === 0) return;
  const entry: ConsoleLogEntry = {
    level,
    message: formatMessage(args),
    time: new Date().toLocaleTimeString('ja-JP'),
  };
  subscribers.forEach(sub => {
    try { sub(entry); } catch { /* ignore subscriber errors */ }
  });
}

function attachWindowListeners(): void {
  if (windowListenersAttached || typeof window === 'undefined') return;
  onWindowError = (e: ErrorEvent) => {
    if (isTauriWindowNotFoundError(e.error) || isTauriWindowNotFoundError(e.message)) return;
    emit('error', [`[UncaughtError] ${e.message}`, e.error].filter(Boolean));
  };
  onUnhandledRejection = (e: PromiseRejectionEvent) => {
    if (isTauriWindowNotFoundError(e.reason)) return;
    emit('error', [`[UnhandledRejection]`, e.reason].filter(Boolean));
  };
  window.addEventListener('error', onWindowError);
  window.addEventListener('unhandledrejection', onUnhandledRejection);
  windowListenersAttached = true;
}

function detachWindowListeners(): void {
  if (!windowListenersAttached || typeof window === 'undefined') return;
  if (onWindowError) window.removeEventListener('error', onWindowError);
  if (onUnhandledRejection) window.removeEventListener('unhandledrejection', onUnhandledRejection);
  onWindowError = null;
  onUnhandledRejection = null;
  windowListenersAttached = false;
}

function subscribe(sub: Subscriber): () => void {
  subscribers.add(sub);
  attachWindowListeners();
  return () => {
    subscribers.delete(sub);
    if (subscribers.size === 0) detachWindowListeners();
  };
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
}

patchConsoleOnce();

export function useConsoleLogs() {
  const [logs, setLogs] = useState<ConsoleLogEntry[]>([]);
  const [showConsole, setShowConsole] = useState(false);

  useEffect(() => {
    let active = true;
    let flushScheduled = false;
    let pending: ConsoleLogEntry[] = [];

    const flush = () => {
      flushScheduled = false;
      if (!active || pending.length === 0) return;
      const batch = pending;
      pending = [];
      setLogs(prev => {
        const next = [...prev, ...batch];
        return next.length > MAX_LOG_ENTRIES ? next.slice(-MAX_LOG_ENTRIES) : next;
      });
    };

    const sub: Subscriber = (entry) => {
      pending.push(entry);
      if (flushScheduled) return;
      flushScheduled = true;
      queueMicrotask(flush);
    };
    const unsubscribe = subscribe(sub);
    return () => {
      active = false;
      pending = [];
      unsubscribe();
    };
  }, []);

  const clearLogs = useCallback(() => setLogs([]), []);

  return { logs, showConsole, setShowConsole, clearLogs };
}
