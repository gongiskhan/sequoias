import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { SessionList } from './SessionList.js';
import { NewSessionDialog } from './NewSessionDialog.js';
import { SettingsDialog } from './SettingsDialog.js';
import { Terminal } from './Terminal.js';
import type { Project, Session, State } from '../types.js';
import { Plus, Settings } from 'lucide-react';

type Toast = { id: number; kind: 'error' | 'success' | 'info'; text: string };

export function App(): JSX.Element {
  const [state, setState] = useState<State | null>(null);
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [activeBranch, setActiveBranch] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const pushToast = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, kind, text }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5000);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/state')
      .then((r) => r.json())
      .then((data: State) => {
        if (cancelled) return;
        setState(data);
        const firstProject = Object.keys(data.projects)[0];
        if (firstProject) setProjectPath(firstProject);
      });

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/ws/events`);
    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'state') {
          setState(msg.data);
        } else if (msg.type === 'session-upsert') {
          setState((prev) => {
            if (!prev) return prev;
            const next = structuredClone(prev);
            const project = next.projects[msg.projectPath];
            if (project) project.sessions[msg.session.branch] = msg.session;
            return next;
          });
        } else if (msg.type === 'config-changed' || msg.type === 'terminal-spawn' || msg.type === 'terminal-exit') {
          window.dispatchEvent(new CustomEvent('sequoias:terminals-changed'));
        } else if (msg.type === 'session-remove') {
          setState((prev) => {
            if (!prev) return prev;
            const next = structuredClone(prev);
            const project = next.projects[msg.projectPath];
            if (project) delete project.sessions[msg.branch];
            return next;
          });
        }
      } catch {
        // ignore
      }
    };

    return () => {
      cancelled = true;
      ws.close();
    };
  }, []);

  const project: Project | undefined = useMemo(() => {
    if (!state || !projectPath) return undefined;
    return state.projects[projectPath];
  }, [state, projectPath]);

  const activeSession: Session | undefined = useMemo(() => {
    if (!project || !activeBranch) return undefined;
    return project.sessions[activeBranch];
  }, [project, activeBranch]);

  const handleCreateSession = useCallback(
    async (branch: string, baseBranch?: string) => {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch, baseBranch }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `request failed: ${res.status}`);
      }
      const body = await res.json();
      setActiveBranch(body.session.branch);
    },
    [],
  );

  const handleArchive = useCallback(
    async (branch: string, deleteBranch: boolean) => {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(branch)}?deleteBranch=${deleteBranch}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        pushToast('error', body.error || `archive failed: ${res.status}`);
        return;
      }
      if (activeBranch === branch) setActiveBranch(null);
    },
    [activeBranch, pushToast],
  );

  const handleCreatePr = useCallback(
    async (branch: string) => {
      const res = await fetch(`/api/sessions/${encodeURIComponent(branch)}/pr`, {
        method: 'POST',
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) {
        pushToast('error', body.error || 'PR creation failed');
        return;
      }
      pushToast('success', `PR created: ${body.url}`);
    },
    [pushToast],
  );

  const handleResyncEnv = useCallback(
    async (branch: string) => {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(branch)}/resync-env`,
        { method: 'POST' },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        pushToast('error', body.error || 'env sync failed');
        return;
      }
      const copied = (body.copiedFiles as string[]) || [];
      pushToast(
        'success',
        copied.length > 0
          ? `synced env files: ${copied.join(', ')}`
          : 'env files already in sync',
      );
    },
    [pushToast],
  );

  const handleLaunchIde = useCallback(
    async (branch: string) => {
      const res = await fetch(`/api/sessions/${encodeURIComponent(branch)}/ide`, {
        method: 'POST',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        pushToast('error', body.error || 'IDE launch failed');
      }
    },
    [pushToast],
  );

  return (
    <div className="app">
      <aside className="rail">
        <header className="rail-header">
          <div className="rail-title">Project</div>
          <div className="rail-project">
            <span data-testid="project-name">{project?.name || '—'}</span>
          </div>
          <div className="rail-project-path" data-testid="project-path">
            {project?.path}
          </div>
          <div className="rail-actions">
            <button
              className="new-session-btn"
              onClick={() => setDialogOpen(true)}
              data-testid="new-session-btn"
            >
              <Plus size={14} /> New session
            </button>
            <button
              className="icon-btn rail-settings-btn"
              onClick={() => setSettingsOpen(true)}
              title="Project settings"
              data-testid="settings-btn"
            >
              <Settings size={14} />
            </button>
          </div>
        </header>
        <SessionList
          project={project}
          activeBranch={activeBranch}
          onSelect={setActiveBranch}
          onArchive={handleArchive}
          onCreatePr={handleCreatePr}
          onLaunchIde={handleLaunchIde}
          onResyncEnv={handleResyncEnv}
        />
      </aside>
      <main className="main">
        {activeSession ? (
          <Terminal session={activeSession} />
        ) : (
          <div className="main-empty">Select a session to view its terminal</div>
        )}
      </main>
      {dialogOpen && (
        <NewSessionDialog
          onClose={() => setDialogOpen(false)}
          onCreate={async (branch, base) => {
            await handleCreateSession(branch, base);
            setDialogOpen(false);
          }}
        />
      )}
      {settingsOpen && (
        <SettingsDialog onClose={() => setSettingsOpen(false)} />
      )}
      <div className="toast-host">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
