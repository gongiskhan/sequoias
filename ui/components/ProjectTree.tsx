import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Plus, Settings as SettingsIcon } from 'lucide-react';
import type { Project, Session, State } from '../types.js';
import { StatusBadge } from './StatusBadge.js';
import { Code2, GitPullRequest, RefreshCcw, Trash2, History } from 'lucide-react';

const STATUS_PRIORITY: Record<string, number> = {
  waiting: 0,
  working: 1,
  starting: 2,
  idle: 3,
  errored: 4,
  dead: 5,
};

const COLLAPSED_KEY = 'sequoias.collapsed-projects';

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return new Set(arr.filter((s) => typeof s === 'string'));
  } catch {
    // ignore
  }
  return new Set();
}

function saveCollapsed(set: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(Array.from(set)));
  } catch {
    // ignore
  }
}

type Props = {
  state: State;
  activeProjectPath: string | null;
  activeBranch: string | null;
  onSelect: (projectPath: string, branch: string) => void;
  onNewSession: (projectPath: string) => void;
  onProjectSettings: (projectPath: string) => void;
  onArchive: (projectPath: string, branch: string, deleteBranch: boolean) => Promise<void>;
  onCreatePr: (projectPath: string, branch: string) => Promise<void>;
  onLaunchIde: (projectPath: string, branch: string) => Promise<void>;
  onResyncEnv: (projectPath: string, branch: string) => Promise<void>;
  onClaudeContinue: (projectPath: string, branch: string) => Promise<void>;
};

export function ProjectTree({
  state,
  activeProjectPath,
  activeBranch,
  onSelect,
  onNewSession,
  onProjectSettings,
  onArchive,
  onCreatePr,
  onLaunchIde,
  onResyncEnv,
  onClaudeContinue,
}: Props): JSX.Element {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed());

  const projects = useMemo(() => Object.values(state.projects), [state.projects]);

  const toggle = (path: string) => {
    const next = new Set(collapsed);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setCollapsed(next);
    saveCollapsed(next);
  };

  if (projects.length === 0) {
    return (
      <div className="project-tree" data-testid="project-tree">
        <div className="settings-empty" style={{ padding: '24px 16px' }}>
          No projects yet. Open Global settings to add one.
        </div>
      </div>
    );
  }

  return (
    <div className="project-tree" data-testid="project-tree">
      {projects.map((project) => (
        <ProjectGroup
          key={project.path}
          project={project}
          isCollapsed={collapsed.has(project.path)}
          onToggle={() => toggle(project.path)}
          activeProjectPath={activeProjectPath}
          activeBranch={activeBranch}
          onSelect={onSelect}
          onNewSession={onNewSession}
          onProjectSettings={onProjectSettings}
          onArchive={onArchive}
          onCreatePr={onCreatePr}
          onLaunchIde={onLaunchIde}
          onResyncEnv={onResyncEnv}
          onClaudeContinue={onClaudeContinue}
        />
      ))}
    </div>
  );
}

