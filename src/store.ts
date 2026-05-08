import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { sequoiasDir, statePath } from './paths.js';
import type {
  GlobalConfig,
  Project,
  ResolvedGlobalConfig,
  Session,
  SessionStatus,
  State,
} from './types.js';
import { fnv1a32 } from './ports.js';

const EMPTY_STATE: State = { version: 1, projects: {} };

export const DEFAULT_GLOBAL_CONFIG: ResolvedGlobalConfig = {
  theme: 'system',
  idePath: '',
  projects: [],
  host: '0.0.0.0',
};

export function resolveGlobalConfig(
  state: Pick<State, 'globalConfig'>,
): ResolvedGlobalConfig {
  const g = state.globalConfig || {};
  return {
    theme: g.theme || DEFAULT_GLOBAL_CONFIG.theme,
    idePath: g.idePath || DEFAULT_GLOBAL_CONFIG.idePath,
    projects: g.projects ? [...g.projects] : [],
    host: g.host || DEFAULT_GLOBAL_CONFIG.host,
  };
}

export function projectIdFor(absPath: string): string {
  return fnv1a32(absPath).toString(16).padStart(8, '0');
}

export type Store = {
  data: State;
  save(): Promise<void>;
  flush(): Promise<void>;
  setSessionStatus(
    projectPath: string,
    branch: string,
    status: SessionStatus,
    hookEvent?: string,
  ): void;
  upsertSession(projectPath: string, session: Session): void;
  removeSession(projectPath: string, branch: string): void;
  getProject(projectPath: string): Project | undefined;
  getProjectById(id: string): Project | undefined;
  setGlobalConfig(patch: Partial<GlobalConfig>): ResolvedGlobalConfig;
  subscribe(ws: WebSocket): void;
  broadcast(msg: unknown): void;
};

export async function loadStore(): Promise<Store> {
  await fs.mkdir(sequoiasDir(), { recursive: true });
  let data: State = EMPTY_STATE;
  try {
    const raw = await fs.readFile(statePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 1 && parsed.projects) {
      data = parsed as State;
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  for (const project of Object.values(data.projects)) {
    for (const session of Object.values(project.sessions)) {
      if (!fsSync.existsSync(session.worktreePath)) {
        session.lastStatus = 'dead';
      } else if (session.lastStatus !== 'dead') {
        session.lastStatus = 'dead';
      }
      session.ptyId = undefined;
    }
  }

  const subscribers = new Set<WebSocket>();
  let saveInFlight: Promise<void> | null = null;
  let savePending = false;

  const flush = async () => {
    const tmp = statePath() + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(data, null, 2));
    await fs.rename(tmp, statePath());
  };

  const debouncedSave = async () => {
    if (saveInFlight) {
      savePending = true;
      return;
    }
    saveInFlight = (async () => {
      await new Promise((r) => setTimeout(r, 50));
      try {
        await flush();
      } finally {
        saveInFlight = null;
        if (savePending) {
          savePending = false;
          void debouncedSave();
        }
      }
    })();
  };

  const store: Store = {
    data,
    async save() {
      await debouncedSave();
    },
    async flush() {
      while (saveInFlight || savePending) {
        await saveInFlight;
      }
      await flush();
    },
    getProject(projectPath: string) {
      return data.projects[projectPath];
    },
    getProjectById(id: string) {
      for (const p of Object.values(data.projects)) {
        if (projectIdFor(p.path) === id) return p;
      }
      return undefined;
    },
    setGlobalConfig(patch: Partial<GlobalConfig>) {
      data.globalConfig = { ...(data.globalConfig || {}), ...patch };
      const resolved = resolveGlobalConfig(data);
      void this.save();
      this.broadcast({ type: 'global-config-changed', config: resolved });
      return resolved;
    },
    upsertSession(projectPath: string, session: Session) {
      const project = data.projects[projectPath];
      if (!project) return;
      project.sessions[session.branch] = session;
      void this.save();
      this.broadcast({ type: 'session-upsert', projectPath, session });
    },
    removeSession(projectPath: string, branch: string) {
      const project = data.projects[projectPath];
      if (!project) return;
      delete project.sessions[branch];
      void this.save();
      this.broadcast({ type: 'session-remove', projectPath, branch });
    },
    setSessionStatus(projectPath, branch, status, hookEvent) {
      const project = data.projects[projectPath];
      if (!project) return;
      const session = project.sessions[branch];
      if (!session) return;
      session.lastStatus = status;
      session.lastStatusAt = new Date().toISOString();
      if (hookEvent) session.lastHookEvent = hookEvent;
      void this.save();
      this.broadcast({ type: 'session-upsert', projectPath, session });
    },
    subscribe(ws: WebSocket) {
      subscribers.add(ws);
      ws.send(JSON.stringify({ type: 'state', data }));
      ws.on('close', () => subscribers.delete(ws));
    },
    broadcast(msg: unknown) {
      const payload = JSON.stringify(msg);
      for (const ws of subscribers) {
        if (ws.readyState === ws.OPEN) ws.send(payload);
      }
    },
  };

  return store;
}

export function ensureProject(
  store: Store,
  repoPath: string,
  ide?: string,
): Project {
  const existing = store.data.projects[repoPath];
  if (existing) {
    if (ide) existing.ide = ide;
    return existing;
  }
  const project: Project = {
    path: repoPath,
    name: path.basename(repoPath),
    ide,
    sessions: {},
  };
  store.data.projects[repoPath] = project;
  void store.save();
  return project;
}
