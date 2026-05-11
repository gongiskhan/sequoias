import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terminalCwdBasename } from '../../src/pty-manager.js';
import { packagePortForDir } from '../../src/env-rewriter.js';

// terminalCwdBasename + packagePortForDir compose to give the env-injection
// logic in pty-manager.spawnPty: any terminal whose cwd basename matches a
// known package alias chain gets PORT exported in its shell env.

test('terminalCwdBasename: worktree root yields empty', () => {
  assert.equal(terminalCwdBasename('.'), '');
  assert.equal(terminalCwdBasename('./'), '');
  assert.equal(terminalCwdBasename(''), '');
  assert.equal(terminalCwdBasename(undefined), '');
});

test('terminalCwdBasename: bare directory name', () => {
  assert.equal(terminalCwdBasename('ekoa-app'), 'ekoa-app');
  assert.equal(terminalCwdBasename('cortex'), 'cortex');
});

test('terminalCwdBasename: nested or trailing-slash paths use leaf', () => {
  assert.equal(terminalCwdBasename('./apps/web'), 'web');
  assert.equal(terminalCwdBasename('apps/web/'), 'web');
  assert.equal(terminalCwdBasename('packages/cortex'), 'cortex');
  assert.equal(terminalCwdBasename('/Users/x/repo/cortex'), 'cortex');
});

test('terminalCwdBasename: trailing dots reject', () => {
  assert.equal(terminalCwdBasename('..'), '');
});

test('cwd → PORT integration: ekoa-app folds via alias chain to ports.ui', () => {
  // Real shape from a Sequoias session: services include 'ui', 'api',
  // 'ekoa_streaming_allowed_origins'. ekoa-app's alias chain is
  // ekoa_app -> app -> frontend -> web -> ui -> next, so it should
  // resolve to ports.ui = 51610.
  const ports = {
    ui: 51610,
    api: 52664,
    ekoa_streaming_allowed_origins: 54592,
  };
  const base = terminalCwdBasename('ekoa-app');
  assert.equal(packagePortForDir(base, ports), 51610);
});

test('cwd → PORT integration: cortex resolves to ports.api via alias chain', () => {
  const ports = { ui: 51610, api: 52664 };
  const base = terminalCwdBasename('cortex');
  assert.equal(packagePortForDir(base, ports), 52664);
});

test('cwd → PORT integration: worktree root yields no port (intentional)', () => {
  // Polyrepo worktree-root shells must NOT get PORT injected — would
  // collide with backend processes that read process.env.PORT.
  const ports = { ui: 51610, api: 52664 };
  const base = terminalCwdBasename('.');
  assert.equal(base, '');
  assert.equal(packagePortForDir(base, ports), undefined);
});

test('cwd → PORT integration: unknown directory name returns undefined', () => {
  const ports = { ui: 51610, api: 52664 };
  const base = terminalCwdBasename('docs');
  assert.equal(packagePortForDir(base, ports), undefined);
});

// SEQUOIAS_FRONTEND_PORT / SEQUOIAS_BACKEND_PORT are convenience aliases
// always exported into the spawned shell, regardless of cwd. Dev scripts
// can reference them in fallback chains: `${PORT:-${SEQUOIAS_FRONTEND_PORT:-3000}}`.
// They use the same alias chains as packagePortForDir.
test('SEQUOIAS_FRONTEND_PORT alias: walks frontend chain to ports.ui', () => {
  const ports = { ui: 51610, api: 52664 };
  assert.equal(packagePortForDir('frontend', ports), 51610);
});

test('SEQUOIAS_BACKEND_PORT alias: walks backend chain to ports.api', () => {
  const ports = { ui: 51610, api: 52664 };
  assert.equal(packagePortForDir('backend', ports), 52664);
});

test('SEQUOIAS_FRONTEND_PORT prefers ekoa_app over generic ui when both present', () => {
  const ports = { ekoa_app: 50001, ui: 51610 };
  // The 'frontend' alias chain is ['frontend', 'ekoa_app', 'app', 'web', 'ui', 'next']
  // — ekoa_app appears before ui, so it wins.
  assert.equal(packagePortForDir('frontend', ports), 50001);
});
