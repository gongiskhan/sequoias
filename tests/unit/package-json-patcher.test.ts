import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { patchFrontendDevScripts } from '../../src/package-json-patcher.js';

async function tmpWorktree(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'pkg-patcher-'));
}

async function writePkg(
  worktree: string,
  subdir: string,
  json: object,
): Promise<string> {
  const dir = path.join(worktree, subdir);
  await fsp.mkdir(dir, { recursive: true });
  const p = path.join(dir, 'package.json');
  await fsp.writeFile(p, JSON.stringify(json, null, 2) + '\n');
  return p;
}

test('patcher: rewrites ${PORT:-N} AND injects -p into next dev', async () => {
  const wt = await tmpWorktree();
  try {
    const p = await writePkg(wt, 'ekoa-app', {
      name: 'ekoa-app',
      scripts: {
        dev: '../scripts/kill-port.sh ${PORT:-3000} && next dev --hostname 0.0.0.0',
      },
    });
    const modified = await patchFrontendDevScripts(wt);
    assert.deepEqual(modified, ['ekoa-app/package.json']);
    const after = JSON.parse(await fsp.readFile(p, 'utf8'));
    // Both rewrites apply: kill-port arg gets the fallback chain, AND
    // next dev gets an explicit -p flag (without it, Next.js binds 3000
    // by default regardless of what kill-port saw).
    assert.equal(
      after.scripts.dev,
      '../scripts/kill-port.sh ${PORT:-${SEQUOIAS_FRONTEND_PORT:-3000}} && next dev -p ${PORT:-${SEQUOIAS_FRONTEND_PORT:-3000}} --hostname 0.0.0.0',
    );
  } finally {
    await fsp.rm(wt, { recursive: true, force: true });
  }
});

test('patcher: idempotent — second run is a no-op', async () => {
  const wt = await tmpWorktree();
  try {
    await writePkg(wt, 'ekoa-app', {
      name: 'ekoa-app',
      scripts: { dev: 'next dev -p ${PORT:-3000}' },
    });
    const first = await patchFrontendDevScripts(wt);
    assert.equal(first.length, 1);
    const second = await patchFrontendDevScripts(wt);
    assert.deepEqual(second, []);
  } finally {
    await fsp.rm(wt, { recursive: true, force: true });
  }
});

test('patcher: only touches frontend-aliased dirs (cortex left alone)', async () => {
  const wt = await tmpWorktree();
  try {
    const cortexPath = await writePkg(wt, 'cortex', {
      name: 'cortex',
      scripts: { dev: 'tsx watch src/index.ts && echo ${PORT:-4111}' },
    });
    const cortexBefore = await fsp.readFile(cortexPath, 'utf8');
    const modified = await patchFrontendDevScripts(wt);
    assert.deepEqual(modified, []);
    const cortexAfter = await fsp.readFile(cortexPath, 'utf8');
    assert.equal(cortexBefore, cortexAfter);
  } finally {
    await fsp.rm(wt, { recursive: true, force: true });
  }
});

test('patcher: rewrites multiple matches in the same script', async () => {
  const wt = await tmpWorktree();
  try {
    const p = await writePkg(wt, 'web', {
      name: 'web',
      scripts: {
        dev: '../scripts/kill-port.sh ${PORT:-3000} && next dev -p ${PORT:-3000}',
      },
    });
    await patchFrontendDevScripts(wt);
    const after = JSON.parse(await fsp.readFile(p, 'utf8'));
    assert.equal(
      after.scripts.dev,
      '../scripts/kill-port.sh ${PORT:-${SEQUOIAS_FRONTEND_PORT:-3000}} && next dev -p ${PORT:-${SEQUOIAS_FRONTEND_PORT:-3000}}',
    );
  } finally {
    await fsp.rm(wt, { recursive: true, force: true });
  }
});

