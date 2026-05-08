import React, { useEffect, useState, useCallback } from 'react';
import type { Session } from '../types.js';
import { StatusBadge } from './StatusBadge.js';
import { TerminalPane } from './TerminalPane.js';
import { Play, RotateCcw, Square } from 'lucide-react';

type TerminalDef = {
  name: string;
  cwd: string;
  cmd: string | null;
  autostart: boolean;
  background: boolean;
  running?: boolean;
};

export function Terminal({ session }: { session: Session }): JSX.Element {
  const [terminals, setTerminals] = useState<TerminalDef[]>([]);
  const [active, setActive] = useState<string>('claude');
  const [mounted, setMounted] = useState<Set<string>>(new Set(['claude']));
  const [refreshKey, setRefreshKey] = useState<Record<string, number>>({});

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(session.branch)}/terminals`);
      if (!res.ok) return;
      const body = await res.json();
      setTerminals(body.terminals.filter((t: TerminalDef) => !t.background));
    } catch {
      // ignore
    }
  }, [session.branch]);

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 4000);
    const onChanged = () => void refresh();
    window.addEventListener('sequoias:terminals-changed', onChanged);
    return () => {
      clearInterval(id);
      window.removeEventListener('sequoias:terminals-changed', onChanged);
    };
  }, [refresh]);

  useEffect(() => {
    setMounted((prev) => {
      if (prev.has(active)) return prev;
      const next = new Set(prev);
      next.add(active);
      return next;
    });
  }, [active]);

  const restart = async (name: string) => {
    await fetch(
      `/api/sessions/${encodeURIComponent(session.branch)}/terminals/${encodeURIComponent(name)}/restart`,
      { method: 'POST' },
    );
    setRefreshKey((prev) => ({ ...prev, [name]: (prev[name] || 0) + 1 }));
    setMounted((prev) => {
      const next = new Set(prev);
      next.delete(name);
      next.add(name);
      return next;
    });
    await refresh();
  };

  const kill = async (name: string) => {
    await fetch(
      `/api/sessions/${encodeURIComponent(session.branch)}/terminals/${encodeURIComponent(name)}/kill`,
      { method: 'POST' },
    );
    await refresh();
  };

  return (
    <>
      <header className="main-header">
        <span className="branch-name">{session.branch}</span>
        <StatusBadge status={session.lastStatus} />
        <span className="ports" style={{ marginLeft: 'auto' }}>
          {Object.entries(session.ports).map(([k, v]) => `${k}:${v}`).join('  ')}
        </span>
      </header>
      <div className="terminal-tabs" data-testid="terminal-tabs">
        {terminals.map((t) => (
          <div
            key={t.name}
            className={`terminal-tab ${active === t.name ? 'active' : ''}`}
            onClick={() => setActive(t.name)}
            data-testid={`tab-${t.name}`}
          >
            <span className={`tab-dot ${t.running ? 'running' : 'stopped'}`} />
            <span className="tab-name">{t.name}</span>
            {t.running ? (
              <>
                <button
                  className="tab-icon-btn"
                  title={`Restart ${t.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    void restart(t.name);
                  }}
                  data-testid={`tab-restart-${t.name}`}
                >
                  <RotateCcw size={11} />
                </button>
                <button
                  className="tab-icon-btn"
                  title={`Stop ${t.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    void kill(t.name);
                  }}
                  data-testid={`tab-kill-${t.name}`}
                >
                  <Square size={11} />
                </button>
              </>
            ) : (
              <button
                className="tab-icon-btn tab-start-btn"
                title={`Start ${t.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  void restart(t.name);
                }}
                data-testid={`tab-start-${t.name}`}
              >
                <Play size={11} />
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="terminal-host" data-testid="terminal-host">
        {Array.from(mounted).map((name) => (
          <TerminalPane
            key={`${name}::${refreshKey[name] || 0}`}
            branch={session.branch}
            terminalName={name}
            active={active === name}
          />
        ))}
      </div>
    </>
  );
}
