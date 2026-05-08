import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import {
  readSettings,
  readWorktreeFile,
  startFixture,
  worktreeExists,
  type Fixture,
} from '../fixtures/fake-repo';

let fx: Fixture;

test.beforeEach(async () => {
  fx = await startFixture({ mockGh: true });
});

test.afterEach(async () => {
  if (fx) await fx.cleanup();
});

async function createSessionViaApi(branch: string, baseBranch?: string) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const body = JSON.stringify({ branch, baseBranch });
    const req = http.request(
      {
        host: '127.0.0.1',
        port: fx.serverPort,
        method: 'POST',
        path: '/api/sessions',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 0, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode || 0, body: { raw: data } });
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function deleteSessionViaApi(branch: string, deleteBranch = false) {
  return new Promise<number>((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: fx.serverPort,
        method: 'DELETE',
        path: `/api/sessions/${encodeURIComponent(branch)}?deleteBranch=${deleteBranch}`,
      },
      (res) => {
        res.on('data', () => undefined);
        res.on('end', () => resolve(res.statusCode || 0));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function fetchSessionPorts(branch: string) {
  return new Promise<Record<string, number>>((resolve, reject) => {
    http.get(
      {
        host: '127.0.0.1',
        port: fx.serverPort,
        path: '/api/project',
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          const parsed = JSON.parse(data);
          const session = parsed.sessions?.[branch];
          if (!session) reject(new Error(`session not found: ${branch}`));
          else resolve(session.ports);
        });
      },
    ).on('error', reject);
  });
}

async function createSessionViaUi(page: Page, branch: string) {
  await page.locator('[data-testid="new-session-btn"]').click();
  await page.locator('[data-testid="new-session-branch"]').fill(branch);
  await page.locator('[data-testid="new-session-submit"]').click();
}

test('1. boots and serves UI', async ({ page }) => {
  await page.goto(fx.serverUrl);
  await expect(page.locator('[data-testid="project-name"]')).toContainText(
    path.basename(fx.repoPath),
  );
});

test('2. creates a session with allocated ports', async ({ page }) => {
  await page.goto(fx.serverUrl);
  await createSessionViaUi(page, 'feature/auth');

  const card = page.locator('[data-testid="session-card-feature/auth"]');
  await expect(card).toBeVisible({ timeout: 8000 });
  await card.locator('.branch-name').click();
  await expect(page.locator('.main-header .ports')).toContainText(/cortex:\d+/, {
    timeout: 4000,
  });

  expect(
    worktreeExists(fx.tmpHome, fx.repoPath, 'feature-auth'),
  ).toBe(true);
});

test('3. env files are rewritten correctly (per-file scope)', async () => {
  const result = await createSessionViaApi('feature/envtest');
  expect(result.status).toBe(200);

  const rootEnv = readWorktreeFile(fx.tmpHome, fx.repoPath, 'feature-envtest', '.env');
  expect(rootEnv).toMatch(/^PORT=\d+$/m);
  expect(rootEnv).not.toMatch(/^PORT=3000$/m);

  const cortexEnv = readWorktreeFile(
    fx.tmpHome,
    fx.repoPath,
    'feature-envtest',
    'cortex/.env',
  );
  expect(cortexEnv).toMatch(/^CORTEX_PORT=\d+$/m);
  expect(cortexEnv).not.toContain('NEXT_PUBLIC_PORT');
});

test('4. same branch produces same ports across recreate', async () => {
  await createSessionViaApi('feature/stable');
  const first = await fetchSessionPorts('feature/stable');
  await deleteSessionViaApi('feature/stable', true);
  await createSessionViaApi('feature/stable');
  const second = await fetchSessionPorts('feature/stable');
  expect(second).toEqual(first);
});

test('5. different branches produce non-overlapping ports', async () => {
  await createSessionViaApi('feature/a');
  await createSessionViaApi('feature/b');
  const a = await fetchSessionPorts('feature/a');
  const b = await fetchSessionPorts('feature/b');
  const portsA = new Set(Object.values(a));
  for (const port of Object.values(b)) {
    expect(portsA.has(port)).toBe(false);
  }
});

test('6. Stop hook flips status to idle', async ({ page }) => {
  await page.goto(fx.serverUrl);
  await createSessionViaUi(page, 'feature/idle');
  const card = page.locator('[data-testid="session-card-feature/idle"]');
  await expect(card).toBeVisible({ timeout: 8000 });

  const ports = await fetchSessionPorts('feature/idle');
  expect(ports).toBeTruthy();

  const wtPath = path.join(
    fx.tmpHome,
    '.worktrees',
    path.basename(fx.repoPath),
    'feature-idle',
  );
  await fx.postHook('Stop', wtPath);

  await expect(
    card.locator('[data-testid="status-label"]'),
  ).toHaveText('Idle', { timeout: 10_000 });
});

test('7. Notification hook flips status to waiting', async ({ page }) => {
  await page.goto(fx.serverUrl);
  await createSessionViaUi(page, 'feature/wait');
  const card = page.locator('[data-testid="session-card-feature/wait"]');
  await expect(card).toBeVisible({ timeout: 8000 });

  const wtPath = path.join(
    fx.tmpHome,
    '.worktrees',
    path.basename(fx.repoPath),
    'feature-wait',
  );
  await fx.postHook('Notification', wtPath);

  await expect(
    card.locator('[data-testid="status-label"]'),
  ).toHaveText('Waiting', { timeout: 10_000 });
});

test('8. sessions sort by status priority', async ({ page }) => {
  await page.goto(fx.serverUrl);
  await createSessionViaUi(page, 'feature/sort-a');
  await page.waitForTimeout(500);
  await createSessionViaUi(page, 'feature/sort-b');
  await expect(
    page.locator('[data-testid="session-card-feature/sort-b"]'),
  ).toBeVisible({ timeout: 8000 });

  const wtA = path.join(
    fx.tmpHome,
    '.worktrees',
    path.basename(fx.repoPath),
    'feature-sort-a',
  );
  const wtB = path.join(
    fx.tmpHome,
    '.worktrees',
    path.basename(fx.repoPath),
    'feature-sort-b',
  );
  await fx.postHook('Stop', wtA);
  await fx.postHook('Notification', wtB);

  await expect(
    page.locator('[data-testid="session-card-feature/sort-b"] [data-testid="status-label"]'),
  ).toHaveText('Waiting');

  const cards = page.locator('[data-testid^="session-card-"]');
  const branches = await cards.evaluateAll((els) =>
    els.map((e) => (e as HTMLElement).getAttribute('data-branch')),
  );
  expect(branches[0]).toBe('feature/sort-b');
});

test('9. PR button calls gh and surfaces URL', async ({ page }) => {
  await page.goto(fx.serverUrl);
  await createSessionViaUi(page, 'feature/pr');
  const card = page.locator('[data-testid="session-card-feature/pr"]');
  await expect(card).toBeVisible({ timeout: 8000 });

  // Make a commit so push has something to push.
  const wtPath = path.join(
    fx.tmpHome,
    '.worktrees',
    path.basename(fx.repoPath),
    'feature-pr',
  );
  fs.writeFileSync(path.join(wtPath, 'README.md'), 'hello');
  // git commit via execa imported lazily? Use sync exec.
  const { execSync } = await import('node:child_process');
  execSync('git add . && git commit -q -m wip', { cwd: wtPath });

  // Click the PR button.
  await page.locator('[data-testid="pr-btn-feature/pr"]').click();
  await expect(
    page.locator('[data-testid="pr-link-feature/pr"]'),
  ).toContainText('https://github.com/test/repo/pull/123', { timeout: 5000 });
});

test('10. archive removes session and worktree', async ({ page }) => {
  await page.goto(fx.serverUrl);
  await createSessionViaUi(page, 'feature/arch');
  await expect(
    page.locator('[data-testid="session-card-feature/arch"]'),
  ).toBeVisible({ timeout: 8000 });

  const status = await deleteSessionViaApi('feature/arch', true);
  expect(status).toBe(200);

  await expect(
    page.locator('[data-testid="session-card-feature/arch"]'),
  ).toHaveCount(0, { timeout: 5000 });
  expect(worktreeExists(fx.tmpHome, fx.repoPath, 'feature-arch')).toBe(false);

  const stateRaw = fs.readFileSync(
    path.join(fx.tmpHome, '.sequoias', 'state.json'),
    'utf8',
  );
  expect(stateRaw).not.toContain('feature/arch');
});

test('11. hooks are restored byte-identical on shutdown', async () => {
  // Snapshot current state (server is running so hooks are installed).
  // Bring server down via cleanup; before cleanup, pre-write a known fixture.
  // Restart approach: write a known fixture, restart server pointing at same home,
  // then shutdown again and compare.
  // (The fixture already created an empty home; settings.json was created by
  //  installHooks. We assert that on shutdown the file goes back to its
  //  pre-Sequoias state.)
  const settingsPath = path.join(fx.tmpHome, '.claude', 'settings.json');

  // Write a known baseline, save its bytes, restart server with that home,
  // then shutdown and compare bytes.
  const baseline = JSON.stringify(
    {
      model: 'sonnet',
      hooks: {
        PreToolUse: [
          { matcher: '', hooks: [{ type: 'command', command: 'echo pre' }] },
        ],
      },
    },
    null,
    2,
  );
  // First, stop the existing server to clear its hook footprint.
  await fx.cleanup();

  const tmpHomeBase = path.dirname(fx.tmpHome);
  // Create a fresh tmpHome with our baseline.
  const fsp = await import('node:fs/promises');
  const newHome = await fsp.mkdtemp(path.join(tmpHomeBase, 'sequoias-hooks-'));
  await fsp.mkdir(path.join(newHome, '.claude'), { recursive: true });
  await fsp.writeFile(path.join(newHome, '.claude/settings.json'), baseline);
  const sumBefore = crypto.createHash('sha256').update(baseline).digest('hex');

  // Manually start a server using the fixture machinery — but pointed at this home.
  // Easiest: spawn directly here.
  const { execa } = await import('execa');
  const repoPath = await fsp.mkdtemp(path.join(tmpHomeBase, 'sequoias-repo-h-'));
  await execa('git', ['init', '-q', '-b', 'main'], { cwd: repoPath });
  await execa('git', ['config', 'user.email', 't@t'], { cwd: repoPath });
  await execa('git', ['config', 'user.name', 't'], { cwd: repoPath });
  await fsp.writeFile(path.join(repoPath, 'README.md'), 'x');
  await execa('git', ['add', '.'], { cwd: repoPath });
  await execa('git', ['commit', '-q', '-m', 'init'], { cwd: repoPath });

  const port = 19500 + Math.floor(Math.random() * 100);
  const { spawn } = await import('node:child_process');
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v;
  }
  env.HOME = newHome;
  env.SEQUOIAS_AUTO_CLAUDE = '0';
  const proc = spawn(
    process.execPath,
    [path.resolve('dist/server/cli.js'), repoPath, '--port', String(port), '--host', '127.0.0.1'],
    { cwd: path.resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  // Wait for ready
  await waitForLocalPort(port);

  // Verify hooks were installed (must contain _sequoias)
  const installed = fs.readFileSync(
    path.join(newHome, '.claude/settings.json'),
    'utf8',
  );
  expect(installed).toContain('_sequoias');

  // Shutdown
  proc.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    proc.on('exit', () => resolve());
    setTimeout(() => resolve(), 4000);
  });

  const after = fs.readFileSync(
    path.join(newHome, '.claude/settings.json'),
    'utf8',
  );
  const sumAfter = crypto.createHash('sha256').update(after).digest('hex');

  expect(sumAfter).toBe(sumBefore);

  // Mark fx as already-cleaned to avoid double-cleanup in afterEach.
  fx = {
    ...fx,
    cleanup: async () => {
      await fsp.rm(newHome, { recursive: true, force: true });
      await fsp.rm(repoPath, { recursive: true, force: true });
    },
  } as Fixture;
});

