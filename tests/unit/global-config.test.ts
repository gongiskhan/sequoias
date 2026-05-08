import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ORIG_HOME = process.env.HOME;

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sequoias-test-home-'));
  process.env.HOME = dir;
  try {
    return await fn();
  } finally {
    process.env.HOME = ORIG_HOME;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('resolveGlobalConfig fills defaults for empty state', async () => {
  await withTempHome(async () => {
    const { resolveGlobalConfig } = await import('../../src/store.js');
    const out = resolveGlobalConfig({ globalConfig: undefined });
    assert.equal(out.theme, 'system');
    assert.equal(out.host, '0.0.0.0');
    assert.equal(out.idePath, '');
    assert.deepEqual(out.projects, []);
  });
});

test('resolveGlobalConfig preserves provided values', async () => {
  await withTempHome(async () => {
    const { resolveGlobalConfig } = await import('../../src/store.js');
    const out = resolveGlobalConfig({
      globalConfig: {
        theme: 'dark',
        host: '127.0.0.1',
        idePath: 'rebased',
        projects: ['/foo', '/bar'],
      },
    });
    assert.equal(out.theme, 'dark');
    assert.equal(out.host, '127.0.0.1');
    assert.equal(out.idePath, 'rebased');
    assert.deepEqual(out.projects, ['/foo', '/bar']);
  });
});

test('loadStore round-trips globalConfig through state.json', async () => {
  await withTempHome(async () => {
    const { loadStore, resolveGlobalConfig } = await import('../../src/store.js');
    const store = await loadStore();

    store.setGlobalConfig({ theme: 'dark', idePath: 'rebased' });
    await store.flush();

    // Verify file contents directly.
    const raw = await fs.readFile(path.join(process.env.HOME!, '.sequoias/state.json'), 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.globalConfig.theme, 'dark');
    assert.equal(parsed.globalConfig.idePath, 'rebased');

    // Re-load and confirm resolved value.
    const store2 = await loadStore();
    const out = resolveGlobalConfig(store2.data);
    assert.equal(out.theme, 'dark');
    assert.equal(out.idePath, 'rebased');
  });
});

test('legacy v1 state without globalConfig loads cleanly', async () => {
  await withTempHome(async () => {
    const dir = path.join(process.env.HOME!, '.sequoias');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'state.json'),
      JSON.stringify({ version: 1, projects: {} }, null, 2),
    );
    const { loadStore, resolveGlobalConfig } = await import('../../src/store.js');
    const store = await loadStore();
    const out = resolveGlobalConfig(store.data);
    assert.equal(out.theme, 'system');
    assert.equal(out.host, '0.0.0.0');
    assert.deepEqual(out.projects, []);
  });
});

test('projectIdFor produces stable 8-hex IDs', async () => {
  await withTempHome(async () => {
    const { projectIdFor } = await import('../../src/store.js');
    const id1 = projectIdFor('/Users/x/repo-a');
    const id2 = projectIdFor('/Users/x/repo-a');
    const id3 = projectIdFor('/Users/x/repo-b');
    assert.equal(id1, id2);
    assert.notEqual(id1, id3);
    assert.match(id1, /^[0-9a-f]{8}$/);
  });
});
