export type SessionStatus =
  | 'starting'
  | 'working'
  | 'waiting'
  | 'idle'
  | 'errored'
  | 'dead';

export type Session = {
  branch: string;
  worktreePath: string;
  ports: Record<string, number>;
  envFiles: string[];
  createdAt: string;
  ptyId?: string;
  lastStatus: SessionStatus;
  lastStatusAt: string;
  lastHookEvent?: string;
  prUrl?: string;
};

export type Project = {
  path: string;
  name: string;
  ide?: string;
  sessions: Record<string, Session>;
};

export type State = {
  version: 1;
  projects: Record<string, Project>;
};
