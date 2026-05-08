import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  workingDirToEscapedPath,
  workingDirToProjectDir,
} from '../../src/jsonl-paths.js';

test('workingDirToEscapedPath: simple path', () => {
  assert.equal(
    workingDirToEscapedPath('/Users/ggomes/dev/sequoias'),
    '-Users-ggomes-dev-sequoias',
  );
});

test('workingDirToEscapedPath: hidden directory becomes double-dash', () => {
  // Verified empirically against Claude Code on this machine — leading dots
  // in segments encode as an additional dash, e.g. "/.worktrees" -> "--worktrees".
  assert.equal(
    workingDirToEscapedPath('/Users/ggomes/.worktrees/sequoias/feature-foo'),
    '-Users-ggomes--worktrees-sequoias-feature-foo',
  );
  assert.equal(
    workingDirToEscapedPath('/Users/ggomes/.claude'),
    '-Users-ggomes--claude',
  );
});

test('workingDirToEscapedPath: hyphens in segments are preserved', () => {
  assert.equal(
    workingDirToEscapedPath('/Users/x/.worktrees/ekoa-os-repo/wt-architectural'),
    '-Users-x--worktrees-ekoa-os-repo-wt-architectural',
  );
});

test('workingDirToProjectDir: lives under ~/.claude/projects', () => {
  const out = workingDirToProjectDir('/Users/ggomes/dev/sequoias');
  assert.match(out, /\/\.claude\/projects\/-Users-ggomes-dev-sequoias$/);
});
