import type { SessionStatus } from './types.js';

export function statusFromHookEvent(event: string): SessionStatus | null {
  switch (event) {
    case 'UserPromptSubmit':
    case 'PostToolUse':
      return 'working';
    case 'Stop':
      return 'idle';
    case 'Notification':
      return 'waiting';
    default:
      return null;
  }
}

export function statusPriority(status: SessionStatus): number {
  switch (status) {
    case 'waiting':
      return 0;
    case 'working':
      return 1;
    case 'starting':
      return 2;
    case 'idle':
      return 3;
    case 'errored':
      return 4;
    case 'dead':
      return 5;
    default:
      return 99;
  }
}
