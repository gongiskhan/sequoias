import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allocatePort,
  basePort,
  fnv1a32,
  rangeFor,
  isPortInSequoiasRange,
  SEQUOIAS_PORT_RANGE_START,
  SEQUOIAS_PORT_RANGE_END,
} from '../../src/ports.js';

test('fnv1a32 is deterministic', () => {
  assert.equal(fnv1a32('hello'), fnv1a32('hello'));
  assert.notEqual(fnv1a32('hello'), fnv1a32('world'));
});

test('basePort: same branch + service maps to same port', () => {
  const a = basePort('feature/auth', 'cortex');
  const b = basePort('feature/auth', 'cortex');
  assert.equal(a, b);
  assert.ok(
    a >= SEQUOIAS_PORT_RANGE_START && a <= SEQUOIAS_PORT_RANGE_END,
    `expected ${SEQUOIAS_PORT_RANGE_START}-${SEQUOIAS_PORT_RANGE_END}, got ${a}`,
  );
});

test('basePort: different branches produce different ports (probabilistic)', () => {
  const seen = new Set<number>();
  for (let i = 0; i < 20; i++) {
    seen.add(basePort(`feature/branch-${i}`, 'cortex'));
  }
  assert.ok(seen.size > 1, 'all 20 branches collided to same port');
});

test('rangeFor: every service uses the unified Sequoias range', () => {
  for (const service of ['cortex', 'ekoa_app', 'api', 'ui', 'ekoa_streaming_allowed_origins', 'foo', 'bar']) {
    const r = rangeFor(service);
    assert.equal(r.start, SEQUOIAS_PORT_RANGE_START);
    assert.equal(r.end, SEQUOIAS_PORT_RANGE_END);
  }
});

test('every service name lands within the Sequoias range', () => {
  const samples = [
    'api', 'ui', 'cortex', 'ekoa_app', 'auth', 'cdn', 'redis', 'pg',
    'streaming', 'edge', 'admin', 'metrics', 'foo', 'bar', 'baz',
    'webhooks', 'ekoa_streaming_allowed_origins',
    'anything-with-a-very-long-name-here',
  ];
  for (const s of samples) {
    const port = basePort('main', s);
    assert.ok(
      isPortInSequoiasRange(port),
      `service "${s}" landed at ${port}, outside ${SEQUOIAS_PORT_RANGE_START}-${SEQUOIAS_PORT_RANGE_END}`,
    );
  }
});

test('basePort: 100 random services all in range', () => {
  for (let i = 0; i < 100; i++) {
    const p = basePort(`branch-${i}`, `svc-${i}`);
    assert.ok(isPortInSequoiasRange(p), `port ${p} out of Sequoias range`);
  }
});

test('isPortInSequoiasRange: boundary checks', () => {
  assert.equal(isPortInSequoiasRange(SEQUOIAS_PORT_RANGE_START), true);
  assert.equal(isPortInSequoiasRange(SEQUOIAS_PORT_RANGE_END), true);
  assert.equal(isPortInSequoiasRange(SEQUOIAS_PORT_RANGE_START - 1), false);
  assert.equal(isPortInSequoiasRange(SEQUOIAS_PORT_RANGE_END + 1), false);
  assert.equal(isPortInSequoiasRange(0), false);
  assert.equal(isPortInSequoiasRange(80), false);
});

test('allocatePort: linear-probes past in-use ports', async () => {
  const inUse = new Set<number>();
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
  assert.ok(isPortInSequoiasRange(port));
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
