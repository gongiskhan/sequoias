import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node-pty';
import type { IPty } from 'node-pty';
import type { WebSocket } from 'ws';
import type { Store } from './store.js';
import type { Session, SessionStatus } from './types.js';
import type { TerminalConfig } from './config.js';

type Entry = {
  pty: IPty;
  branch: string;
  projectPath: string;
  worktreePath: string;
  terminal: TerminalConfig;
  buffer: string[];
  lastOutputAt: number;
  sockets: Set<WebSocket>;
  fallbackTimer?: NodeJS.Timeout;
};

const MAX_BUFFER = 400;
const FALLBACK_IDLE_MS = 60_000;

export class PtyManager {
  private byKey = new Map<string, Entry>();
  private byCwd = new Map<string, Entry>();

  constructor(private store: Store, private serverPort: number) {}

  spawnSession(projectPath: string, session: Session, terminals: TerminalConfig[]): void {
    for (const terminal of terminals) {
      if (!terminal.autostart) continue;
      this.spawn(projectPath, session, terminal);
    }
  }

  spawn(projectPath: string, session: Session, terminal: TerminalConfig): Entry | null {
    const key = this.key(projectPath, session.branch, terminal.name);
    if (this.byKey.has(key)) return this.byKey.get(key)!;

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') env[k] = v;
    }
    for (const [k, v] of Object.entries(session.ports)) {
      env[`SEQUOIAS_PORT_${k.toUpperCase()}`] = String(v);
    }
    env['SEQUOIAS_SERVER_PORT'] = String(this.serverPort);
    env['SEQUOIAS_BRANCH'] = session.branch;
    env['SEQUOIAS_TERMINAL'] = terminal.name;

    const cwd = resolveCwd(session.worktreePath, terminal.cwd);
    if (!fs.existsSync(cwd)) {
      this.store.broadcast({
        type: 'terminal-error',
        projectPath,
        branch: session.branch,
        terminalName: terminal.name,
        error: `cwd does not exist: ${cwd}`,
      });
      return null;
    }

    const shell = process.env.SHELL || '/bin/zsh';
    let pty: IPty;
    try {
      pty = spawn(shell, ['-l'], {
        name: 'xterm-256color',
        cols: 120,
        rows: 32,
        cwd,
        env,
      });
    } catch (err) {
      this.store.broadcast({
        type: 'terminal-error',
        projectPath,
        branch: session.branch,
        terminalName: terminal.name,
        error: `pty spawn failed: ${(err as Error).message}`,
      });
      return null;
    }

    const entry: Entry = {
      pty,
      branch: session.branch,
      projectPath,
      worktreePath: session.worktreePath,
      terminal,
      buffer: [],
      lastOutputAt: Date.now(),
      sockets: new Set(),
    };

    pty.onData((data) => {
      entry.lastOutputAt = Date.now();
      entry.buffer.push(data);
      if (entry.buffer.length > MAX_BUFFER) entry.buffer.shift();
      for (const ws of entry.sockets) {
        if (ws.readyState === ws.OPEN) ws.send(data);
      }
    });

    pty.onExit(({ exitCode }) => {
      this.byKey.delete(key);
      if (entry.terminal.name === 'claude') {
        const status: SessionStatus = exitCode === 0 ? 'dead' : 'errored';
        this.store.setSessionStatus(projectPath, session.branch, status, 'pty-exit');
        if (cwd === session.worktreePath) this.byCwd.delete(cwd);
      }
      this.store.broadcast({
        type: 'terminal-exit',
        projectPath,
        branch: session.branch,
        terminalName: entry.terminal.name,
        exitCode,
      });
      for (const ws of entry.sockets) ws.close();
      if (entry.fallbackTimer) clearInterval(entry.fallbackTimer);
    });

    if (terminal.cmd) {
      pty.write(`${terminal.cmd}\r`);
    }

