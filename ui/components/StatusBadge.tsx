import React from 'react';
import type { SessionStatus } from '../types.js';

const LABELS: Record<SessionStatus, string> = {
  starting: 'Starting',
  working: 'Working',
  waiting: 'Waiting',
  idle: 'Idle',
  errored: 'Errored',
  dead: 'Dead',
};

export function StatusBadge({ status }: { status: SessionStatus }): JSX.Element {
  return (
    <span className={`status-badge status-${status}`} data-testid="status-badge">
      <span className="status-dot" />
      <span data-testid="status-label">{LABELS[status]}</span>
    </span>
  );
}
