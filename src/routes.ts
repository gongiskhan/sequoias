import type { Express, Request, Response } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import {
  buildSession,
  createWorktree,
  listLocalAndRemoteBranches,
  removeWorktree,
  resyncEnvFiles,
} from './worktree.js';
import { createPullRequest, launchIde } from './git-ops.js';
import { statusFromHookEvent } from './status.js';
import {
  ensureProject,
  projectIdFor,
  resolveGlobalConfig,
  type Store,
} from './store.js';
import { killAllInSequoiasRange, listListenersInSequoiasRange } from './kill-switch.js';
import { SEQUOIAS_PORT_RANGE_START, SEQUOIAS_PORT_RANGE_END } from './ports.js';
import type { Project } from './types.js';
import type { PtyManager } from './pty-manager.js';
import { resolveTerminals, validateTerminals } from './config.js';

export type RoutesDeps = {
  store: Store;
  ptyManager: PtyManager;
  serverPort: number;
};

export function registerRoutes(app: Express, deps: RoutesDeps): void {
  const { store, ptyManager } = deps;

  const projectsList = (): Project[] => Object.values(store.data.projects);

  const projectFromReq = (req: Request): Project | undefined => {
    const id = String(req.params.id || '');
    if (id) return store.getProjectById(id);
    return projectsList()[0];
  };

  const terminalsFor = (project: Project) =>
    resolveTerminals(project.terminals);

  app.get('/api/state', (_req: Request, res: Response) => {
    res.json(store.data);
  });

  app.get('/api/global-config', (_req: Request, res: Response) => {
    res.json(resolveGlobalConfig(store.data));
  });

  app.patch('/api/global-config', async (req: Request, res: Response) => {
    try {
      const body = req.body || {};
      const patch: Record<string, unknown> = {};
      if (typeof body.theme === 'string') patch.theme = body.theme;
      if (typeof body.idePath === 'string') patch.idePath = body.idePath;
      if (typeof body.host === 'string') patch.host = body.host;
      if (Array.isArray(body.projects)) {
        patch.projects = body.projects
          .filter((p: unknown): p is string => typeof p === 'string' && p.length > 0)
          .map((p: string) => path.resolve(p));
      }
      const resolved = store.setGlobalConfig(patch);
      await store.flush();
      res.json(resolved);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/projects', async (req: Request, res: Response) => {
    const raw = req.body?.path;
    if (!raw || typeof raw !== 'string') {
      res.status(400).json({ error: 'path is required' });
      return;
    }
    const resolved = path.resolve(raw);
    if (!fs.existsSync(resolved)) {
      res.status(400).json({ error: `path does not exist: ${resolved}` });
      return;
    }
    if (!fs.existsSync(path.join(resolved, '.git'))) {
      res.status(400).json({ error: `not a git repository: ${resolved}` });
      return;
    }
    ensureProject(store, resolved);
    const list = store.data.globalConfig?.projects || [];
    if (!list.includes(resolved)) {
      store.setGlobalConfig({ projects: [...list, resolved] });
    }
    await store.flush();
    res.json({
      ok: true,
      project: store.data.projects[resolved],
      id: projectIdFor(resolved),
    });
  });

  app.delete('/api/projects/:id', async (req: Request, res: Response) => {
    const project = projectFromReq(req);
    if (!project) {
      res.status(404).json({ error: 'project not found' });
      return;
    }
    const list = store.data.globalConfig?.projects || [];
    const filtered = list.filter((p) => p !== project.path);
    if (filtered.length !== list.length) {
      store.setGlobalConfig({ projects: filtered });
    }
    delete store.data.projects[project.path];
    await store.save();
    await store.flush();
    store.broadcast({ type: 'project-removed', projectPath: project.path });
    res.json({ ok: true });
  });

  // ============================================================
  // Legacy single-project routes — resolve to the first project.
  // Kept so existing UI/tests using /api/project, /api/sessions/:branch
  // continue to work alongside the new id-keyed routes below.
  // ============================================================

  app.get('/api/project', (_req: Request, res: Response) => {
    const project = projectsList()[0];
    if (!project) {
      res.status(404).json({ error: 'no project configured' });
      return;
    }
    res.json({
      id: projectIdFor(project.path),
      path: project.path,
      name: project.name,
      ide: project.ide,
      sessions: project.sessions,
      terminals: terminalsFor(project),
      storedTerminals: project.terminals || [],
    });
  });

  app.get('/api/branches', async (_req: Request, res: Response) => {
    const project = projectsList()[0];
    if (!project) {
      res.status(404).json({ error: 'no project configured' });
      return;
    }
    try {
      const branches = await listLocalAndRemoteBranches(project.path);
      res.json({ branches });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/config', (_req: Request, res: Response) => {
    const project = projectsList()[0];
    if (!project) {
      res.status(404).json({ error: 'no project configured' });
      return;
    }
    res.json({
      terminals: terminalsFor(project),
      storedTerminals: project.terminals || [],
    });
  });

  app.put('/api/project/terminals', async (req: Request, res: Response) => {
    const project = projectsList()[0];
    if (!project) {
      res.status(404).json({ error: 'no project configured' });
      return;
    }
    try {
      const list = validateTerminals(req.body?.terminals);
      project.terminals = list;
      await store.save();
      await store.flush();
      store.broadcast({
        type: 'config-changed',
        projectPath: project.path,
        terminals: terminalsFor(project),
        storedTerminals: list,
      });
      res.json({ ok: true, storedTerminals: list, terminals: terminalsFor(project) });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get('/api/sessions/:branch/terminals', (req: Request, res: Response) => {
    const project = projectsList()[0];
    if (!project) {
      res.status(404).json({ error: 'no project configured' });
      return;
    }
    sessionTerminalsHandler(project, req, res);
  });

  app.post('/api/sessions', async (req: Request, res: Response) => {
    const project = projectsList()[0];
    if (!project) {
      res.status(404).json({ error: 'no project configured' });
      return;
    }
    await createSessionHandler(project, req, res);
  });

  app.delete('/api/sessions/:branch', async (req: Request, res: Response) => {
    const project = projectsList()[0];
    if (!project) {
      res.status(404).json({ error: 'no project configured' });
      return;
    }
    await deleteSessionHandler(project, req, res);
  });

  app.post('/api/sessions/:branch/pr', async (req: Request, res: Response) => {
    const project = projectsList()[0];
    if (!project) {
      res.status(404).json({ error: 'no project configured' });
      return;
    }
    await createPrHandler(project, req, res);
  });

  app.post('/api/sessions/:branch/ide', async (req: Request, res: Response) => {
    const project = projectsList()[0];
    if (!project) {
      res.status(404).json({ error: 'no project configured' });
      return;
    }
    await launchIdeHandler(project, req, res);
  });

  app.post('/api/sessions/:branch/resync-env', async (req: Request, res: Response) => {
    const project = projectsList()[0];
    if (!project) {
      res.status(404).json({ error: 'no project configured' });
      return;
    }
    await resyncEnvHandler(project, req, res);
  });

  app.post('/api/sessions/:branch/respawn', (req: Request, res: Response) => {
    const project = projectsList()[0];
    if (!project) {
      res.status(404).json({ error: 'no project configured' });
      return;
    }
    respawnHandler(project, req, res);
  });

  app.post(
    '/api/sessions/:branch/claude-continue',
    (req: Request, res: Response) => {
      const project = projectsList()[0];
      if (!project) {
        res.status(404).json({ error: 'no project configured' });
        return;
      }
      claudeContinueHandler(project, req, res);
    },
  );

  app.post(
    '/api/sessions/:branch/terminals/adhoc',
    (req: Request, res: Response) => {
      const project = projectsList()[0];
      if (!project) {
        res.status(404).json({ error: 'no project configured' });
        return;
      }
      adhocTerminalHandler(project, req, res);
    },
  );

  app.post(
    '/api/sessions/:branch/terminals/:name/restart',
    (req: Request, res: Response) => {
      const project = projectsList()[0];
      if (!project) {
        res.status(404).json({ error: 'no project configured' });
        return;
      }
      restartTerminalHandler(project, req, res);
    },
  );

  app.post(
    '/api/sessions/:branch/terminals/:name/kill',
    (req: Request, res: Response) => {
      const project = projectsList()[0];
      if (!project) {
        res.status(404).json({ error: 'no project configured' });
        return;
      }
      killTerminalHandler(project, req, res);
    },
  );

  // ============================================================
  // Project-id-keyed routes (preferred).
  // ============================================================

  app.get('/api/projects/:id', (req: Request, res: Response) => {
    const project = projectFromReq(req);
    if (!project) {
      res.status(404).json({ error: 'project not found' });
      return;
    }
    res.json({
      id: projectIdFor(project.path),
      path: project.path,
      name: project.name,
      ide: project.ide,
      sessions: project.sessions,
      terminals: terminalsFor(project),
      storedTerminals: project.terminals || [],
    });
  });

  app.get('/api/projects/:id/branches', async (req: Request, res: Response) => {
    const project = projectFromReq(req);
    if (!project) {
      res.status(404).json({ error: 'project not found' });
      return;
    }
    try {
      const branches = await listLocalAndRemoteBranches(project.path);
      res.json({ branches });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.put('/api/projects/:id/terminals', async (req: Request, res: Response) => {
    const project = projectFromReq(req);
    if (!project) {
      res.status(404).json({ error: 'project not found' });
      return;
    }
    try {
      const list = validateTerminals(req.body?.terminals);
      project.terminals = list;
      await store.save();
      await store.flush();
      store.broadcast({
        type: 'config-changed',
        projectPath: project.path,
        terminals: terminalsFor(project),
        storedTerminals: list,
      });
      res.json({ ok: true, storedTerminals: list, terminals: terminalsFor(project) });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.put('/api/projects/:id/ide', async (req: Request, res: Response) => {
    const project = projectFromReq(req);
    if (!project) {
      res.status(404).json({ error: 'project not found' });
      return;
    }
    const ide = typeof req.body?.ide === 'string' ? req.body.ide : '';
    project.ide = ide || undefined;
    await store.save();
    await store.flush();
    store.broadcast({ type: 'project-updated', projectPath: project.path });
    res.json({ ok: true, ide: project.ide || null });
  });

  app.post('/api/projects/:id/sessions', async (req: Request, res: Response) => {
    const project = projectFromReq(req);
    if (!project) {
      res.status(404).json({ error: 'project not found' });
      return;
    }
    await createSessionHandler(project, req, res);
  });

  app.delete(
    '/api/projects/:id/sessions/:branch',
    async (req: Request, res: Response) => {
      const project = projectFromReq(req);
      if (!project) {
        res.status(404).json({ error: 'project not found' });
        return;
      }
      await deleteSessionHandler(project, req, res);
    },
  );

  app.post(
    '/api/projects/:id/sessions/:branch/pr',
    async (req: Request, res: Response) => {
      const project = projectFromReq(req);
      if (!project) {
        res.status(404).json({ error: 'project not found' });
        return;
      }
      await createPrHandler(project, req, res);
    },
  );

  app.post(
    '/api/projects/:id/sessions/:branch/ide',
    async (req: Request, res: Response) => {
      const project = projectFromReq(req);
      if (!project) {
        res.status(404).json({ error: 'project not found' });
        return;
      }
      await launchIdeHandler(project, req, res);
    },
  );

  app.post(
    '/api/projects/:id/sessions/:branch/resync-env',
    async (req: Request, res: Response) => {
      const project = projectFromReq(req);
      if (!project) {
        res.status(404).json({ error: 'project not found' });
        return;
      }
      await resyncEnvHandler(project, req, res);
    },
  );

  app.post(
    '/api/projects/:id/sessions/:branch/respawn',
    (req: Request, res: Response) => {
      const project = projectFromReq(req);
      if (!project) {
        res.status(404).json({ error: 'project not found' });
        return;
      }
      respawnHandler(project, req, res);
    },
  );

  app.post(
    '/api/projects/:id/sessions/:branch/claude-continue',
    (req: Request, res: Response) => {
      const project = projectFromReq(req);
      if (!project) {
        res.status(404).json({ error: 'project not found' });
        return;
      }
      claudeContinueHandler(project, req, res);
    },
  );

  app.post(
    '/api/projects/:id/sessions/:branch/terminals/adhoc',
    (req: Request, res: Response) => {
      const project = projectFromReq(req);
      if (!project) {
        res.status(404).json({ error: 'project not found' });
        return;
      }
      adhocTerminalHandler(project, req, res);
    },
  );

  app.get(
    '/api/projects/:id/sessions/:branch/terminals',
    (req: Request, res: Response) => {
      const project = projectFromReq(req);
      if (!project) {
        res.status(404).json({ error: 'project not found' });
        return;
      }
      sessionTerminalsHandler(project, req, res);
    },
  );

  app.post(
    '/api/projects/:id/sessions/:branch/terminals/:name/restart',
    (req: Request, res: Response) => {
      const project = projectFromReq(req);
      if (!project) {
        res.status(404).json({ error: 'project not found' });
        return;
      }
      restartTerminalHandler(project, req, res);
    },
  );

  app.post(
    '/api/projects/:id/sessions/:branch/terminals/:name/kill',
    (req: Request, res: Response) => {
      const project = projectFromReq(req);
      if (!project) {
        res.status(404).json({ error: 'project not found' });
        return;
      }
      killTerminalHandler(project, req, res);
    },
  );

  app.get('/api/port-range', (_req: Request, res: Response) => {
    res.json({
      start: SEQUOIAS_PORT_RANGE_START,
      end: SEQUOIAS_PORT_RANGE_END,
    });
  });

  app.get('/api/kill-switch', async (_req: Request, res: Response) => {
    try {
      const result = await listListenersInSequoiasRange();
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  app.post('/api/kill-switch', async (req: Request, res: Response) => {
    try {
      const onlyPids = Array.isArray(req.body?.onlyPids)
        ? req.body.onlyPids.filter((p: unknown): p is number => typeof p === 'number')
        : undefined;
      const result = await killAllInSequoiasRange({ onlyPids });
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

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

  // ============================================================
  // Shared handlers
  // ============================================================

  function sessionTerminalsHandler(
    project: Project,
    req: Request,
    res: Response,
  ) {
    const branch = decodeURIComponent(String(req.params.branch));
    const session = project.sessions[branch];
    if (!session) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    const staticTerminals = terminalsFor(project);
    const staticNames = new Set(staticTerminals.map((t) => t.name));
    const runningEntries = ptyManager.listEntriesForBranch(project.path, branch);
    const runningSet = new Set(runningEntries.map((e) => e.name));
    const adhocTerminals = runningEntries
      .filter((e) => !staticNames.has(e.name))
      .map((e) => ({ ...e.terminal, ephemeral: true as const }));
    res.json({
      terminals: [
        ...staticTerminals.map((t) => ({
          ...t,
          running: runningSet.has(t.name),
        })),
        ...adhocTerminals.map((t) => ({ ...t, running: true })),
      ],
    });
  }

  async function createSessionHandler(
    project: Project,
    req: Request,
    res: Response,
  ) {
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
      ptyManager.spawnSession(project.path, session, terminalsFor(project));
      res.json({ session });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  }

  async function deleteSessionHandler(
    project: Project,
    req: Request,
    res: Response,
  ) {
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
  }

  async function createPrHandler(project: Project, req: Request, res: Response) {
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
  }

  async function launchIdeHandler(
    project: Project,
    req: Request,
    res: Response,
  ) {
    const branch = decodeURIComponent(String(req.params.branch));
    const session = project.sessions[branch];
    if (!session) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    const ide = project.ide || resolveGlobalConfig(store.data).idePath;
    if (!ide) {
      res.status(400).json({
        error:
          'no IDE configured (set globalConfig.idePath or pass --ide, or assign per-project ide)',
      });
      return;
    }
    try {
      await launchIde(ide, session.worktreePath);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  }

  async function resyncEnvHandler(
    project: Project,
    req: Request,
    res: Response,
  ) {
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
  }

  function respawnHandler(project: Project, req: Request, res: Response) {
    const branch = decodeURIComponent(String(req.params.branch));
    const session = project.sessions[branch];
    if (!session) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    ptyManager.spawnSession(project.path, session, terminalsFor(project));
    res.json({ ok: true });
  }

  function restartTerminalHandler(
    project: Project,
    req: Request,
    res: Response,
  ) {
    const branch = decodeURIComponent(String(req.params.branch));
    const name = decodeURIComponent(String(req.params.name));
    const session = project.sessions[branch];
    if (!session) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    const terminal = terminalsFor(project).find((t) => t.name === name);
    if (!terminal) {
      res.status(404).json({ error: `terminal "${name}" not configured` });
      return;
    }
    ptyManager.kill(project.path, branch, name);
    ptyManager.spawn(project.path, session, terminal);
    res.json({ ok: true });
  }

  function killTerminalHandler(project: Project, req: Request, res: Response) {
    const branch = decodeURIComponent(String(req.params.branch));
    const name = decodeURIComponent(String(req.params.name));
    const killed = ptyManager.kill(project.path, branch, name);
    res.json({ ok: true, killed });
  }

  function claudeContinueHandler(
    project: Project,
    req: Request,
    res: Response,
  ) {
    const branch = decodeURIComponent(String(req.params.branch));
    const session = project.sessions[branch];
    if (!session) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    const claudeTerminal = terminalsFor(project).find((t) => t.name === 'claude');
    if (!claudeTerminal) {
      res.status(500).json({ error: 'claude terminal not configured' });
      return;
    }
    ptyManager.kill(project.path, branch, 'claude');
    // The kill is async (SIGTERM → SIGKILL after 1s), but byKey was already
    // cleared synchronously inside kill(), so spawn() can re-bind the same
    // key immediately. Override the cmd so the new shell starts a resumed
    // claude session instead of a fresh one.
    ptyManager.spawn(project.path, session, {
      ...claudeTerminal,
      cmd: 'claude --continue',
    });
    res.json({ ok: true });
  }

  function adhocTerminalHandler(
    project: Project,
    req: Request,
    res: Response,
  ) {
    const branch = decodeURIComponent(String(req.params.branch));
    const session = project.sessions[branch];
    if (!session) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    const taken = new Set<string>();
    for (const t of terminalsFor(project)) taken.add(t.name);
    for (const e of ptyManager.listEntriesForBranch(project.path, branch)) {
      taken.add(e.name);
    }
    let n = 1;
    while (taken.has(`shell-${n}`)) n += 1;
    const name = `shell-${n}`;
    const entry = ptyManager.spawn(project.path, session, {
      name,
      cwd: '.',
      cmd: null,
      autostart: false,
      background: false,
      kind: 'pty',
    });
    if (!entry) {
      res.status(500).json({ error: 'failed to spawn terminal' });
      return;
    }
    res.json({ ok: true, name });
  }
}
