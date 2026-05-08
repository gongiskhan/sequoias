import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { allocatePort } from './ports.js';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  'coverage',
  '.turbo',
  '.cache',
  '.vercel',
  '.serverless',
  'out',
  'tmp',
]);

const ENV_FILE_RE = /^\.env(\..+)?$/;

export type EnvRewriteResult = {
  envFiles: string[];
  ports: Record<string, number>;
};

export type EnvRewriteOptions = {
  branch: string;
  mainPortMap: Record<number, { service: string; key: string }>;
  reserved?: Set<number>;
};

export async function discoverEnvFiles(rootDir: string): Promise<string[]> {
  // .env files are intentionally gitignored — discovery deliberately ignores
  // .gitignore. We scan root + first-level subdirs only; deeper nesting is
  // unusual for env files and would hit irrelevant directories.
  const out: string[] = [];

  const collect = (dir: string, rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!ENV_FILE_RE.test(entry.name)) continue;
      const entryRel = rel ? path.posix.join(rel, entry.name) : entry.name;
      out.push(entryRel);
    }
  };

  collect(rootDir, '');

  let topEntries: fs.Dirent[];
  try {
    topEntries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return out.sort();
  }
  for (const entry of topEntries) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith('.')) continue;
    collect(path.join(rootDir, entry.name), entry.name);
  }

  return out.sort();
}

export function readMainPortMap(
  rootDir: string,
  envFiles: string[],
): Record<number, { service: string; key: string }> {
  const map: Record<number, { service: string; key: string }> = {};
  for (const rel of envFiles) {
    const abs = path.join(rootDir, rel);
    let content: string;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      const [, key, rawValue] = m;
      const value = rawValue.replace(/^['"](.*)['"]$/, '$1');
      const portFromKey = isPortKey(key) ? Number(value) : NaN;
      if (Number.isFinite(portFromKey) && portFromKey > 0 && portFromKey < 65536) {
        map[portFromKey] = { service: serviceForKey(key), key };
      }
      const urlPortRe = /(?:localhost|127\.0\.0\.1):(\d{2,5})/g;
      let urlMatch: RegExpExecArray | null;
      while ((urlMatch = urlPortRe.exec(value))) {
        const port = Number(urlMatch[1]);
        if (port > 0 && port < 65536 && !(port in map)) {
          map[port] = { service: serviceForKey(key), key };
        }
      }
    }
  }
  return map;
}

export function isPortKey(key: string): boolean {
  return /(^|_)PORT(_|$)/i.test(key);
}

export function serviceForKey(key: string): string {
  const upper = key.toUpperCase();
  if (upper.includes('CORTEX')) return 'cortex';
  if (upper.includes('NEXT') || upper.includes('APP') || upper.includes('FRONTEND')) {
    return 'ekoa_app';
  }
  const prefixMatch = key.match(/^([A-Z][A-Z0-9]*?)(?:_PORT.*)?$/i);
  if (prefixMatch && prefixMatch[1]) {
    return prefixMatch[1].toLowerCase();
  }
  return key.toLowerCase();
}

type ParsedLine =
  | { kind: 'plain'; raw: string }
  | {
      kind: 'kv';
      indent: string;
      key: string;
      quoteChar: string;
      value: string;
    };

function parseLine(line: string): ParsedLine {
  const m = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!m) return { kind: 'plain', raw: line };
  const [, indent, key, rawValue] = m;
  const quoted = rawValue.match(/^(['"])(.*)\1\s*$/);
  const quoteChar = quoted ? quoted[1] : '';
  const value = quoted ? quoted[2] : rawValue;
  return { kind: 'kv', indent, key, quoteChar, value };
}

export async function rewriteEnvFiles(
  worktreeRoot: string,
  envFiles: string[],
  opts: EnvRewriteOptions,
): Promise<EnvRewriteResult> {
  const ports: Record<string, number> = {};
  const reserved = opts.reserved ?? new Set<number>();

  const fileContents: { rel: string; lines: ParsedLine[]; original: string }[] = [];
  const servicesNeeded = new Set<string>();

  for (const rel of envFiles) {
    const abs = path.join(worktreeRoot, rel);
    let content: string;
    try {
      content = await fsp.readFile(abs, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/).map(parseLine);
    fileContents.push({ rel, lines, original: content });
    for (const line of lines) {
      if (line.kind !== 'kv') continue;
      if (isPortKey(line.key)) {
        servicesNeeded.add(serviceForKey(line.key));
      }
      const urlPortRe = /(?:localhost|127\.0\.0\.1):(\d{2,5})/g;
      let m: RegExpExecArray | null;
      while ((m = urlPortRe.exec(line.value))) {
        const oldPort = Number(m[1]);
        const mainEntry = opts.mainPortMap[oldPort];
        if (mainEntry) servicesNeeded.add(mainEntry.service);
      }
    }
  }

  for (const service of servicesNeeded) {
    ports[service] = await allocatePort(opts.branch, service, { reserved });
  }

  for (const file of fileContents) {
    const out: string[] = [];
    for (const line of file.lines) {
      if (line.kind === 'plain') {
        out.push(line.raw);
        continue;
      }
      let { value } = line;
      if (isPortKey(line.key)) {
        const service = serviceForKey(line.key);
        const port = ports[service];
        if (port != null) value = String(port);
      }
      value = value.replace(/(localhost|127\.0\.0\.1):(\d{2,5})/g, (match, host, p) => {
        const oldPort = Number(p);
        const mainEntry = opts.mainPortMap[oldPort];
        if (!mainEntry) return match;
        const newPort = ports[mainEntry.service];
        if (newPort == null) return match;
        return `${host}:${newPort}`;
      });
      out.push(`${line.indent}${line.key}=${line.quoteChar}${value}${line.quoteChar}`);
    }
    await fsp.writeFile(path.join(worktreeRoot, file.rel), out.join('\n'));
  }

  return { envFiles, ports };
}
