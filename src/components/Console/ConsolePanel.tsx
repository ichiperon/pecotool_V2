import React, { useMemo, useState } from 'react';

interface LogEntry {
  level: 'error' | 'warn' | 'log';
  message: string;
  time: string;
}

interface ConsolePanelProps {
  logs: LogEntry[];
  onClear: () => void;
  onClose: () => void;
  endRef: React.RefObject<HTMLDivElement | null>;
}

type LevelFilter = Record<LogEntry['level'], boolean>;

const DEFAULT_FILTERS: LevelFilter = { error: true, warn: true, log: true };

export const ConsolePanel: React.FC<ConsolePanelProps> = ({ logs, onClear, onClose, endRef }) => {
  const [filters, setFilters] = useState<LevelFilter>(DEFAULT_FILTERS);
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'fail'>('idle');

  const visibleLogs = useMemo(
    () => logs.filter((log) => filters[log.level]),
    [logs, filters],
  );

  const toggleFilter = (level: LogEntry['level']) => {
    setFilters((prev) => ({ ...prev, [level]: !prev[level] }));
  };

  const handleCopyAll = async () => {
    const text = logs
      .map((log) => `[${log.time}] ${log.level.toUpperCase()} ${log.message}`)
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopyState('ok');
    } catch {
      setCopyState('fail');
    }
    window.setTimeout(() => setCopyState('idle'), 1500);
  };

  return (
    <div className="console-panel">
      <div className="console-panel-header">
        <span className="console-panel-title">コンソール</span>
        <div className="console-panel-filters" role="group" aria-label="ログレベルフィルタ">
          {(['error', 'warn', 'log'] as const).map((level) => (
            <label key={level} className={`console-panel-filter ${level}`}>
              <input
                type="checkbox"
                checked={filters[level]}
                onChange={() => toggleFilter(level)}
                aria-label={`${level} を表示`}
              />
              <span>{level.toUpperCase()}</span>
            </label>
          ))}
        </div>
        <div className="console-panel-actions">
          <button
            className="console-panel-btn"
            onClick={handleCopyAll}
            disabled={logs.length === 0}
            aria-label="全ログコピー"
          >
            {copyState === 'ok' ? 'コピー済' : copyState === 'fail' ? 'コピー失敗' : '全ログコピー'}
          </button>
          <button className="console-panel-btn" onClick={onClear}>クリア</button>
          <button className="console-panel-btn" onClick={onClose} aria-label="閉じる">✕</button>
        </div>
      </div>
      <div className="console-log-list">
        {visibleLogs.length === 0
          ? <div style={{ padding: '8px 10px', color: '#6a9955', fontSize: 11 }}>ログなし</div>
          : visibleLogs.map((log, i) => (
            <div key={i} className={`console-log-entry ${log.level}`}>
              <span className="console-log-time">{log.time}</span>
              <span className="console-log-level">{log.level.toUpperCase()}</span>
              <span className="console-log-message">{log.message}</span>
            </div>
          ))
        }
        <div ref={endRef} />
      </div>
    </div>
  );
};
