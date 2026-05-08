import React, { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
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

  useEffect(() => {
    fetch('/api/global-config')
      .then((r) => r.json())
      .then((d: ResolvedGlobalConfig) => setConfig(d))
      .catch((err) => setError((err as Error).message));
  }, []);

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