test('12. survives server restart with sessions intact', async () => {
  await createSessionViaApi('feature/restart');
  const portsBefore = await fetchSessionPorts('feature/restart');

  // Stop the server but keep the home and repo.
  fx.serverProc.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    fx.serverProc.on('exit', () => resolve());
    setTimeout(() => resolve(), 4000);
  });

  const port = fx.serverPort + 1000;
  const { spawn } = await import('node:child_process');
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v;
  }
  env.HOME = fx.tmpHome;
  env.SEQUOIAS_AUTO_CLAUDE = '0';
  const proc = spawn(
    process.execPath,
    [path.resolve('dist/server/cli.js'), fx.repoPath, '--port', String(port), '--host', '127.0.0.1'],
    { cwd: path.resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  await waitForLocalPort(port);

  // Read project from new server.
  const got = await new Promise<any>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/project' }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
  expect(got.sessions['feature/restart']).toBeTruthy();
  expect(got.sessions['feature/restart'].ports).toEqual(portsBefore);
  expect(got.sessions['feature/restart'].lastStatus).toBe('dead');

  proc.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    proc.on('exit', () => resolve());
    setTimeout(() => resolve(), 4000);
  });

  // Replace fx.serverProc so afterEach cleanup doesn't try to kill old one.
  fx.serverProc = proc;
});

