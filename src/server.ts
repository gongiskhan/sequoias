import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { registerRoutes } from './routes.js';
import { loadStore, ensureProject, resolveGlobalConfig } from './store.js';
import { installHooks, restoreHooks } from './claude-hooks.js';
import { PtyManager } from './pty-manager.js';
import { resyncEnvFiles } from './worktree.js';
import { isPortInSequoiasRange } from './ports.js';

export type ServerOptions = {
  repoPath?: string;
  port: number;
  ide?: string;
  host?: string;
};

export type RunningServer = {
  close(): Promise<void>;
  host: string;
  projectPaths: string[];
};

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const store = await loadStore();

  if (opts.repoPath) {
    ensureProject(store, opts.repoPath, opts.ide);
    const list = store.data.globalConfig?.projects || [];
    if (!list.includes(opts.repoPath)) {
      store.setGlobalConfig({ projects: [...list, opts.repoPath] });
    }
  }

  const resolvedConfig = resolveGlobalConfig(store.data);
  for (const p of resolvedConfig.projects) {
    if (!store.data.projects[p]) {
      try {
        ensureProject(store, p);
      } catch (err) {
        process.stderr.write(
          `warning: failed to load project ${p}: ${(err as Error).message}\n`,
        );
      }
    }
  }

  // Auto-heal sessions whose stored ports exceed the TCP range. Pre-fix builds
  // of the allocator could land services in bands up to 105000; their env files
  // have invalid port values that bind would reject, and apps fall back to
  // hardcoded defaults that collide with the main checkout.
  for (const [projectPath, project] of Object.entries(store.data.projects)) {
    for (const session of Object.values(project.sessions)) {
      const bad = Object.entries(session.ports).filter(
        ([, v]) =>
          !Number.isFinite(v) || v <= 0 || !isPortInSequoiasRange(v),
      );
      if (bad.length === 0) continue;
      try {
        const result = await resyncEnvFiles({
          repoPath: project.path,
          worktreePath: session.worktreePath,
          branch: session.branch,
          existingPorts: session.ports,
          forceRecopy: true,
        });
        session.ports = result.ports;
        session.envFiles = result.envFiles;
        process.stdout.write(
          `auto-healed ${session.branch}: invalid ports (${bad
            .map(([k, v]) => `${k}=${v}`)
            .join(', ')}) -> ${Object.entries(result.ports)
            .map(([k, v]) => `${k}=${v}`)
            .join(', ')}\n`,
        );
      } catch (err) {
        process.stderr.write(
          `warning: failed to auto-heal ${projectPath}#${session.branch}: ${(err as Error).message}\n`,
        );
      }
    }
  }
  await store.flush();

  const host = opts.host || resolvedConfig.host || '0.0.0.0';

  await installHooks(opts.port);

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const uiDist = path.resolve(__dirname, '../ui');

  if (fs.existsSync(uiDist)) {
    app.use(express.static(uiDist));
  }

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  const ptyManager = new PtyManager(store, opts.port);

  registerRoutes(app, {
    store,
    ptyManager,
    serverPort: opts.port,
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/ws/terminal') {
      const branch = url.searchParams.get('branch');
      const terminal = url.searchParams.get('terminal') || 'claude';
      const projectId = url.searchParams.get('project') || undefined;
      if (!branch) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        ptyManager.attach(branch, terminal, ws, projectId);
      });
    } else if (url.pathname === '/ws/events') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        store.subscribe(ws);
      });
    } else {
      socket.destroy();
    }
  });

  if (fs.existsSync(uiDist)) {
    app.get(/.*/, (_req, res) => {
      res.sendFile(path.join(uiDist, 'index.html'));
    });
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    host,
    projectPaths: Object.keys(store.data.projects),
    async close() {
      ptyManager.killAll();
      wss.clients.forEach((c) => c.terminate());
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await store.flush();
      await restoreHooks();
    },
  };
}
