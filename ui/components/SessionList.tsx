import React, { useMemo, useState } from 'react';
import type { Project, Session } from '../types.js';
import { StatusBadge } from './StatusBadge.js';
import { Code2, GitPullRequest, RefreshCcw, Trash2, Terminal as TerminalIcon } from 'lucide-react';

const STATUS_PRIORITY: Record<string, number> = {
  waiting: 0,
  working: 1,
  starting: 2,
  idle: 3,
  errored: 4,
  dead: 5,
};

type Props = {
  project: Project | undefined;
  activeBranch: string | null;
  onSelect: (branch: string) => void;
  onArchive: (branch: string, deleteBranch: boolean) => Promise<void>;
  onCreatePr: (branch: string) => Promise<void>;
  onLaunchIde: (branch: string) => Promise<void>;
  onResyncEnv: (branch: string) => Promise<void>;
};

export function SessionList({
  project,
  activeBranch,
  onSelect,
  onArchive,
  onCreatePr,
  onLaunchIde,
  onResyncEnv,
}: Props): JSX.Element {
  const sessions = useMemo<Session[]>(() => {
    if (!project) return [];
    return Object.values(project.sessions).sort((a, b) => {
      const pa = STATUS_PRIORITY[a.lastStatus] ?? 99;
      const pb = STATUS_PRIORITY[b.lastStatus] ?? 99;
      if (pa !== pb) return pa - pb;
      return a.branch.localeCompare(b.branch);
    });
  }, [project]);

  return (
    <div className="session-list" data-testid="session-list">
      {sessions.length === 0 && (
        <div className="rail-title" style={{ padding: '12px 4px' }}>
          No sessions yet
        </div>
      )}
      {sessions.map((s) => (
        <SessionCard
          key={s.branch}
          session={s}
          active={activeBranch === s.branch}
          onSelect={() => onSelect(s.branch)}
          onArchive={onArchive}
          onCreatePr={onCreatePr}
          onLaunchIde={onLaunchIde}
          onResyncEnv={onResyncEnv}
        />
      ))}
    </div>
  );
}

function SessionCard({
  session,
  active,
  onSelect,
  onArchive,
  onCreatePr,
  onLaunchIde,
  onResyncEnv,
}: {
  session: Session;
  active: boolean;
  onSelect: () => void;
  onArchive: Props['onArchive'];
  onCreatePr: Props['onCreatePr'];
  onLaunchIde: Props['onLaunchIde'];
  onResyncEnv: Props['onResyncEnv'];
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const ports = Object.entries(session.ports)
    .map(([k, v]) => `${k}:${v}`)
    .join('  ');

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
        <StatusBadge status={session.lastStatus} />
      </div>
      {ports && <div className="ports">{ports}</div>}
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
          className="icon-btn"
          title="Open in IDE"
          onClick={() => guard(() => onLaunchIde(session.branch))}
          data-testid={`ide-btn-${session.branch}`}
        >
          <Code2 size={14} />
        </button>
        <button
          className="icon-btn"
          title="Sync env files from main checkout"
          onClick={() => guard(() => onResyncEnv(session.branch))}
          data-testid={`resync-btn-${session.branch}`}
        >
          <RefreshCcw size={14} />
        </button>
        <button
          className="icon-btn"
          title="Create PR"
          onClick={() => guard(() => onCreatePr(session.branch))}
          data-testid={`pr-btn-${session.branch}`}
        >
          <GitPullRequest size={14} />
        </button>
        <button
          className="icon-btn"
          title="Archive (remove worktree)"
          onClick={() => {
            const deleteBranch = window.confirm(
              `Remove worktree for ${session.branch}?\n\nClick OK to remove worktree only, Cancel to keep it.\n\nHold Shift to also delete the branch (use the keyboard menu after dialog).`,
            );
            if (!deleteBranch) return;
            const alsoDelete = window.confirm('Also delete the branch?');
            void guard(() => onArchive(session.branch, alsoDelete));
          }}
          data-testid={`archive-btn-${session.branch}`}
        >
          <Trash2 size={14} />
        </button>
        <button
          className="icon-btn"
          title="Focus terminal"
          onClick={onSelect}
          data-testid={`focus-btn-${session.branch}`}
        >
          <TerminalIcon size={14} />
        </button>
      </div>
    </div>
  );
}
