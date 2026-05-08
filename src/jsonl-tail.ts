import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { workingDirToProjectDir } from './jsonl-paths.js';

const POLL_MS = 1000;
const BACKFILL_LINES = 200;
const TAIL_CHUNK_BYTES = 256 * 1024;

type AnyJson = Record<string, unknown>;

export type JsonlEvent = AnyJson & { type?: string };

export type JsonlTailEvents = {
  data: (chunk: string) => void;
};

export class JsonlTailer extends EventEmitter {
  private projectDir: string;
  private activeFile: string | null = null;
  private byteOffset = 0;
  private timer: NodeJS.Timeout | null = null;
  private destroyed = false;

  constructor(public readonly worktreePath: string) {
    super();
    this.projectDir = workingDirToProjectDir(worktreePath);
  }

  start(): void {
    if (this.timer || this.destroyed) return;
    void this.poll(true);
    this.timer = setInterval(() => void this.poll(false), POLL_MS);
  }

  stop(): void {
    this.destroyed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.removeAllListeners();
  }

  private async poll(initial: boolean): Promise<void> {
    if (this.destroyed) return;
    let entries: string[];
    try {
      entries = await fsp.readdir(this.projectDir);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        if (initial) {
          this.emit(
            'data',
            ansiDim(
              `[claude] no transcripts yet for ${this.worktreePath}\r\n` +
                `         waiting at ${this.projectDir}\r\n`,
            ),
          );
        }
        return;
      }
      this.emit('data', ansiDim(`[claude] tailer error: ${(err as Error).message}\r\n`));
      return;
    }

    const jsonlFiles = entries.filter((e) => e.endsWith('.jsonl'));
    if (jsonlFiles.length === 0) {
      if (initial) {
        this.emit(
          'data',
          ansiDim(`[claude] no claude transcripts yet in ${this.projectDir}\r\n`),
        );
      }
      return;
    }

    let latest: { file: string; mtimeMs: number; size: number } | null = null;
    for (const name of jsonlFiles) {
      const full = path.join(this.projectDir, name);
      try {
        const st = await fsp.stat(full);
        if (!latest || st.mtimeMs > latest.mtimeMs) {
          latest = { file: full, mtimeMs: st.mtimeMs, size: st.size };
        }
      } catch {
        // ignore stat errors
      }
    }
    if (!latest) return;

    const rotated = this.activeFile !== latest.file;
    const truncated = !rotated && latest.size < this.byteOffset;

    if (rotated) {
      if (this.activeFile !== null) {
        this.emit(
          'data',
          ansiDim('\r\n──────── new claude session ────────\r\n\r\n'),
        );
      }
      this.activeFile = latest.file;
      this.byteOffset = 0;
      if (initial) {
        const backfill = await readJsonlTail(latest.file, BACKFILL_LINES);
        if (backfill.length > 0) {
          for (const line of backfill) this.emitLine(line);
        }
        this.byteOffset = latest.size;
        return;
      }
    } else if (truncated) {
      this.byteOffset = 0;
      this.emit(
        'data',
        ansiDim('\r\n[claude] transcript truncated, restarting tail\r\n\r\n'),
      );
    }

    if (latest.size > this.byteOffset) {
      const lines = await readBytesAsLines(latest.file, this.byteOffset, latest.size);
      for (const line of lines) this.emitLine(line);
      this.byteOffset = latest.size;
    }
  }

  private emitLine(line: string): void {
    if (line.length === 0) return;
    let parsed: JsonlEvent;
    try {
      parsed = JSON.parse(line) as JsonlEvent;
    } catch {
      return;
    }
    const formatted = formatEvent(parsed);
    if (formatted) this.emit('data', formatted);
  }
}

async function readBytesAsLines(
  file: string,
  fromOffset: number,
  toOffset: number,
): Promise<string[]> {
  const fh = await fsp.open(file, 'r');
  try {
    const len = Math.max(0, toOffset - fromOffset);
    const buf = Buffer.alloc(len);
    if (len > 0) {
      await fh.read(buf, 0, len, fromOffset);
    }
    const text = buf.toString('utf8');
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  } finally {
    await fh.close();
  }
}

export async function readJsonlTail(
  file: string,
  maxLines: number,
): Promise<string[]> {
  const stat = await fsp.stat(file);
  const size = stat.size;
  if (size === 0) return [];
  const fh = await fsp.open(file, 'r');
  try {
    const lines: string[] = [];
    let pos = size;
    let pending = '';
    while (pos > 0 && lines.length < maxLines) {
      const chunkSize = Math.min(TAIL_CHUNK_BYTES, pos);
      pos -= chunkSize;
      const buf = Buffer.alloc(chunkSize);
      await fh.read(buf, 0, chunkSize, pos);
      const text = buf.toString('utf8') + pending;
      const split = text.split('\n');
      pending = pos > 0 ? (split.shift() ?? '') : '';
      for (let i = split.length - 1; i >= 0; i--) {
        const line = split[i];
        if (line === '') continue;
        lines.unshift(line);
        if (lines.length >= maxLines) break;
      }
    }
    if (pending.length > 0 && lines.length < maxLines) {
      lines.unshift(pending);
    }
    return lines;
  } finally {
    await fh.close();
  }
}

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const FG_CYAN = '\x1b[36m';
const FG_GREEN = '\x1b[32m';
const FG_YELLOW = '\x1b[33m';
const FG_GRAY = '\x1b[90m';