test('patcher: rewrites multiple scripts independently', async () => {
  const wt = await tmpWorktree();
  try {
    const p = await writePkg(wt, 'frontend', {
      name: 'frontend',
      scripts: {
        dev: 'next dev -p ${PORT:-3000}',
        start: 'next start -p ${PORT:-3000}',
        build: 'next build', // no PORT — leave alone
      },
    });
    await patchFrontendDevScripts(wt);
    const after = JSON.parse(await fsp.readFile(p, 'utf8'));
    assert.equal(after.scripts.dev, 'next dev -p ${PORT:-${SEQUOIAS_FRONTEND_PORT:-3000}}');
    assert.equal(after.scripts.start, 'next start -p ${PORT:-${SEQUOIAS_FRONTEND_PORT:-3000}}');
    assert.equal(after.scripts.build, 'next build');
  } finally {
    await fsp.rm(wt, { recursive: true, force: true });
  }
});

test('patcher: scripts without next/vite OR ${PORT:-N} pattern untouched', async () => {
  // Pure utility scripts that neither contain a port-binding tool nor a
  // ${PORT:-N} fallback have nothing to patch.
  const wt = await tmpWorktree();
  try {
    const p = await writePkg(wt, 'ekoa-app', {
      name: 'ekoa-app',
      scripts: {
        build: 'next build',
        lint: 'eslint .',
        format: 'prettier --write .',
      },
    });
    const before = await fsp.readFile(p, 'utf8');
    const modified = await patchFrontendDevScripts(wt);
    assert.deepEqual(modified, []);
    const after = await fsp.readFile(p, 'utf8');
    assert.equal(before, after);
  } finally {
    await fsp.rm(wt, { recursive: true, force: true });
  }
});

test('patcher: bare `next dev` (no ${PORT:-N}) still gets -p flag', async () => {
  const wt = await tmpWorktree();
  try {
    const p = await writePkg(wt, 'ekoa-app', {
      name: 'ekoa-app',
      scripts: { dev: 'next dev' },
    });
    await patchFrontendDevScripts(wt);
    const after = JSON.parse(await fsp.readFile(p, 'utf8'));
    assert.equal(
      after.scripts.dev,
      'next dev -p ${PORT:-${SEQUOIAS_FRONTEND_PORT:-3000}}',
    );
  } finally {
    await fsp.rm(wt, { recursive: true, force: true });
  }
});

test('patcher: malformed package.json skipped silently', async () => {
  const wt = await tmpWorktree();
  try {
    const dir = path.join(wt, 'ekoa-app');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'package.json'), '{ this is not json');
    const modified = await patchFrontendDevScripts(wt);
    assert.deepEqual(modified, []); // didn't throw
  } finally {
    await fsp.rm(wt, { recursive: true, force: true });
  }
});

test('patcher: package without scripts key skipped', async () => {
  const wt = await tmpWorktree();
  try {
    await writePkg(wt, 'ui', { name: 'ui', version: '1.0.0' });
    const modified = await patchFrontendDevScripts(wt);
    assert.deepEqual(modified, []);
  } finally {
    await fsp.rm(wt, { recursive: true, force: true });
  }
});

test('patcher: empty worktree returns empty list (no crash)', async () => {
  const wt = await tmpWorktree();
  try {
    const modified = await patchFrontendDevScripts(wt);
    assert.deepEqual(modified, []);
  } finally {
    await fsp.rm(wt, { recursive: true, force: true });
  }
});

test('patcher: nonexistent worktree returns empty list (no throw)', async () => {
  const modified = await patchFrontendDevScripts('/nonexistent/sequoias-test-dir');
  assert.deepEqual(modified, []);
});

test('patcher: injects -p flag into next dev when missing', async () => {
  const wt = await tmpWorktree();
  try {
    const p = await writePkg(wt, 'ekoa-app', {
      name: 'ekoa-app',
      scripts: {
        dev: '../scripts/kill-port.sh ${PORT:-3000} && next dev --hostname 0.0.0.0',
      },
    });
    await patchFrontendDevScripts(wt);
    const after = JSON.parse(await fsp.readFile(p, 'utf8'));
    // kill-port arg got the fallback chain AND next dev got -p.
    assert.equal(
      after.scripts.dev,
      '../scripts/kill-port.sh ${PORT:-${SEQUOIAS_FRONTEND_PORT:-3000}} && next dev -p ${PORT:-${SEQUOIAS_FRONTEND_PORT:-3000}} --hostname 0.0.0.0',
    );
  } finally {
    await fsp.rm(wt, { recursive: true, force: true });
  }
});

