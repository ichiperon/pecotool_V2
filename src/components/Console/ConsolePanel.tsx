import React from 'react';
import { Terminal } from 'lucide-react';

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

export const ConsolePanel: React.FC<ConsolePanelProps> = ({ logs, onClear, onClose, endRef }) => {
  return (
    <div className="console-panel">
      <div className="console-panel-header">
        <span className="console-panel-title">コンソール</span>
        <div className="console-panel-actions">
          <button className="console-panel-btn" onClick={onClear}>クリア</button>
          <button className="console-panel-btn" onClick={onClose}>✕</button>
        </div>
      </div>
      <div className="console-log-list">
        {logs.length === 0
          ? <div style={{ padding: '8px 10px', color: '#6a9955', fontSize: 11 }}>ログなし</div>
          : logs.map((log, i) => (
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
