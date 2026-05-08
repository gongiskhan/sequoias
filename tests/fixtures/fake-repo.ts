import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';

export type Fixture = {
  repoPath: string;
  tmpHome: string;
  serverPort: number;
  serverUrl: string;
  serverProc: ChildProcess;
  ghLogPath: string;
  cleanup(): Promise<void>;
  postHook(event: string, cwd: string): Promise<void>;
};

export async function makeFakeRepo(): Promise<{ repoPath: string; originPath: string }> {
  const repoPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'sequoias-repo-'));
  const originPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'sequoias-origin-'));

  await execa('git', ['init', '-q', '--bare', '-b', 'main', originPath], { cwd: '/' });

  const cwd = repoPath;
  await execa('git', ['init', '-q', '-b', 'main'], { cwd });
  await execa('git', ['config', 'user.email', 'test@example.com'], { cwd });
  await execa('git', ['config', 'user.name', 'Test'], { cwd });
  await execa('git', ['remote', 'add', 'origin', originPath], { cwd });

  const rootEnv = [
    'PORT=3000',
    'CORTEX_PORT=4143',
    'NEXT_PUBLIC_CORTEX_URL=http://localhost:4143',
  ].join('\n');
  await fsp.writeFile(path.join(repoPath, '.env'), rootEnv);

  await fsp.mkdir(path.join(repoPath, 'cortex'));
  await fsp.writeFile(
    path.join(repoPath, 'cortex/.env'),
    'CORTEX_PORT=4143\nNEXT_PUBLIC_CORTEX_URL=http://localhost:4143\n',
  );

  await fsp.mkdir(path.join(repoPath, 'ekoa-app'));
  await fsp.writeFile(
    path.join(repoPath, 'ekoa-app/.env'),
    'NEXT_PUBLIC_PORT=5173\nNEXT_PUBLIC_CORTEX_URL=http://localhost:4143\n',
  );

  await execa('git', ['add', '.'], { cwd });
  await execa('git', ['commit', '-q', '-m', 'init'], { cwd });
  await execa('git', ['push', '-q', '-u', 'origin', 'main'], { cwd });
  return { repoPath, originPath };
}

let basePort = 17800;
function nextPort(): number {
  return basePort++;
}

async function rmRetry(dir: string, attempts = 4): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await fsp.rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i === attempts - 1) return; // give up silently
      await new Promise((r) => setTimeout(r, 100 * (i + 1)));
    }
  }
}

async function waitForServer(url: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: Error | null = null;
  while (Date.now() < deadline) {
    try {
      const ok = await new Promise<boolean>((resolve) => {
        const req = http.get(url + '/api/state', (res) => {
          res.resume();
          resolve((res.statusCode || 0) < 500);
        });
        req.on('error', () => resolve(false));
        req.setTimeout(500, () => {
          req.destroy();
          resolve(false);
        });
      });
      if (ok) return;
    } catch (e) {
      lastErr = e as Error;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server at ${url} did not become ready: ${lastErr?.message ?? ''}`);
}

export type StartFixtureOptions = {
  /** Insert mock `gh` into PATH before launching server. */
  mockGh?: boolean;
};

export async function startFixture(
  options: StartFixtureOptions = {},
): Promise<Fixture> {
  const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'sequoias-home-'));
  await fsp.mkdir(path.join(tmpHome, '.claude'), { recursive: true });
  await fsp.mkdir(path.join(tmpHome, '.sequoias'), { recursive: true });

  const { repoPath, originPath } = await makeFakeRepo();
  const serverPort = nextPort();
  const serverUrl = `http://127.0.0.1:${serverPort}`;
  const ghLogPath = path.join(tmpHome, 'gh-calls.log');

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v;
  }
  env.HOME = tmpHome;
  env.SEQUOIAS_AUTO_CLAUDE = '0';

  if (options.mockGh) {
    const mockBin = path.join(tmpHome, 'mock-bin');
    await fsp.mkdir(mockBin, { recursive: true });
    const ghScript = `#!/bin/bash
echo "$@" >> "${ghLogPath}"
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  echo "https://github.com/test/repo/pull/123"
  exit 0
fi
exit 0
`;
    await fsp.writeFile(path.join(mockBin, 'gh'), ghScript, { mode: 0o755 });
    env.PATH = `${mockBin}:${env.PATH}`;
  }

  const serverProc = spawn(
    process.execPath,
    [path.resolve('dist/server/cli.js'), repoPath, '--port', String(serverPort)],
    {
      cwd: path.resolve('.'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  serverProc.stdout?.on('data', (chunk) => {
    process.stdout.write(`[server:${serverPort}] ${chunk}`);
  });
  serverProc.stderr?.on('data', (chunk) => {
    process.stderr.write(`[server:${serverPort}] ${chunk}`);
  });

  await waitForServer(serverUrl);

  const postHook = async (event: string, cwd: string): Promise<void> => {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ event, cwd });
      const req = http.request(
        {
          host: '127.0.0.1',
          port: serverPort,
          method: 'POST',
          path: '/_hook',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          res.on('data', () => undefined);
          res.on('end', () => resolve());
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  };

  return {
    repoPath,
    tmpHome,
    serverPort,
    serverUrl,
    serverProc,
    ghLogPath,
    postHook,
    async cleanup() {
      if (!serverProc.killed) {
        serverProc.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          let done = false;
          serverProc.on('exit', () => {
            if (!done) {
              done = true;
              resolve();
            }
          });
          setTimeout(() => {
            if (!done) {
              done = true;
              try {
                serverProc.kill('SIGKILL');
              } catch {
                // ignore
              }
              resolve();
            }
          }, 3000);
        });
      }
      await rmRetry(tmpHome);
      await rmRetry(repoPath);
      await rmRetry(originPath);
    },
  };
}

export function readSettings(tmpHome: string): string | null {
  const p = path.join(tmpHome, '.claude', 'settings.json');
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

export function readWorktreeFile(
  tmpHome: string,
  repoPath: string,
  branchSlug: string,
  rel: string,
): string {
  const repoName = path.basename(repoPath);
  return fs.readFileSync(
    path.join(tmpHome, '.worktrees', repoName, branchSlug, rel),
    'utf8',
  );
}

export function worktreeExists(
  tmpHome: string,
  repoPath: string,
  branchSlug: string,
): boolean {
  const repoName = path.basename(repoPath);
  return fs.existsSync(path.join(tmpHome, '.worktrees', repoName, branchSlug));
}