    if (terminal.name === 'claude') {
      this.byCwd.set(cwd, entry);
      entry.fallbackTimer = setInterval(() => {
        const sess = this.store.getProject(projectPath)?.sessions[session.branch];
        if (!sess) return;
        if (sess.lastStatus === 'working' && Date.now() - entry.lastOutputAt > FALLBACK_IDLE_MS) {
          this.store.setSessionStatus(projectPath, session.branch, 'idle', 'fallback');
        }
      }, 5_000);
      this.store.setSessionStatus(projectPath, session.branch, 'starting', 'spawn');
    }

    this.byKey.set(key, entry);
    this.store.broadcast({
      type: 'terminal-spawn',
      projectPath,
      branch: session.branch,
      terminalName: terminal.name,
    });
    return entry;
  }

  attach(branch: string, terminalName: string, ws: WebSocket): void {
    let entry: Entry | undefined;
    for (const e of this.byKey.values()) {
      if (e.branch === branch && e.terminal.name === terminalName) {
        entry = e;
        break;
      }
    }
    if (!entry) {
      ws.send(`\r\n\x1b[33m[${terminalName}] not running. Click restart to spawn it.\x1b[0m\r\n`);
      ws.close();
      return;
    }
    entry.sockets.add(ws);
    for (const chunk of entry.buffer) ws.send(chunk);
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'data' && typeof msg.data === 'string') {
          entry!.pty.write(msg.data);
        } else if (msg.type === 'resize' && msg.cols && msg.rows) {
          entry!.pty.resize(Number(msg.cols), Number(msg.rows));
        }
      } catch {
        entry!.pty.write(raw.toString());
      }
    });
    ws.on('close', () => entry!.sockets.delete(ws));
  }

  kill(projectPath: string, branch: string, terminalName: string): boolean {
    const key = this.key(projectPath, branch, terminalName);
    const entry = this.byKey.get(key);
    if (!entry) return false;
    if (entry.fallbackTimer) clearInterval(entry.fallbackTimer);
    try {
      entry.pty.kill();
    } catch {
      // ignore
    }
    for (const ws of entry.sockets) {
      try { ws.close(); } catch { /* ignore */ }
    }
    this.byKey.delete(key);
    if (entry.terminal.name === 'claude') {
      const cwd = resolveCwd(entry.worktreePath, entry.terminal.cwd);
      this.byCwd.delete(cwd);
    }
    return true;
  }

  killSession(projectPath: string, branch: string): void {
    const keysToKill: string[] = [];
    for (const [k, e] of this.byKey) {
      if (e.projectPath === projectPath && e.branch === branch) keysToKill.push(k);
    }
    for (const k of keysToKill) {
      const parts = k.split('::');
      const terminalName = parts[parts.length - 1];
      this.kill(projectPath, branch, terminalName);
    }
  }

  killAll(): void {
    for (const [, entry] of this.byKey) {
      if (entry.fallbackTimer) clearInterval(entry.fallbackTimer);
      try { entry.pty.kill(); } catch { /* ignore */ }
      for (const ws of entry.sockets) {
        try { ws.close(); } catch { /* ignore */ }
      }
    }
    this.byKey.clear();
    this.byCwd.clear();
  }

  isRunning(projectPath: string, branch: string, terminalName: string): boolean {
    return this.byKey.has(this.key(projectPath, branch, terminalName));
  }

  listRunning(projectPath: string, branch: string): string[] {
    const out: string[] = [];
    for (const e of this.byKey.values()) {
      if (e.projectPath === projectPath && e.branch === branch) out.push(e.terminal.name);
    }
    return out;
  }

  resolveByCwd(cwd: string): Entry | undefined {
    return this.byCwd.get(cwd);
  }

  private key(projectPath: string, branch: string, terminalName: string): string {
    return `${projectPath}::${branch}::${terminalName}`;
  }
}

function resolveCwd(worktreePath: string, terminalCwd: string): string {
  if (path.isAbsolute(terminalCwd)) return terminalCwd;
  return path.resolve(worktreePath, terminalCwd);
}
