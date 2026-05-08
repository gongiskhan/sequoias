import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { ProjectTree } from './ProjectTree.js';
import { NewSessionDialog } from './NewSessionDialog.js';
import { SettingsDialog } from './SettingsDialog.js';
import { GlobalSettingsDialog } from './GlobalSettingsDialog.js';
import { ThemeToggle } from './ThemeToggle.js';
import { Terminal } from './Terminal.js';
import type {
  Project,
  ResolvedGlobalConfig,
  Session,
  State,
  ThemePreference,
} from '../types.js';
import { Settings, Menu } from 'lucide-react';

type Toast = { id: number; kind: 'error' | 'success' | 'info'; text: string };

function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

function projectIdFor(absPath: string): string {
  return fnv1a32(absPath).toString(16).padStart(8, '0');
}

function resolveTheme(pref: ThemePreference): 'light' | 'dark' {
  if (pref === 'system') {
    if (
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
    ) {
      return 'dark';
    }
    return 'light';
  }
  return pref;
}

export function App(): JSX.Element {
  const [state, setState] = useState<State | null>(null);
  const [config, setConfig] = useState<ResolvedGlobalConfig | null>(null);
  const [activeProjectPath, setActiveProjectPath] = useState<string | null>(null);
  const [activeBranch, setActiveBranch] = useState<string | null>(null);
  const [newSessionTarget, setNewSessionTarget] = useState<string | null>(null);
  const [projectSettingsTarget, setProjectSettingsTarget] = useState<string | null>(null);
  const [globalSettingsOpen, setGlobalSettingsOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const pushToast = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, kind, text }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5000);
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch('/api/state').then((r) => r.json()),
      fetch('/api/global-config').then((r) => r.json()),
    ]).then(([s, c]: [State, ResolvedGlobalConfig]) => {
      if (cancelled) return;
      setState(s);
      setConfig(c);
      const firstProject = Object.keys(s.projects)[0];
      if (firstProject) setActiveProjectPath(firstProject);
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
        } else if (
          msg.type === 'config-changed' ||
          msg.type === 'terminal-spawn' ||
          msg.type === 'terminal-exit'
        ) {
          window.dispatchEvent(new CustomEvent('sequoias:terminals-changed'));
        } else if (msg.type === 'session-remove') {
          setState((prev) => {
            if (!prev) return prev;
            const next = structuredClone(prev);
            const project = next.projects[msg.projectPath];
            if (project) delete project.sessions[msg.branch];
            return next;
          });
        } else if (msg.type === 'global-config-changed') {
          setConfig(msg.config);
        } else if (msg.type === 'project-removed') {
          setState((prev) => {
            if (!prev) return prev;
            const next = structuredClone(prev);
            delete next.projects[msg.projectPath];
            return next;
          });
          setActiveProjectPath((curr) =>
            curr === msg.projectPath ? null : curr,
          );
        } else if (msg.type === 'project-updated') {
          // Will be reflected on next /api/state poll. Trigger a refresh.
          fetch('/api/state').then((r) => r.json()).then(setState);
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

  // Apply theme to document root
  useEffect(() => {
    if (!config) return;
    const apply = () => {
      const resolved = resolveTheme(config.theme);
      document.documentElement.setAttribute('data-theme', resolved);
    };
    apply();
    if (config.theme === 'system' && window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const listener = () => apply();
      mq.addEventListener('change', listener);
      return () => mq.removeEventListener('change', listener);
    }
  }, [config?.theme]);

  const project: Project | undefined = useMemo(() => {
    if (!state || !activeProjectPath) return undefined;
    return state.projects[activeProjectPath];
  }, [state, activeProjectPath]);

  const activeProjectId = useMemo(
    () => (activeProjectPath ? projectIdFor(activeProjectPath) : undefined),
    [activeProjectPath],
  );

  const activeSession: Session | undefined = useMemo(() => {
    if (!project || !activeBranch) return undefined;
    return project.sessions[activeBranch];
  }, [project, activeBranch]);

  const handleCreateSession = useCallback(
    async (branch: string, baseBranch?: string) => {
      if (!newSessionTarget) return;
      const id = projectIdFor(newSessionTarget);
      const res = await fetch(`/api/projects/${id}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch, baseBranch }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `request failed: ${res.status}`);
      }
      const body = await res.json();
      setActiveProjectPath(newSessionTarget);
      setActiveBranch(body.session.branch);
    },
    [newSessionTarget],
  );

  const handleArchive = useCallback(
    async (projectPath: string, branch: string, deleteBranch: boolean) => {
      const id = projectIdFor(projectPath);
      const res = await fetch(
        `/api/projects/${id}/sessions/${encodeURIComponent(branch)}?deleteBranch=${deleteBranch}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        pushToast('error', body.error || `archive failed: ${res.status}`);
        return;
      }
      if (activeProjectPath === projectPath && activeBranch === branch) {
        setActiveBranch(null);
      }
    },
    [activeProjectPath, activeBranch, pushToast],
  );

  const handleCreatePr = useCallback(
    async (projectPath: string, branch: string) => {
      const id = projectIdFor(projectPath);
      const res = await fetch(
        `/api/projects/${id}/sessions/${encodeURIComponent(branch)}/pr`,
        { method: 'POST' },
      );
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
    async (projectPath: string, branch: string) => {
      const id = projectIdFor(projectPath);
      const res = await fetch(
        `/api/projects/${id}/sessions/${encodeURIComponent(branch)}/resync-env`,
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
    async (projectPath: string, branch: string) => {
      const id = projectIdFor(projectPath);
      const res = await fetch(
        `/api/projects/${id}/sessions/${encodeURIComponent(branch)}/ide`,
        { method: 'POST' },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        pushToast('error', body.error || 'IDE launch failed');
      }
    },
    [pushToast],
  );

  const onSelectSession = useCallback(
    (projectPath: string, branch: string) => {
      setActiveProjectPath(projectPath);
      setActiveBranch(branch);
      setDrawerOpen(false);
    },
    [],
  );

  if (!state || !config) {
    return <div className="main-empty">Loading…</div>;
  }

  const projectSettingsId = projectSettingsTarget
    ? projectIdFor(projectSettingsTarget)
    : undefined;
  const newSessionProject = newSessionTarget
    ? state.projects[newSessionTarget]
    : undefined;

  return (
    <div className="app">
      <header className="mobile-topbar">
        <button
          className="drawer-toggle"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open project list"
          data-testid="drawer-toggle"
        >
          <Menu size={18} />
        </button>
        <div className="mobile-topbar-title">
          {project ? `${project.name}${activeBranch ? ` · ${activeBranch}` : ''}` : 'Sequoias'}
        </div>
        <ThemeToggle
          value={config.theme}
          onChange={(next) => {
            void fetch('/api/global-config', {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ theme: next }),
            });
          }}
        />
        <button
          className="icon-btn"
          onClick={() => setGlobalSettingsOpen(true)}
          aria-label="Global settings"
          data-testid="global-settings-btn-mobile"
        >
          <Settings size={16} />
        </button>
      </header>
      {drawerOpen && (
        <div
          className="drawer-backdrop open"
          onClick={() => setDrawerOpen(false)}
        />
      )}
      <aside className={`rail ${drawerOpen ? 'drawer-open' : ''}`}>
        <header className="rail-header">
          <div className="rail-brand">
            <img className="rail-brand-mark" src="/icon.svg" alt="" aria-hidden="true" />
            <span className="rail-brand-name">Sequoias</span>
          </div>
          <div className="rail-header-actions">
            <ThemeToggle
              value={config.theme}
              onChange={(next) => {
                void fetch('/api/global-config', {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ theme: next }),
                });
              }}
            />
            <button
              className="icon-btn"
              onClick={() => setGlobalSettingsOpen(true)}
              title="Global settings (theme, IDE, projects)"
              data-testid="global-settings-btn"
              aria-label="Global settings"
            >
              <Settings size={16} />
            </button>
          </div>
        </header>
        <ProjectTree
          state={state}
          activeProjectPath={activeProjectPath}
          activeBranch={activeBranch}
          onSelect={onSelectSession}
          onNewSession={(path) => setNewSessionTarget(path)}
          onProjectSettings={(path) => setProjectSettingsTarget(path)}
          onArchive={handleArchive}
          onCreatePr={handleCreatePr}
          onLaunchIde={handleLaunchIde}
          onResyncEnv={handleResyncEnv}
        />
      </aside>
      <main className="main">
        {activeSession ? (
          <Terminal session={activeSession} projectId={activeProjectId} />
        ) : (
          <div className="main-empty">
            {Object.keys(state.projects).length === 0
              ? 'No projects yet — open Global settings to add one.'
              : 'Select a session to view its terminal.'}
          </div>
        )}
      </main>
      {newSessionTarget && (
        <NewSessionDialog
          projectId={projectIdFor(newSessionTarget)}
          projectName={newSessionProject?.name}
          onClose={() => setNewSessionTarget(null)}
          onCreate={async (branch, base) => {
            await handleCreateSession(branch, base);
            setNewSessionTarget(null);
          }}
        />
      )}
      {projectSettingsTarget && (
        <SettingsDialog
          projectId={projectSettingsId}
          onClose={() => setProjectSettingsTarget(null)}
        />
      )}
      {globalSettingsOpen && (
        <GlobalSettingsDialog onClose={() => setGlobalSettingsOpen(false)} />
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
