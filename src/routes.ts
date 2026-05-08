import type { Express, Request, Response } from 'express';
import path from 'node:path';
import {
  buildSession,
  createWorktree,
  listLocalAndRemoteBranches,
  removeWorktree,
  resyncEnvFiles,
} from './worktree.js';
import { createPullRequest, launchIde } from './git-ops.js';
import { statusFromHookEvent } from './status.js';
import type { Store } from './store.js';
import type { Project } from './types.js';
import type { PtyManager } from './pty-manager.js';
import { resolveTerminals, validateTerminals } from './config.js';

export type RoutesDeps = {
  store: Store;
  project: Project;
  ide?: string;
  ptyManager: PtyManager;
  serverPort: number;
};

export function registerRoutes(app: Express, deps: RoutesDeps): void {
  const { store, project, ptyManager } = deps;
  const terminals = () => resolveTerminals(project.terminals);

  app.get('/api/state', (_req: Request, res: Response) => {
    res.json(store.data);
  });

  app.get('/api/project', (_req: Request, res: Response) => {
    res.json({
      path: project.path,
      name: project.name,
      ide: project.ide,
      sessions: project.sessions,
      terminals: terminals(),
      storedTerminals: project.terminals || [],
    });
  });

  app.get('/api/branches', async (_req: Request, res: Response) => {
    try {
      const branches = await listLocalAndRemoteBranches(project.path);
      res.json({ branches });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/config', (_req: Request, res: Response) => {
    res.json({
      terminals: terminals(),
      storedTerminals: project.terminals || [],
    });
  });

  app.put('/api/project/terminals', async (req: Request, res: Response) => {
    try {
      const list = validateTerminals(req.body?.terminals);
      project.terminals = list;
      await store.save();
      await store.flush();
      store.broadcast({
        type: 'config-changed',
        terminals: terminals(),
        storedTerminals: list,
      });
      res.json({ ok: true, storedTerminals: list, terminals: terminals() });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get('/api/sessions/:branch/terminals', (req: Request, res: Response) => {
    const branch = decodeURIComponent(String(req.params.branch));
    const session = project.sessions[branch];
    if (!session) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    const running = ptyManager.listRunning(project.path, branch);
    res.json({
      terminals: terminals().map((t) => ({
        ...t,
        running: running.includes(t.name),
      })),
    });
  });

  app.post('/api/sessions', async (req: Request, res: Response) => {
    const { branch, baseBranch } = req.body || {};
    if (!branch || typeof branch !== 'string') {
      res.status(400).json({ error: 'branch is required' });
      return;
    }
    if (project.sessions[branch]) {
      res.status(409).json({ error: 'session for this branch already exists' });
      return;
    }
    try {
      const result = await createWorktree({
        repoPath: project.path,
        repoName: project.name,
        branch,
        baseBranch,
      });
      const session = buildSession({
        branch,
        worktreePath: result.worktreePath,
        ports: result.ports,
        envFiles: result.envFiles,
      });
      store.upsertSession(project.path, session);
      await store.flush();
      ptyManager.spawnSession(project.path, session, terminals());
      res.json({ session });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/sessions/:branch', async (req: Request, res: Response) => {
    const branch = decodeURIComponent(String(req.params.branch));
    const session = project.sessions[branch];
    if (!session) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    const deleteBranch = String(req.query.deleteBranch || '') === 'true';
    try {
      ptyManager.killSession(project.path, branch);
      await new Promise((r) => setTimeout(r, 80));
      await removeWorktree(project.path, session.worktreePath, {
        deleteBranch,
        branch,
      });
      store.removeSession(project.path, branch);
      await store.flush();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/sessions/:branch/pr', async (req: Request, res: Response) => {
    const branch = decodeURIComponent(String(req.params.branch));
    const session = project.sessions[branch];
    if (!session) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    const result = await createPullRequest(session.worktreePath, branch);
    if (result.ok) {
      session.prUrl = result.url;
      store.upsertSession(project.path, session);
      res.json({ ok: true, url: result.url });
    } else {
      res.status(500).json({ ok: false, error: result.error });
    }
  });

  app.post('/api/sessions/:branch/ide', async (req: Request, res: Response) => {
    const branch = decodeURIComponent(String(req.params.branch));
    const session = project.sessions[branch];
    if (!session) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    if (!project.ide) {
      res.status(400).json({ error: 'no IDE configured (start sequoias with --ide)' });
      return;
    }
    try {
      await launchIde(project.ide, session.worktreePath);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/sessions/:branch/resync-env', async (req: Request, res: Response) => {
    const branch = decodeURIComponent(String(req.params.branch));
    const session = project.sessions[branch];
    if (!session) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    try {
      const result = await resyncEnvFiles({
        repoPath: project.path,
        worktreePath: session.worktreePath,
        branch,
        existingPorts: session.ports,
      });
      session.ports = result.ports;
      session.envFiles = result.envFiles;
      store.upsertSession(project.path, session);
      await store.flush();
      res.json({
        ok: true,
        copiedFiles: result.copiedFiles,
        envFiles: result.envFiles,
        ports: result.ports,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/sessions/:branch/respawn', (req: Request, res: Response) => {
    const branch = decodeURIComponent(String(req.params.branch));
    const session = project.sessions[branch];
    if (!session) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    ptyManager.spawnSession(project.path, session, terminals());
    res.json({ ok: true });
  });

  app.post(
    '/api/sessions/:branch/terminals/:name/restart',
    (req: Request, res: Response) => {
      const branch = decodeURIComponent(String(req.params.branch));
      const name = decodeURIComponent(String(req.params.name));
      const session = project.sessions[branch];
      if (!session) {
        res.status(404).json({ error: 'session not found' });
        return;
      }
      const terminal = terminals().find((t) => t.name === name);
      if (!terminal) {
        res.status(404).json({ error: `terminal "${name}" not configured` });
        return;
      }
      ptyManager.kill(project.path, branch, name);
      ptyManager.spawn(project.path, session, terminal);
      res.json({ ok: true });
    },
  );

  app.post(
    '/api/sessions/:branch/terminals/:name/kill',
    (req: Request, res: Response) => {
      const branch = decodeURIComponent(String(req.params.branch));
      const name = decodeURIComponent(String(req.params.name));
      const killed = ptyManager.kill(project.path, branch, name);
      res.json({ ok: true, killed });
    },
  );

  app.post('/_hook', (req: Request, res: Response) => {
    const event = String(req.body?.event || '');
    const cwd = String(req.body?.cwd || '');
    if (!event || !cwd) {
      res.status(400).json({ error: 'event and cwd required' });
      return;
    }
    const normalized = path.resolve(cwd);
    let matched = false;
    for (const [projectPath, p] of Object.entries(store.data.projects)) {
      for (const session of Object.values(p.sessions)) {
        if (path.resolve(session.worktreePath) === normalized) {
          const status = statusFromHookEvent(event);
          if (status) {
            store.setSessionStatus(projectPath, session.branch, status, event);
          }
          matched = true;
        }
      }
    }
    res.json({ ok: true, matched });
  });
}
