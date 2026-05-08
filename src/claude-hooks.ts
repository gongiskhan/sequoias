import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { claudeSettingsPath, sequoiasDir, settingsSnapshotMetaPath, settingsSnapshotPath } from './paths.js';

const HOOK_EVENTS = ['UserPromptSubmit', 'Stop', 'Notification'] as const;

type HookEvent = (typeof HOOK_EVENTS)[number];

type MatcherGroup = {
  matcher?: string;
  hooks?: Array<{ type: string; command: string; timeout?: number }>;
  _sequoias?: boolean;
  [key: string]: unknown;
};

type SettingsJson = {
  hooks?: Partial<Record<string, MatcherGroup[]>> & Record<string, MatcherGroup[]>;
  [key: string]: unknown;
};

let installed = false;

export async function installHooks(serverPort: number): Promise<void> {
  await fsp.mkdir(sequoiasDir(), { recursive: true });
  await fsp.mkdir(path.dirname(claudeSettingsPath()), { recursive: true });

  const settingsPath = claudeSettingsPath();
  const existedBefore = fs.existsSync(settingsPath);
  let originalBytes: Buffer | null = null;

  if (existedBefore) {
    originalBytes = await fsp.readFile(settingsPath);
    const parsed = safeParse(originalBytes.toString('utf8'));
    const hadOrphans = stripSequoiasGroups(parsed);
    if (hadOrphans) {
      const cleaned = JSON.stringify(parsed, null, 2);
      await fsp.writeFile(settingsPath, cleaned);
      originalBytes = Buffer.from(cleaned);
    }
  }

  await fsp.writeFile(
    settingsSnapshotMetaPath(),
    JSON.stringify({ existedBefore, settingsPath }, null, 2),
  );
  if (originalBytes) {
    await fsp.writeFile(settingsSnapshotPath(), originalBytes);
  } else if (fs.existsSync(settingsSnapshotPath())) {
    await fsp.unlink(settingsSnapshotPath());
  }

  const current = existedBefore && originalBytes
    ? safeParse(originalBytes.toString('utf8'))
    : ({} as SettingsJson);
  current.hooks = current.hooks || {};

  for (const event of HOOK_EVENTS) {
    const cmd = buildHookCommand(event, serverPort);
    const list = (current.hooks[event] = current.hooks[event] || []);
    list.push({
      _sequoias: true,
      matcher: '',
      hooks: [{ type: 'command', command: cmd, timeout: 5 }],
    });
  }

  await fsp.writeFile(settingsPath, JSON.stringify(current, null, 2));
  installed = true;
}

export async function restoreHooks(): Promise<void> {
  if (!installed && !fs.existsSync(settingsSnapshotMetaPath())) return;
  installed = false;
  let meta: { existedBefore: boolean; settingsPath: string } | null = null;
  try {
    meta = JSON.parse(await fsp.readFile(settingsSnapshotMetaPath(), 'utf8'));
  } catch {
    // no meta to act on
    return;
  }
  if (!meta) return;

  try {
    if (meta.existedBefore) {
      const snapshot = await fsp.readFile(settingsSnapshotPath());
      await fsp.writeFile(meta.settingsPath, snapshot);
    } else {
      try {
        await fsp.unlink(meta.settingsPath);
      } catch {
        // ignore
      }
    }
  } finally {
    try {
      await fsp.unlink(settingsSnapshotMetaPath());
    } catch {
      // ignore
    }
    try {
      await fsp.unlink(settingsSnapshotPath());
    } catch {
      // ignore
    }
  }
}

function buildHookCommand(event: HookEvent, port: number): string {
  const escapedEvent = event.replace(/"/g, '\\"');
  return [
    'curl -s -X POST',
    `http://localhost:${port}/_hook`,
    "-H 'Content-Type: application/json'",
    `-d "{\\"event\\":\\"${escapedEvent}\\",\\"cwd\\":\\"$CLAUDE_PROJECT_DIR\\"}"`,
    '> /dev/null 2>&1 || true',
  ].join(' ');
}

function safeParse(text: string): SettingsJson {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return parsed as SettingsJson;
  } catch {
    // ignore
  }
  return {} as SettingsJson;
}

function stripSequoiasGroups(parsed: SettingsJson): boolean {
  if (!parsed.hooks) return false;
  let removed = false;
  for (const [event, list] of Object.entries(parsed.hooks)) {
    if (!Array.isArray(list)) continue;
    const before = list.length;
    parsed.hooks[event] = list.filter((g) => !(g && (g as MatcherGroup)._sequoias));
    if (parsed.hooks[event].length !== before) removed = true;
  }
  return removed;
}
