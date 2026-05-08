import React, { useEffect, useState } from 'react';
import { Plus, Trash2, AlertTriangle } from 'lucide-react';
import type { ResolvedGlobalConfig, ThemePreference } from '../types.js';

type Props = {
  onClose: () => void;
};

const THEMES: ThemePreference[] = ['light', 'dark', 'system'];

export function GlobalSettingsDialog({ onClose }: Props): JSX.Element {
  const [config, setConfig] = useState<ResolvedGlobalConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [newProject, setNewProject] = useState('');
  const [portRange, setPortRange] = useState<{ start: number; end: number } | null>(null);
  const [killing, setKilling] = useState(false);
  const [lastKill, setLastKill] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/global-config')
      .then((r) => r.json())
      .then((d: ResolvedGlobalConfig) => setConfig(d))
      .catch((err) => setError((err as Error).message));
    fetch('/api/port-range')
      .then((r) => r.json())
      .then(setPortRange)
      .catch(() => undefined);
  }, []);

  const killSwitch = async () => {
    if (!portRange) return;
    setKilling(true);
    setLastKill(null);
    try {
      // Preview first.
      const preview = await fetch('/api/kill-switch').then((r) => r.json());
      const ports: { port: number; pid: number; command: string }[] =
        preview.ports || [];
      if (ports.length === 0) {
        setLastKill(
          `Nothing to kill — no listeners in ${portRange.start}-${portRange.end}.`,
        );
        return;
      }
      const lines = ports
        .map((p) => `  ${p.command} (pid ${p.pid}) on port ${p.port}`)
        .join('\n');
      const ok = window.confirm(
        `About to kill ${ports.length} process${ports.length === 1 ? '' : 'es'} in ports ${portRange.start}-${portRange.end}:\n\n${lines}\n\nCheck the list above for anything you want to keep (Jump Desktop, VPN clients, screen sharing tools, etc. sometimes land in this range). Continue?`,
      );
      if (!ok) {
        setLastKill('Cancelled.');
        return;
      }
      const res = await fetch('/api/kill-switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `request failed: ${res.status}`);
      const n = (body.pidsKilled || []).length;
      const summary = (body.ports || [])
        .map((p: { port: number; command: string }) => `${p.command}:${p.port}`)
        .join(', ');
      setLastKill(
        `Killed ${n} process${n === 1 ? '' : 'es'}: ${summary}`,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setKilling(false);
    }
  };

  if (!config) {
    return (
      <div className="dialog-backdrop" onClick={onClose}>
        <div className="dialog" onClick={(e) => e.stopPropagation()}>
          <h2>Global settings</h2>
          <div className="dialog-hint">Loading…</div>
        </div>
      </div>
    );
  }

  const patch = async (delta: Partial<ResolvedGlobalConfig>) => {
    setError(null);
    setSaving(true);
    try {
      const res = await fetch('/api/global-config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(delta),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `request failed: ${res.status}`);
      }
      const next = (await res.json()) as ResolvedGlobalConfig;
      setConfig(next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const addProject = async () => {
    const trimmed = newProject.trim();
    if (!trimmed) return;
    setError(null);
    setSaving(true);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: trimmed }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `request failed: ${res.status}`);
      }
      setNewProject('');
      const fresh = await fetch('/api/global-config').then((r) => r.json());
      setConfig(fresh);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const removeProject = async (p: string) => {
    const next = config.projects.filter((x) => x !== p);
    await patch({ projects: next });
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog dialog-wide"
        onClick={(e) => e.stopPropagation()}
        data-testid="global-settings-dialog"
      >
        <h2>Global settings</h2>

        <div className="global-section">
          <div className="global-section-title">Theme</div>
          <div className="theme-options">
            {THEMES.map((t) => (
              <button
                key={t}
                className={config.theme === t ? 'active' : ''}
                onClick={() => void patch({ theme: t })}
                data-testid={`theme-option-${t}`}
              >
                {t}
              </button>
            ))}
          </div>
          <p className="dialog-hint">
            <strong>System</strong> follows your OS appearance setting.
          </p>
        </div>

        <div className="global-section">
          <div className="global-section-title">IDE command (default)</div>
          <input
            type="text"
            placeholder="rebased"
            value={config.idePath}
            onChange={(e) => setConfig({ ...config, idePath: e.target.value })}
            onBlur={(e) => void patch({ idePath: e.target.value })}
            data-testid="global-ide-input"
          />
          <p className="dialog-hint">
            Used as the default IDE for projects without a per-project IDE.
            Examples: <code>rebased</code>, <code>code</code>, <code>idea</code>.
          </p>
        </div>

        <div className="global-section">
          <div className="global-section-title">Network host</div>
          <input
            type="text"
            placeholder="0.0.0.0"
            value={config.host}
            onChange={(e) => setConfig({ ...config, host: e.target.value })}
            onBlur={(e) => void patch({ host: e.target.value })}
            data-testid="global-host-input"
          />
          <p className="dialog-hint">
            Bind address for the HTTP server. <code>0.0.0.0</code> exposes on all
            interfaces (LAN + Tailscale + localhost). Restart required to take
            effect.
          </p>
        </div>

        <div className="global-section">
          <div className="global-section-title">Projects</div>
          <div className="projects-list">
            {config.projects.length === 0 && (
              <div className="settings-empty">No projects configured.</div>
            )}
            {config.projects.map((p) => (
              <div className="projects-list-row" key={p}>
                <span className="path">{p}</span>
                <button
                  className="icon-btn"
                  onClick={() => void removeProject(p)}
                  title="Remove project (does not delete worktrees)"
                  data-testid={`global-remove-project-${p}`}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
          <div className="projects-list-add">
            <input
              type="text"
              placeholder="/absolute/path/to/repo"
              value={newProject}
              onChange={(e) => setNewProject(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void addProject();
              }}
              data-testid="global-new-project-input"
            />
            <button
              onClick={() => void addProject()}
              disabled={saving || newProject.trim().length === 0}
              data-testid="global-add-project-btn"
            >
              <Plus size={13} /> Add
            </button>
          </div>
        </div>

        <div className="global-section danger-zone">
          <div className="global-section-title">Danger zone</div>
          <p className="dialog-hint">
            Kill every process listening on a port in
            {portRange ? ` ${portRange.start}-${portRange.end}` : ' the Sequoias range'}.
            Use this when worktrees pile up, or after restarting Sequoias and
            something is still bound to a worktree port.
          </p>
          <button
            type="button"
            className="kill-switch-btn"
            onClick={() => void killSwitch()}
            disabled={killing || !portRange}
            data-testid="kill-switch-btn"
          >
            <AlertTriangle size={14} />
            {killing ? 'Killing…' : 'Kill all processes in port range'}
          </button>
          {lastKill && (
            <div className="dialog-hint" data-testid="kill-switch-result">{lastKill}</div>
          )}
        </div>

        {error && (
          <div className="dialog-error" data-testid="global-settings-error">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onClose} data-testid="global-settings-close">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
