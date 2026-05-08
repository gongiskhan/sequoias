import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { registerRoutes } from './routes.js';
import { loadStore, ensureProject } from './store.js';
import { installHooks, restoreHooks } from './claude-hooks.js';
import { PtyManager } from './pty-manager.js';

export type ServerOptions = {
  repoPath: string;
  port: number;
  ide?: string;
};

export type RunningServer = {
  close(): Promise<void>;
};

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const store = await loadStore();
  const project = ensureProject(store, opts.repoPath, opts.ide);

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
    project,
    ide: opts.ide,
    ptyManager,
    serverPort: opts.port,
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/ws/terminal') {
      const branch = url.searchParams.get('branch');
      const terminal = url.searchParams.get('terminal') || 'claude';
      if (!branch) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        ptyManager.attach(branch, terminal, ws);
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
    server.listen(opts.port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    async close() {
      ptyManager.killAll();
      wss.clients.forEach((c) => c.terminate());
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await store.flush();
      await restoreHooks();
    },
  };
}
