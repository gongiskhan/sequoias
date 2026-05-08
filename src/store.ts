import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { sequoiasDir, statePath } from './paths.js';
import type { Project, Session, SessionStatus, State } from './types.js';

const EMPTY_STATE: State = { version: 1, projects: {} };

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