test('patcher: idempotent across both rewrites', async () => {
  const wt = await tmpWorktree();
  try {
    await writePkg(wt, 'ekoa-app', {
      name: 'ekoa-app',
      scripts: {
        dev: '../scripts/kill-port.sh ${PORT:-3000} && next dev --hostname 0.0.0.0',
      },
    });
    const first = await patchFrontendDevScripts(wt);
    assert.equal(first.length, 1);
    const second = await patchFrontendDevScripts(wt);
    assert.deepEqual(second, []);
  } finally {
    await fsp.rm(wt, { recursive: true, force: true });
  }
});

test('patcher: leaves explicit -p flag alone', async () => {
  const wt = await tmpWorktree();
  try {
    const p = await writePkg(wt, 'ekoa-app', {
      name: 'ekoa-app',
      scripts: {
        // User already chose a port via -p; don't double-inject.
        dev: 'next dev -p 7777 --hostname 0.0.0.0',
      },
    });
    await patchFrontendDevScripts(wt);
    const after = JSON.parse(await fsp.readFile(p, 'utf8'));
    assert.equal(after.scripts.dev, 'next dev -p 7777 --hostname 0.0.0.0');
  } finally {
    await fsp.rm(wt, { recursive: true, force: true });
  }
});

test('patcher: --port flag also detected (case: `next dev --port 3000`)', async () => {
  const wt = await tmpWorktree();
  try {
    const p = await writePkg(wt, 'ekoa-app', {
      name: 'ekoa-app',
      scripts: { dev: 'next dev --port 3000 --hostname 0.0.0.0' },
    });
    await patchFrontendDevScripts(wt);
    const after = JSON.parse(await fsp.readFile(p, 'utf8'));
    assert.equal(after.scripts.dev, 'next dev --port 3000 --hostname 0.0.0.0');
  } finally {
    await fsp.rm(wt, { recursive: true, force: true });
  }
});

test('patcher: vite dev gets -p too', async () => {
  const wt = await tmpWorktree();
  try {
    const p = await writePkg(wt, 'web', {
      name: 'web',
      scripts: { dev: 'vite dev' },
    });
    await patchFrontendDevScripts(wt);
    const after = JSON.parse(await fsp.readFile(p, 'utf8'));
    assert.equal(
      after.scripts.dev,
      'vite dev -p ${PORT:-${SEQUOIAS_FRONTEND_PORT:-5173}}',
    );
  } finally {
    await fsp.rm(wt, { recursive: true, force: true });
  }
});

test('patcher: chaining-operator boundary respected', async () => {
  // A `-p` flag in a LATER command (e.g. `vite preview -p 4000`) must not
  // fool us into thinking `next dev` already has a port flag.
  const wt = await tmpWorktree();
  try {
    const p = await writePkg(wt, 'ekoa-app', {
      name: 'ekoa-app',
      scripts: { dev: 'next dev && vite preview -p 4000' },
    });
    await patchFrontendDevScripts(wt);
    const after = JSON.parse(await fsp.readFile(p, 'utf8'));
    assert.equal(
      after.scripts.dev,
      'next dev -p ${PORT:-${SEQUOIAS_FRONTEND_PORT:-3000}} && vite preview -p 4000',
    );
  } finally {
    await fsp.rm(wt, { recursive: true, force: true });
  }
});

test('patcher: preserves trailing newline', async () => {
  const wt = await tmpWorktree();
  try {
    const dir = path.join(wt, 'ekoa-app');
    await fsp.mkdir(dir, { recursive: true });
    const p = path.join(dir, 'package.json');
    // Original has trailing newline (npm convention).
    const original = JSON.stringify({
      name: 'x',
      scripts: { dev: 'next dev -p ${PORT:-3000}' },
    }, null, 2) + '\n';
    await fsp.writeFile(p, original);
    await patchFrontendDevScripts(wt);
    const after = await fsp.readFile(p, 'utf8');
    assert.ok(after.endsWith('\n'));
  } finally {
    await fsp.rm(wt, { recursive: true, force: true });
  }
});