test('13. allocator linear-probes when bind-port already in use', async () => {
  // Bind a port deterministically — first compute basePort for our branch and
  // bind it, then create the session; expect a different port to be assigned.
  const { basePort, SEQUOIAS_PORT_RANGE_START, SEQUOIAS_PORT_RANGE_END } =
    await import('../../src/ports.js');
  const branch = 'feature/probe';
  const expectedFirst = basePort(branch, 'cortex');

  const blocker = net.createServer().listen(expectedFirst, '127.0.0.1');
  await new Promise<void>((resolve) => blocker.once('listening', () => resolve()));

  try {
    await createSessionViaApi(branch);
    const ports = await fetchSessionPorts(branch);
    expect(ports.cortex).not.toBe(expectedFirst);
    expect(ports.cortex).toBeGreaterThanOrEqual(SEQUOIAS_PORT_RANGE_START);
    expect(ports.cortex).toBeLessThanOrEqual(SEQUOIAS_PORT_RANGE_END);
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
});

test('14. terminal IO round-trips through xterm and WS', async ({ page }) => {
  await page.goto(fx.serverUrl);
  await createSessionViaUi(page, 'feature/term');
  const card = page.locator('[data-testid="session-card-feature/term"]');
  await expect(card).toBeVisible({ timeout: 8000 });
  await card.click();

  await expect(page.locator('[data-testid="terminal-host"]')).toBeVisible();
  // give pty time to attach + spawn shell prompt
  await page.waitForTimeout(1500);
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('echo hello-from-test-7c9d');
  await page.keyboard.press('Enter');

  await expect(page.locator('.xterm-screen')).toContainText('hello-from-test-7c9d', {
    timeout: 8000,
  });
});

test('15. global config round-trips through PATCH /api/global-config', async () => {
  await new Promise<void>((resolve, reject) => {
    const body = JSON.stringify({ theme: 'dark', idePath: 'rebased' });
    const req = http.request(
      {
        host: '127.0.0.1',
        port: fx.serverPort,
        method: 'PATCH',
        path: '/api/global-config',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        res.on('data', () => undefined);
        res.on('end', () => {
          expect(res.statusCode).toBe(200);
          resolve();
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  const fetched = await new Promise<any>((resolve, reject) => {
    http.get(
      { host: '127.0.0.1', port: fx.serverPort, path: '/api/global-config' },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve(JSON.parse(d)));
      },
    ).on('error', reject);
  });
  expect(fetched.theme).toBe('dark');
  expect(fetched.idePath).toBe('rebased');

  // Verify it is persisted to state.json
  const stateRaw = fs.readFileSync(
    path.join(fx.tmpHome, '.sequoias', 'state.json'),
    'utf8',
  );
  const parsed = JSON.parse(stateRaw);
  expect(parsed.globalConfig.theme).toBe('dark');
  expect(parsed.globalConfig.idePath).toBe('rebased');
});

test('16. multi-project: POST /api/projects adds a second project', async () => {
  const fsp = await import('node:fs/promises');
  const { execa } = await import('execa');
  const tmpHomeBase = path.dirname(fx.tmpHome);
  const repo2 = await fsp.mkdtemp(path.join(tmpHomeBase, 'sequoias-repo2-'));
  await execa('git', ['init', '-q', '-b', 'main'], { cwd: repo2 });
  await execa('git', ['config', 'user.email', 't@t'], { cwd: repo2 });
  await execa('git', ['config', 'user.name', 't'], { cwd: repo2 });
  await fsp.writeFile(path.join(repo2, 'README.md'), 'x');
  await execa('git', ['add', '.'], { cwd: repo2 });
  await execa('git', ['commit', '-q', '-m', 'init'], { cwd: repo2 });

  const result = await new Promise<{ status: number; body: any }>((resolve, reject) => {
    const body = JSON.stringify({ path: repo2 });
    const req = http.request(
      {
        host: '127.0.0.1',
        port: fx.serverPort,
        method: 'POST',
        path: '/api/projects',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode || 0, body: JSON.parse(d) }); }
          catch { resolve({ status: res.statusCode || 0, body: { raw: d } }); }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
  expect(result.status).toBe(200);
  expect(result.body.id).toMatch(/^[0-9a-f]{8}$/);

  const state = await new Promise<any>((resolve, reject) => {
    http.get(
      { host: '127.0.0.1', port: fx.serverPort, path: '/api/state' },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve(JSON.parse(d)));
      },
    ).on('error', reject);
  });
  expect(Object.keys(state.projects).length).toBe(2);
  expect(state.projects[fx.repoPath]).toBeTruthy();
  expect(state.projects[repo2]).toBeTruthy();
  expect(state.globalConfig.projects).toEqual(
    expect.arrayContaining([fx.repoPath, repo2]),
  );

  await fsp.rm(repo2, { recursive: true, force: true });
});

test('17. JSONL tab streams formatted events from the active transcript', async () => {
  const fsp = await import('node:fs/promises');
  const branch = 'feature/jsonl';
  const result = await createSessionViaApi(branch);
  expect(result.status).toBe(200);

  const wtPath = path.join(
    fx.tmpHome,
    '.worktrees',
    path.basename(fx.repoPath),
    'feature-jsonl',
  );

  // Compose the same path encoding as the server: replace both / and . with -.
  const escaped = wtPath.replace(/[/.]/g, '-');
  const projectDir = path.join(fx.tmpHome, '.claude', 'projects', escaped);
  await fsp.mkdir(projectDir, { recursive: true });
  const transcriptFile = path.join(projectDir, 'sess-1.jsonl');
  await fsp.writeFile(
    transcriptFile,
    [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'jsonl-tab-probe-9f3' },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'jsonl-response-token-7c2' }],
        },
      }),
      '',
    ].join('\n'),
  );

  // Connect the WS terminal stream for the claude-live tab.
  const { WebSocket } = await import('ws');
  const ws = new WebSocket(
    `ws://127.0.0.1:${fx.serverPort}/ws/terminal?branch=${encodeURIComponent(branch)}&terminal=claude-live`,
  );
  const chunks: string[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
    setTimeout(() => reject(new Error('ws open timeout')), 4000);
  });
  ws.on('message', (data) => {
    chunks.push(data.toString());
  });

  // Wait up to 5s for both probe strings to surface.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const joined = chunks.join('');
    if (joined.includes('jsonl-tab-probe-9f3') && joined.includes('jsonl-response-token-7c2')) {
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  ws.close();
  const joined = chunks.join('');
  expect(joined).toContain('jsonl-tab-probe-9f3');
  expect(joined).toContain('jsonl-response-token-7c2');
});

