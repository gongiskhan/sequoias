import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusFromHookEvent, statusPriority } from '../../src/status.js';

test('statusFromHookEvent: UserPromptSubmit -> working', () => {
  assert.equal(statusFromHookEvent('UserPromptSubmit'), 'working');
});

test('statusFromHookEvent: PostToolUse -> working', () => {
  // PostToolUse is the recovery edge from waiting back to working: after a
  // permission-prompt Notification flips status to "waiting", no hook fires
  // until the user accepts and the first tool actually executes. PostToolUse
  // is the first signal that unambiguously fires post-approval.
  assert.equal(statusFromHookEvent('PostToolUse'), 'working');
});

test('statusFromHookEvent: Stop -> idle', () => {
  assert.equal(statusFromHookEvent('Stop'), 'idle');
});

test('statusFromHookEvent: Notification -> waiting', () => {
  assert.equal(statusFromHookEvent('Notification'), 'waiting');
});

test('statusFromHookEvent: unknown event -> null', () => {
  assert.equal(statusFromHookEvent('PreToolUse'), null);
  assert.equal(statusFromHookEvent('SessionStart'), null);
  assert.equal(statusFromHookEvent(''), null);
});

test('statusPriority orders waiting < working < idle', () => {
  assert.ok(statusPriority('waiting') < statusPriority('working'));
  assert.ok(statusPriority('working') < statusPriority('idle'));
  assert.ok(statusPriority('idle') < statusPriority('errored'));
  assert.ok(statusPriority('errored') < statusPriority('dead'));
});
