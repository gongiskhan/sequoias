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

export type StoredTerminal = {
  name: string;
  cwd: string;
  cmd: string | null;
  autostart: boolean;
  background: boolean;
};

export type Project = {
  path: string;
  name: string;
  ide?: string;
  sessions: Record<string, Session>;
  terminals?: StoredTerminal[];
};

export type ThemePreference = 'dark' | 'light' | 'system';

export type GlobalConfig = {
  theme?: ThemePreference;
  idePath?: string;
  projects?: string[];
  host?: string;
};

export type ResolvedGlobalConfig = {
  theme: ThemePreference;
  idePath: string;
  projects: string[];
  host: string;
};

export type State = {
  version: 1;
  globalConfig?: GlobalConfig;
  projects: Record<string, Project>;
};