test('18. JSONL tab lazy-spawns for sessions loaded from state on restart', async () => {
  // Create a session, then restart the server. The session is loaded from
  // state.json with lastStatus=dead and no in-memory entries. Connecting to
  // claude-live should still work — it must lazy-spawn on attach.
  const fsp = await import('node:fs/promises');
  const branch = 'feature/lazy-jsonl';
  const result = await createSessionViaApi(branch);
  expect(result.status).toBe(200);

  const wtPath = path.join(
    fx.tmpHome,
    '.worktrees',
    path.basename(fx.repoPath),
    'feature-lazy-jsonl',
  );
  const escaped = wtPath.replace(/[/.]/g, '-');
  const projectDir = path.join(fx.tmpHome, '.claude', 'projects', escaped);
  await fsp.mkdir(projectDir, { recursive: true });
  await fsp.writeFile(
    path.join(projectDir, 'sess.jsonl'),
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'lazy-jsonl-token-4dx' },
    }) + '\n',
  );

  // Restart the server pointed at the same HOME / repo.
  fx.serverProc.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    fx.serverProc.on('exit', () => resolve());
    setTimeout(() => resolve(), 4000);
  });
  const port = fx.serverPort + 2000;
  const { spawn } = await import('node:child_process');
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v;
  }
  env.HOME = fx.tmpHome;
  env.SEQUOIAS_AUTO_CLAUDE = '0';
  const proc = spawn(
    process.execPath,
    [path.resolve('dist/server/cli.js'), fx.repoPath, '--port', String(port), '--host', '127.0.0.1'],
    { cwd: path.resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  await waitForLocalPort(port);

  const { WebSocket } = await import('ws');
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/ws/terminal?branch=${encodeURIComponent(branch)}&terminal=claude-live`,
  );
  const chunks: string[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
    setTimeout(() => reject(new Error('ws open timeout')), 4000);
  });
  ws.on('message', (data) => {
    chunks.push(data.toString());
  });

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (chunks.join('').includes('lazy-jsonl-token-4dx')) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  ws.close();
  expect(chunks.join('')).toContain('lazy-jsonl-token-4dx');

  proc.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    proc.on('exit', () => resolve());
    setTimeout(() => resolve(), 4000);
  });
  fx.serverProc = proc;
});

async function waitForLocalPort(port: number, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      http.get(
        { host: '127.0.0.1', port, path: '/api/state' },
        (res) => {
          res.resume();
          resolve((res.statusCode || 0) < 500);
        },
      ).on('error', () => resolve(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`port ${port} did not become ready`);
}
