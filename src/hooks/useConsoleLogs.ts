import { useState, useEffect, useCallback } from 'react';
import { isTauriWindowNotFoundError } from '../utils/tauriWindowErrors';

export function useConsoleLogs() {
  const [logs, setLogs] = useState<Array<{ level: 'error' | 'warn' | 'log'; message: string; time: string }>>([]);
  const [showConsole, setShowConsole] = useState(false);

  useEffect(() => {
    const addLog = (level: 'error' | 'warn' | 'log', args: unknown[]) => {
      if (args.some(isTauriWindowNotFoundError)) return;
      const message = args.map(a => {
        if (a instanceof Error) return `${a.message}${a.stack ? '\n' + a.stack : ''}`;
        if (typeof a === 'object' && a !== null) { try { return JSON.stringify(a); } catch { return String(a); } }
        return String(a);
      }).join(' ');
      const time = new Date().toLocaleTimeString('ja-JP');
      setLogs(prev => [...prev.slice(-299), { level, message, time }]);
    };

    const origError = console.error.bind(console);
    const origWarn = console.warn.bind(console);
    const origLog = console.log.bind(console);

    console.error = (...args: unknown[]) => { origError(...args); addLog('error', args); };
    console.warn = (...args: unknown[]) => { origWarn(...args); addLog('warn', args); };
    console.log = (...args: unknown[]) => { origLog(...args); addLog('log', args); };

    const handleError = (e: ErrorEvent) => {
      if (isTauriWindowNotFoundError(e.error) || isTauriWindowNotFoundError(e.message)) return;
      addLog('error', [`[UncaughtError] ${e.message}`, e.error].filter(Boolean));
    };
    const handleRejection = (e: PromiseRejectionEvent) => {
      if (isTauriWindowNotFoundError(e.reason)) return;
      addLog('error', [`[UnhandledRejection]`, e.reason].filter(Boolean));
    };

    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleRejection);

    return () => {
      console.error = origError;
      console.warn = origWarn;
      console.log = origLog;
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleRejection);
    };
  }, []);

  const clearLogs = useCallback(() => setLogs([]), []);

  return { logs, showConsole, setShowConsole, clearLogs };
}