function ProjectGroup({
  project,
  isCollapsed,
  onToggle,
  activeProjectPath,
  activeBranch,
  onSelect,
  onNewSession,
  onProjectSettings,
  onArchive,
  onCreatePr,
  onLaunchIde,
  onResyncEnv,
  onClaudeContinue,
}: Props & {
  project: Project;
  isCollapsed: boolean;
  onToggle: () => void;
}): JSX.Element {
  const sessions = useMemo<Session[]>(() => {
    return Object.values(project.sessions).sort((a, b) => {
      const pa = STATUS_PRIORITY[a.lastStatus] ?? 99;
      const pb = STATUS_PRIORITY[b.lastStatus] ?? 99;
      if (pa !== pb) return pa - pb;
      return a.branch.localeCompare(b.branch);
    });
  }, [project.sessions]);

  return (
    <div className="project-group" data-testid={`project-group-${project.name}`}>
      <div
        className="project-group-header"
        onClick={onToggle}
        data-testid={`project-toggle-${project.name}`}
      >
        <span className="project-group-chevron">
          {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </span>
        <span className="project-group-name" data-testid="project-name">
          {project.name}
        </span>
        <button
          className="icon-btn"
          onClick={(e) => {
            e.stopPropagation();
            onProjectSettings(project.path);
          }}
          title="Project terminals"
          data-testid={`project-settings-${project.name}`}
          aria-label={`Project terminals for ${project.name}`}
        >
          <SettingsIcon size={18} />
        </button>
      </div>
      {!isCollapsed && (
        <>
          <span className="project-group-path" data-testid="project-path">
            {project.path}
          </span>
          <div className="project-group-actions">
            <button
              className="project-group-new"
              onClick={() => onNewSession(project.path)}
              data-testid={
                project.path === activeProjectPath
                  ? 'new-session-btn'
                  : `new-session-btn-${project.name}`
              }
            >
              <Plus size={13} /> New session
            </button>
          </div>
          <div className="session-list" data-testid="session-list">
            {sessions.length === 0 && (
              <div className="session-empty">No sessions yet</div>
            )}
            {sessions.map((s) => (
              <SessionCard
                key={s.branch}
                session={s}
                projectPath={project.path}
                active={
                  activeProjectPath === project.path && activeBranch === s.branch
                }
                onSelect={() => onSelect(project.path, s.branch)}
                onArchive={onArchive}
                onCreatePr={onCreatePr}
                onLaunchIde={onLaunchIde}
                onResyncEnv={onResyncEnv}
                onClaudeContinue={onClaudeContinue}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function SessionCard({
  session,
  projectPath,
  active,
  onSelect,
  onArchive,
  onCreatePr,
  onLaunchIde,
  onResyncEnv,
  onClaudeContinue,
}: {
  session: Session;
  projectPath: string;
  active: boolean;
  onSelect: () => void;
  onArchive: Props['onArchive'];
  onCreatePr: Props['onCreatePr'];
  onLaunchIde: Props['onLaunchIde'];
  onResyncEnv: Props['onResyncEnv'];
  onClaudeContinue: Props['onClaudeContinue'];
}): JSX.Element {
  const [busy, setBusy] = useState(false);

  const stop = (e: React.MouseEvent) => e.stopPropagation();

  const guard = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`session-card ${active ? 'active' : ''}`}
      onClick={onSelect}
      data-testid={`session-card-${session.branch}`}
      data-branch={session.branch}
    >
      <div className="session-card-row">
        <span className="branch-name">{session.branch}</span>
        <div className="session-card-row-right" onClick={stop}>
          <button
            className="card-icon-btn"
            title="Restart claude with --continue (resume the most recent session in this worktree)"
            onClick={() => guard(() => onClaudeContinue(projectPath, session.branch))}
            data-testid={`continue-btn-${session.branch}`}
            disabled={busy}
            aria-label="Continue claude session"
          >
            <History size={13} />
          </button>
          <StatusBadge status={session.lastStatus} />
        </div>
      </div>
      {session.prUrl && (
        <a
          className="pr-link"
          href={session.prUrl}
          target="_blank"
          rel="noreferrer"
          onClick={stop}
          data-testid={`pr-link-${session.branch}`}
        >
          {session.prUrl}
        </a>
      )}
      <div className="session-actions" onClick={stop}>
        <button
          className="action-btn"
          title="Open this worktree in your configured IDE"
          onClick={() => guard(() => onLaunchIde(projectPath, session.branch))}
          data-testid={`ide-btn-${session.branch}`}
          disabled={busy}
        >
          <span className="action-btn-icon"><Code2 size={15} /></span>
          <span>IDE</span>
        </button>
        <button
          className="action-btn"
          title="Re-copy and rewrite .env files from the main checkout"
          onClick={() => guard(() => onResyncEnv(projectPath, session.branch))}
          data-testid={`resync-btn-${session.branch}`}
          disabled={busy}
        >
          <span className="action-btn-icon"><RefreshCcw size={15} /></span>
          <span>Sync env</span>
        </button>
        <button
          className="action-btn"
          title="Create a GitHub pull request for this branch"
          onClick={() => guard(() => onCreatePr(projectPath, session.branch))}
          data-testid={`pr-btn-${session.branch}`}
          disabled={busy}
        >
          <span className="action-btn-icon"><GitPullRequest size={15} /></span>
          <span>PR</span>
        </button>
        <button
          className="action-btn danger"
          title="Remove the worktree (and optionally the branch)"
          onClick={() => {
            const confirmed = window.confirm(
              `Remove worktree for ${session.branch}?`,
            );
            if (!confirmed) return;
            const alsoDelete = window.confirm('Also delete the branch?');
            void guard(() => onArchive(projectPath, session.branch, alsoDelete));
          }}
          data-testid={`archive-btn-${session.branch}`}
          disabled={busy}
        >
          <span className="action-btn-icon"><Trash2 size={15} /></span>
          <span>Archive</span>
        </button>
      </div>
    </div>
  );
}