function ansiDim(text: string): string {
  return `${DIM}${text}${RESET}`;
}

export function formatEvent(event: JsonlEvent): string {
  const type = String(event.type || '');
  if (
    type === 'last-prompt' ||
    type === 'permission-mode' ||
    type === 'file-history-snapshot' ||
    type === 'summary'
  ) {
    return '';
  }
  if (type === 'system') return formatSystem(event);
  if (type === 'user') return formatUser(event);
  if (type === 'assistant') return formatAssistant(event);
  return '';
}

function formatSystem(event: JsonlEvent): string {
  const subtype = typeof event.subtype === 'string' ? event.subtype : '';
  const content = typeof event.content === 'string' ? event.content : '';
  if (!content) return '';
  const label = subtype ? `[system:${subtype}]` : '[system]';
  return `${FG_GRAY}${label} ${content}${RESET}\r\n`;
}

function formatUser(event: JsonlEvent): string {
  const message = (event.message as AnyJson | undefined) || {};
  const content = message.content;
  let out = '';
  if (typeof content === 'string') {
    const text = stripSystemReminders(content).trim();
    if (text) out += `${BOLD}${FG_CYAN}[user]${RESET} ${text}\r\n\r\n`;
  } else if (Array.isArray(content)) {
    for (const block of content as AnyJson[]) {
      const btype = String(block.type || '');
      if (btype === 'text') {
        const t = stripSystemReminders(String(block.text || '')).trim();
        if (t) out += `${BOLD}${FG_CYAN}[user]${RESET} ${t}\r\n\r\n`;
      } else if (btype === 'tool_result') {
        const text = renderToolResult(block);
        if (text) out += `${FG_GRAY}  -> ${text}${RESET}\r\n`;
      }
    }
  }
  return out;
}

function formatAssistant(event: JsonlEvent): string {
  const message = (event.message as AnyJson | undefined) || {};
  const content = message.content;
  let out = '';
  if (Array.isArray(content)) {
    let headerEmitted = false;
    for (const block of content as AnyJson[]) {
      const btype = String(block.type || '');
      if (btype === 'text') {
        const t = String(block.text || '').trim();
        if (!t) continue;
        if (!headerEmitted) {
          out += `${BOLD}${FG_GREEN}[assistant]${RESET}\r\n`;
          headerEmitted = true;
        }
        out += `${t}\r\n`;
      } else if (btype === 'thinking') {
        const t = String(block.thinking || '').trim();
        if (!t) continue;
        out += `${DIM}${FG_GRAY}[thinking] ${truncate(t, 240)}${RESET}\r\n`;
      } else if (btype === 'tool_use') {
        const name = String(block.name || 'tool');
        const input = block.input as AnyJson | undefined;
        out += `${FG_YELLOW}[tool: ${name}]${RESET} ${summarizeToolInput(name, input)}\r\n`;
      }
    }
    if (out.length > 0) out += '\r\n';
  }
  return out;
}

function summarizeToolInput(name: string, input?: AnyJson): string {
  if (!input) return '';
  if (name === 'Bash') {
    return truncate(String(input.command || ''), 240);
  }
  if (name === 'Read' || name === 'Edit' || name === 'Write') {
    return String(input.file_path || input.path || '');
  }
  if (name === 'Glob' || name === 'Grep') {
    const parts: string[] = [];
    if (input.pattern) parts.push(String(input.pattern));
    if (input.path) parts.push(String(input.path));
    return truncate(parts.join('  '), 240);
  }
  if (name === 'TodoWrite') {
    const todos = Array.isArray(input.todos) ? input.todos.length : 0;
    return `${todos} todos`;
  }
  if (name === 'WebFetch') return String(input.url || '');
  return truncate(JSON.stringify(input), 240);
}

function renderToolResult(block: AnyJson): string {
  const content = block.content;
  if (typeof content === 'string') return truncate(content, 240);
  if (Array.isArray(content)) {
    const texts = (content as AnyJson[])
      .filter((c) => String(c.type || '') === 'text')
      .map((c) => String(c.text || ''));
    return truncate(texts.join('\n'), 240);
  }
  return '';
}

function stripSystemReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max - 1) + '…';
}

export function ensureProjectDirSync(worktreePath: string): boolean {
  const dir = workingDirToProjectDir(worktreePath);
  return fs.existsSync(dir);
}
