import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  discoverEnvFiles,
  isPortKey,
  packagePortForDir,
  readMainPortMap,
  rewriteEnvFiles,
  serviceForKey,
} from '../../src/env-rewriter.js';

test('packagePortForDir: cortex dir falls back to api allocation', () => {
  assert.equal(packagePortForDir('cortex', { api: 52753, ui: 56473 }), 52753);
});

test('packagePortForDir: ekoa-app dir falls back to ekoa_app allocation', () => {
  assert.equal(packagePortForDir('ekoa-app', { ekoa_app: 5234, api: 4123 }), 5234);
});

test('packagePortForDir: direct service name match wins', () => {
  assert.equal(packagePortForDir('cortex', { cortex: 4567, api: 9999 }), 4567);
});

test('packagePortForDir: unknown dirname returns undefined', () => {
  assert.equal(packagePortForDir('mysterious-package', { api: 1, ui: 2 }), undefined);
});

test('packagePortForDir: backend matches via alias chain', () => {
  assert.equal(packagePortForDir('backend', { server: 9000 }), 9000);
});

test('rewriteEnvFiles: per-package file gets PORT= injected', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sequoias-pkgport-'));
  try {
    await fsp.mkdir(path.join(dir, 'cortex'));
    await fsp.writeFile(
      path.join(dir, '.env'),
      'API_PORT=4111\n',
    );
    await fsp.writeFile(
      path.join(dir, 'cortex/.env'),
      'SOME_KEY=value\n',
    );

    await rewriteEnvFiles(
      dir,
      ['.env', 'cortex/.env'],
      { branch: 'feature/pkg', mainPortMap: { 4111: { service: 'api', key: 'API_PORT' } } },
    );

    const cortexEnv = await fsp.readFile(path.join(dir, 'cortex/.env'), 'utf8');
    assert.match(cortexEnv, /^PORT=\d+$/m);
    const rootEnv = await fsp.readFile(path.join(dir, '.env'), 'utf8');
    // Root .env should NOT have PORT= injected (root, not a package).
    assert.doesNotMatch(rootEnv, /^PORT=/m);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

async function makeTmpDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'sequoias-env-'));
}

test('isPortKey identifies PORT-shaped keys', () => {
  assert.ok(isPortKey('PORT'));
  assert.ok(isPortKey('CORTEX_PORT'));
  assert.ok(isPortKey('NEXT_PUBLIC_PORT'));
  assert.ok(isPortKey('PORT_INTERNAL'));
  assert.ok(!isPortKey('CORTEX_URL'));
  assert.ok(!isPortKey('PORTAL_KEY'));
});

test('serviceForKey maps cortex/next/app correctly', () => {
  assert.equal(serviceForKey('CORTEX_PORT'), 'cortex');
  assert.equal(serviceForKey('NEXT_PUBLIC_PORT'), 'ekoa_app');
  assert.equal(serviceForKey('APP_PORT'), 'ekoa_app');
  assert.equal(serviceForKey('FRONTEND_PORT'), 'ekoa_app');
});

test('discoverEnvFiles finds root + first-level .env files, ignores .gitignore', async () => {
  const dir = await makeTmpDir();
  fs.writeFileSync(path.join(dir, '.env'), 'PORT=1');
  fs.writeFileSync(path.join(dir, '.env.local'), 'PORT=2');
  fs.mkdirSync(path.join(dir, 'cortex'));
  fs.writeFileSync(path.join(dir, 'cortex/.env'), 'PORT=3');
  fs.mkdirSync(path.join(dir, 'cortex/deep'));
  fs.writeFileSync(path.join(dir, 'cortex/deep/.env'), 'TOO_DEEP=1');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'node_modules/.env'), 'SHOULD=NOT_SHOW');
  fs.mkdirSync(path.join(dir, '.next'));
  fs.writeFileSync(path.join(dir, '.next/.env'), 'BUILD=1');
  // .env files are gitignored in real projects — discovery must still find them.
  fs.writeFileSync(path.join(dir, '.gitignore'), '.env\n.env*.local\n');

  const found = await discoverEnvFiles(dir);
  assert.deepEqual(
    found.sort(),
    ['.env', '.env.local', 'cortex/.env'].sort(),
  );

  await fsp.rm(dir, { recursive: true, force: true });
});

test('rewriteEnvFiles is per-file scope and rewrites URL ports via main map', async () => {
  const dir = await makeTmpDir();
  fs.writeFileSync(
    path.join(dir, '.env'),
    'PORT=3000\nNEXT_PUBLIC_CORTEX_URL=http://localhost:4143\n',
  );
  fs.mkdirSync(path.join(dir, 'cortex'));
  fs.writeFileSync(path.join(dir, 'cortex/.env'), 'CORTEX_PORT=4143\n');

  const mainPortMap = {
    4143: { service: 'cortex', key: 'CORTEX_PORT' },
    3000: { service: 'port', key: 'PORT' },
  };

  const { ports } = await rewriteEnvFiles(dir, ['.env', 'cortex/.env'], {
    branch: 'feature/test',
    mainPortMap,
  });

  const root = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  const cortex = fs.readFileSync(path.join(dir, 'cortex/.env'), 'utf8');

  // main file: PORT replaced; URL rewritten because main map links 4143 -> cortex
  assert.match(root, /^PORT=\d+$/m);
  assert.notEqual(root.match(/PORT=(\d+)/)?.[1], '3000');
  const cortexUrlPort = root.match(/localhost:(\d+)/)?.[1];
  assert.ok(cortexUrlPort, 'cortex URL port should be present');
  assert.notEqual(cortexUrlPort, '4143');
  assert.equal(Number(cortexUrlPort), ports.cortex);

  // cortex file: CORTEX_PORT replaced; no NEXT_PUBLIC_PORT injected (per-file scope)
  assert.match(cortex, /^CORTEX_PORT=\d+$/m);
  assert.equal(cortex.match(/CORTEX_PORT=(\d+)/)?.[1], String(ports.cortex));
  assert.ok(!cortex.includes('NEXT_PUBLIC_PORT'));

  await fsp.rm(dir, { recursive: true, force: true });
});

test('readMainPortMap captures URL ports too', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sequoias-mainmap-'));
  fs.writeFileSync(
    path.join(dir, '.env'),
    'CORTEX_PORT=4143\nNEXT_PUBLIC_CORTEX_URL=http://localhost:4143\nDB_URL=postgres://localhost:5432/db\n',
  );
  const map = readMainPortMap(dir, ['.env']);
  assert.ok(map[4143]);
  assert.equal(map[4143].service, 'cortex');
  assert.ok(map[5432]);
  fs.rmSync(dir, { recursive: true, force: true });
});
