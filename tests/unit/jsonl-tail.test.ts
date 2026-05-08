import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { formatEvent, readJsonlTail, JsonlTailer } from '../../src/jsonl-tail.js';
import { workingDirToProjectDir } from '../../src/jsonl-paths.js';

test('formatEvent: user message with plain string content', () => {
  const out = formatEvent({
    type: 'user',
    message: { role: 'user', content: 'hello world' },
  });
  assert.match(out, /\[user\]/);
  assert.match(out, /hello world/);
});

test('formatEvent: user message strips system-reminder tags', () => {
  const out = formatEvent({
    type: 'user',
    message: {
      role: 'user',
      content: 'visible<system-reminder>hidden text</system-reminder> rest',
    },
  });
  assert.match(out, /visible/);
  assert.match(out, /rest/);
  assert.doesNotMatch(out, /hidden text/);
});

test('formatEvent: assistant text + tool use', () => {
  const out = formatEvent({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Reading the file.' },
        { type: 'tool_use', name: 'Read', input: { file_path: 'src/foo.ts' } },
      ],
    },
  });
  assert.match(out, /\[assistant\]/);
  assert.match(out, /Reading the file/);
  assert.match(out, /\[tool: Read\]/);
  assert.match(out, /src\/foo\.ts/);
});

test('formatEvent: bash tool surfaces command', () => {
  const out = formatEvent({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
      ],
    },
  });
  assert.match(out, /\[tool: Bash\]/);
  assert.match(out, /ls -la/);
});

test('formatEvent: skips internal entries', () => {
  assert.equal(formatEvent({ type: 'last-prompt' }), '');
  assert.equal(formatEvent({ type: 'permission-mode' }), '');
  assert.equal(formatEvent({ type: 'file-history-snapshot' }), '');
  assert.equal(formatEvent({ type: 'summary' }), '');
});

test('readJsonlTail: reads last N lines', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sequoias-jsonl-'));
  try {
    const file = path.join(dir, 'sess.jsonl');
    const lines = ['line1', 'line2', 'line3', 'line4', 'line5'];
    await fs.writeFile(file, lines.join('\n') + '\n');
    const tail = await readJsonlTail(file, 3);
    assert.deepEqual(tail, ['line3', 'line4', 'line5']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('readJsonlTail: handles file shorter than maxLines', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sequoias-jsonl-'));
  try {
    const file = path.join(dir, 'sess.jsonl');
    await fs.writeFile(file, 'only-line\n');
    const tail = await readJsonlTail(file, 10);
    assert.deepEqual(tail, ['only-line']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('JsonlTailer: emits formatted lines and detects rotation', async () => {
  const ORIG_HOME = process.env.HOME;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sequoias-tail-home-'));
  process.env.HOME = home;
  try {
    const worktree = '/tmp/fake-worktree-tailer';
    const projectDir = workingDirToProjectDir(worktree);
    await fs.mkdir(projectDir, { recursive: true });

    // Initial transcript file.
    const file1 = path.join(projectDir, 'sess-1.jsonl');
    await fs.writeFile(
      file1,
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'hello' },
      }) + '\n',
    );

    const tailer = new JsonlTailer(worktree);
    const chunks: string[] = [];
    tailer.on('data', (s: string) => chunks.push(s));
    tailer.start();

    await new Promise((r) => setTimeout(r, 1300));

    assert.ok(chunks.some((c) => c.includes('[user]')), 'expected user line');
    assert.ok(chunks.some((c) => c.includes('hello')));

    // Append more to same file.
    await fs.appendFile(
      file1,
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'world' }],
        },
      }) + '\n',
    );

    await new Promise((r) => setTimeout(r, 1300));
    assert.ok(chunks.some((c) => c.includes('[assistant]')));
    assert.ok(chunks.some((c) => c.includes('world')));

    // Simulate rotation: write a new JSONL with a fresher mtime.
    await new Promise((r) => setTimeout(r, 50));
    const file2 = path.join(projectDir, 'sess-2.jsonl');
    await fs.writeFile(
      file2,
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'fresh session' },
      }) + '\n',
    );
    // Bump mtime to ensure ordering.
    const future = new Date(Date.now() + 60_000);
    await fs.utimes(file2, future, future);

    await new Promise((r) => setTimeout(r, 1500));
    assert.ok(
      chunks.some((c) => c.includes('new claude session')),
      `expected rotation separator, got: ${JSON.stringify(chunks).slice(0, 800)}`,
    );
    assert.ok(chunks.some((c) => c.includes('fresh session')));

    tailer.stop();
  } finally {
    process.env.HOME = ORIG_HOME;
    await fs.rm(home, { recursive: true, force: true });
  }
});
