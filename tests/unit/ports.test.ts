import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allocatePort,
  basePort,
  fnv1a32,
  rangeFor,
} from '../../src/ports.js';

test('fnv1a32 is deterministic', () => {
  assert.equal(fnv1a32('hello'), fnv1a32('hello'));
  assert.notEqual(fnv1a32('hello'), fnv1a32('world'));
});

test('basePort: same branch + service maps to same port', () => {
  const a = basePort('feature/auth', 'cortex');
  const b = basePort('feature/auth', 'cortex');
  assert.equal(a, b);
  assert.ok(a >= 4000 && a <= 4999, `expected 4000-4999, got ${a}`);
});

test('basePort: different branches produce different ports (probabilistic)', () => {
  const seen = new Set<number>();
  for (let i = 0; i < 20; i++) {
    seen.add(basePort(`feature/branch-${i}`, 'cortex'));
  }
  assert.ok(seen.size > 1, 'all 20 branches collided to same port');
});

test('rangeFor: known service uses fixed range', () => {
  assert.deepEqual(rangeFor('cortex'), { name: 'cortex', start: 4000, end: 4999 });
  assert.deepEqual(rangeFor('ekoa_app'), { name: 'ekoa_app', start: 5000, end: 5999 });
});

test('rangeFor: unknown service falls into 6000+ band', () => {
  const r = rangeFor('myservice');
  assert.ok(r.start >= 6000);
  assert.equal(r.end - r.start, 999);
});

test('rangeFor: every service name lands within TCP port range', () => {
  const samples = [
    'api',
    'ui',
    'cortex',
    'ekoa_app',
    'auth',
    'cdn',
    'redis',
    'pg',
    'streaming',
    'edge',
    'admin',
    'metrics',
    'foo',
    'bar',
    'baz',
    'webhooks',
    'anything-with-very-long-name-here',
    'ekoa_streaming_allowed_origins',
  ];
  for (const s of samples) {
    const r = rangeFor(s);
    assert.ok(
      r.start >= 0 && r.end <= 65535,
      `service "${s}" range ${r.start}-${r.end} exceeds TCP port range`,
    );
  }
});

test('basePort: arbitrary service stays within TCP range', () => {
  for (let i = 0; i < 100; i++) {
    const p = basePort(`branch-${i}`, `svc-${i}`);
    assert.ok(p > 0 && p <= 65535, `port ${p} out of TCP range`);
  }
});

test('allocatePort: linear-probes past in-use ports', async () => {
  const inUse = new Set<number>();
  // Force first 3 candidates to appear in use, then succeed.
  let calls = 0;
  const port = await allocatePort('branch-x', 'cortex', {
    isInUse: async (p) => {
      calls++;
      if (inUse.has(p)) return true;
      if (calls <= 3) {
        inUse.add(p);
        return true;
      }
      return false;
    },
  });
  assert.ok(port >= 4000 && port <= 4999);
});

test('allocatePort: respects reserved set', async () => {
  const reserved = new Set<number>();
  const a = await allocatePort('branch-y', 'cortex', {
    reserved,
    isInUse: async () => false,
  });
  const b = await allocatePort('branch-y', 'cortex', {
    reserved,
    isInUse: async () => false,
  });
  assert.notEqual(a, b);
});
