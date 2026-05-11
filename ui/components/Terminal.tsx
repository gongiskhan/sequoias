import React, { useEffect, useState, useCallback } from 'react';
import type { Session } from '../types.js';
import { StatusBadge } from './StatusBadge.js';
import { TerminalPane } from './TerminalPane.js';
import { Play, RotateCcw, Square, Eye, ExternalLink, Plus } from 'lucide-react';

type TerminalDef = {
  name: string;
  cwd: string;
  cmd: string | null;
  autostart: boolean;
  background: boolean;
  kind?: 'pty' | 'jsonl';
  readOnly?: boolean;
  running?: boolean;
};

type Props = {
  session: Session;
  projectId?: string;
};

export function Terminal({ session, projectId }: Props): JSX.Element {
  const [terminals, setTerminals] = useState<TerminalDef[]>([]);
  const [active, setActive] = useState<string>('claude');
  const [mounted, setMounted] = useState<Set<string>>(new Set(['claude']));
  const [refreshKey, setRefreshKey] = useState<Record<string, number>>({});

  const baseUrl = projectId
    ? `/api/projects/${projectId}/sessions/${encodeURIComponent(session.branch)}`
    : `/api/sessions/${encodeURIComponent(session.branch)}`;

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/terminals`);
      if (!res.ok) return;
      const body = await res.json();
      setTerminals(body.terminals.filter((t: TerminalDef) => !t.background));
    } catch {
      // ignore
    }
  }, [baseUrl]);

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 4000);
    const onChanged = () => void refresh();
    const onRemount = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { branch?: string; name?: string }
        | undefined;
      if (!detail || !detail.name) return;
      if (detail.branch && detail.branch !== session.branch) return;
      const name = detail.name;
      setActive(name);
      setRefreshKey((prev) => ({ ...prev, [name]: (prev[name] || 0) + 1 }));
      setMounted((prev) => {
        const next = new Set(prev);
        next.delete(name);
        next.add(name);
        return next;
      });
    };
    window.addEventListener('sequoias:terminals-changed', onChanged);
    window.addEventListener('sequoias:remount-terminal', onRemount as EventListener);
    return () => {
      clearInterval(id);
      window.removeEventListener('sequoias:terminals-changed', onChanged);
      window.removeEventListener('sequoias:remount-terminal', onRemount as EventListener);
    };
  }, [refresh, session.branch]);

  useEffect(() => {
    setMounted((prev) => {
      if (prev.has(active)) return prev;
      const next = new Set(prev);
      next.add(active);
      return next;
    });
  }, [active]);

  useEffect(() => {
    if (terminals.length === 0) return;
    if (terminals.some((t) => t.name === active)) return;
    setActive(terminals[0].name);
  }, [terminals, active]);

  const restart = async (name: string) => {
    await fetch(`${baseUrl}/terminals/${encodeURIComponent(name)}/restart`, {
      method: 'POST',
    });
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
    await fetch(`${baseUrl}/terminals/${encodeURIComponent(name)}/kill`, {
      method: 'POST',
    });
    await refresh();
  };

  const addAdhoc = async () => {
    const res = await fetch(`${baseUrl}/terminals/adhoc`, { method: 'POST' });
    if (!res.ok) return;
    const body = await res.json().catch(() => ({}));
    if (body?.name) {
      setActive(body.name);
      setMounted((prev) => {
        const next = new Set(prev);
        next.add(body.name);
        return next;
      });
    }
    await refresh();
  };

  return (
    <>
      <header className="main-header">
        <span className="branch-name">{session.branch}</span>
        <StatusBadge status={session.lastStatus} />
        <div className="ports" style={{ marginLeft: 'auto' }}>
          {Object.entries(session.ports).map(([k, v]) => (
            <a
              key={k}
              className="port-chip"
              href={`http://${window.location.hostname}:${v}`}
              target="_blank"
              rel="noreferrer"
              title={`Open ${k} (port ${v}) in a new tab`}
            >
              <span className="port-chip-key">{k}</span>
              <span className="port-chip-sep">:</span>
              <span className="port-chip-value">{v}</span>
              <ExternalLink size={11} className="port-chip-icon" />
            </a>
          ))}
        </div>
      </header>
      <div className="terminal-tabs" data-testid="terminal-tabs">
        {terminals.map((t) => {
          const isJsonl = t.kind === 'jsonl';
          return (
            <div
              key={t.name}
              className={`terminal-tab ${active === t.name ? 'active' : ''}`}
              onClick={() => setActive(t.name)}
              data-testid={`tab-${t.name}`}
            >
              {isJsonl ? (
                <Eye size={11} className="tab-eye" />
              ) : (
                <span className={`tab-dot ${t.running ? 'running' : 'stopped'}`} />
              )}
              <span className="tab-name">{t.name}</span>
              {!isJsonl && t.running && (
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
              )}
              {!isJsonl && !t.running && (
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
          );
        })}
        <button
          className="terminal-tab terminal-tab-add"
          title="Open another shell in this worktree"
          onClick={() => void addAdhoc()}
          data-testid="tab-add"
          aria-label="Add terminal"
        >
          <Plus size={13} />
        </button>
      </div>
      <div className="terminal-host" data-testid="terminal-host">
        {Array.from(mounted).map((name) => {
          const def = terminals.find((t) => t.name === name);
          return (
            <TerminalPane
              key={`${name}::${refreshKey[name] || 0}`}
              branch={session.branch}
              terminalName={name}
              projectId={projectId}
              active={active === name}
              readOnly={def?.readOnly}
            />
          );
        })}
      </div>
    </>
  );
}
