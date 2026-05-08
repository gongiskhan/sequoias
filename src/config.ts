import type { StoredTerminal } from './types.js';

export type TerminalKind = 'pty' | 'jsonl';

export type TerminalConfig = StoredTerminal & {
  kind?: TerminalKind;
  readOnly?: boolean;
};

const RESERVED_NAMES = new Set(['claude', 'claude-live']);
const NAME_RE = /^[a-z][a-z0-9-]{0,30}$/i;

export function validateTerminals(input: unknown): StoredTerminal[] {
  if (!Array.isArray(input)) {
    throw new Error('terminals must be an array');
  }
  const seen = new Set<string>();
  const out: StoredTerminal[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') {
      throw new Error('terminal entry must be an object');
    }
    const r = raw as Record<string, unknown>;
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    if (!NAME_RE.test(name)) {
      throw new Error(`invalid terminal name: ${JSON.stringify(name)}`);
    }
    if (RESERVED_NAMES.has(name.toLowerCase())) {
      throw new Error(`terminal name "${name}" is reserved (claude is implicit)`);
    }
    if (seen.has(name)) {
      throw new Error(`duplicate terminal name: ${name}`);
    }
    seen.add(name);
    out.push({
      name,
      cwd: typeof r.cwd === 'string' && r.cwd.length > 0 ? r.cwd : '.',
      cmd: typeof r.cmd === 'string' && r.cmd.length > 0 ? r.cmd : null,
      autostart: r.autostart !== false,
      background: r.background === true,
    });
  }
  return out;
}

export function resolveTerminals(stored: StoredTerminal[] | undefined): TerminalConfig[] {
  const liveTerminal: TerminalConfig = {
    name: 'claude-live',
    cwd: '.',
    cmd: null,
    autostart: true,
    background: false,
    kind: 'jsonl',
    readOnly: true,
  };
  const claudeTerminal: TerminalConfig = {
    name: 'claude',
    cwd: '.',
    cmd: process.env.SEQUOIAS_AUTO_CLAUDE === '0' ? null : 'claude',
    autostart: true,
    background: false,
    kind: 'pty',
  };
  return [
    liveTerminal,
    claudeTerminal,
    ...(stored || []).map((t) => ({ ...t, kind: 'pty' as TerminalKind })),
  ];
}
