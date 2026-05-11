import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

// Frontend alias keys — must be a subset of DIR_PORT_ALIASES in env-rewriter.ts.
// We patch package.json files in directories whose basename is in this set,
// to avoid touching backend or unrelated packages. Backends like cortex don't
// reference `${PORT:-N}` in their dev script (they read process.env.PORT after
// dotenv loads), so they don't need the same rewrite.
const FRONTEND_DIRS = new Set([
  'ekoa-app',
  'ekoa_app',
  'ekoa',
  'app',
  'frontend',
  'web',
  'ui',
  'next',
  'client',
]);

const PORT_DEFAULT_RE = /\$\{PORT:-(\d+)\}/g;
const SEQUOIAS_MARKER = 'SEQUOIAS_FRONTEND_PORT';

// Tools whose CLI binds a port from process.env.PORT BEFORE any user code
// (and therefore before any dotenv load). For these we have to inject an
// explicit -p / --port flag — `${PORT:-N}` expansion in a script string
// only fills argv slots; it does not export PORT to the child env.
//
// Each entry: pattern to match the bare command, and the flag-form to inject
// right after it. The fallback-chain in the value uses SEQUOIAS_FRONTEND_PORT
// as the second-tier default so this works inside Sequoias-spawned shells
// AND in bare shells (where it falls through to the original numeric default).
type PortFlagRule = {
  // Regex fragment matching the bare CLI invocation, as a literal substring
  // followed by a word boundary (so `next dev` matches but `next devx` doesn't).
  command: string;
  // Default port hardcoded in the original tool (used as final fallback).
  defaultPort: number;
};

const PORT_FLAG_TOOLS: PortFlagRule[] = [
  { command: 'next dev', defaultPort: 3000 },
  { command: 'next start', defaultPort: 3000 },
  { command: 'vite dev', defaultPort: 5173 },
  { command: 'vite preview', defaultPort: 4173 },
];

// Detect whether the script already supplies a parameterized port flag in
// the same command segment as `cmd`. We bound the search by chaining
// operators (`&&`, `||`, `;`, `|`) so a `-p` in a later command doesn't
// fool us into thinking the target tool has its port covered.
function commandHasPortFlag(script: string, cmd: string): boolean {
  const escaped = cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${escaped}\\b[^&;|]*?(?:-p\\s|--port[=\\s])`);
  return re.test(script);
}

// Patch frontend package.json dev scripts in the worktree so they fall back
// to `${PORT:-${SEQUOIAS_FRONTEND_PORT:-N}}` instead of `${PORT:-N}`. This
// makes `npm run dev` from the worktree-root orchestrator (or any context
// where shell PORT is unset) bind the worktree's allocated frontend port,
// without Sequoias having to set shell PORT (which would collide with backends
// that read process.env.PORT and use dotenv-default no-overwrite).
//
// Idempotent: scripts already containing `SEQUOIAS_FRONTEND_PORT` are skipped.
// Conservative: only rewrites the literal `${PORT:-<digit>+}` pattern in
// script values; does not touch unrelated keys, non-frontend packages, or
// scripts without the pattern.
//
// Returns the list of relative package.json paths that were modified.
export async function patchFrontendDevScripts(
  worktreeRoot: string,
): Promise<string[]> {
  const modified: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(worktreeRoot, { withFileTypes: true });
  } catch {
    return modified;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!FRONTEND_DIRS.has(entry.name.toLowerCase())) continue;
    const pkgPath = path.join(worktreeRoot, entry.name, 'package.json');
    if (!fs.existsSync(pkgPath)) continue;

    let raw: string;
    let parsed: { scripts?: Record<string, string> };
    try {
      raw = await fsp.readFile(pkgPath, 'utf8');
      parsed = JSON.parse(raw);
    } catch {
      continue; // malformed package.json — leave alone
    }
    if (!parsed.scripts || typeof parsed.scripts !== 'object') continue;

    let changed = false;
    for (const [key, val] of Object.entries(parsed.scripts)) {
      if (typeof val !== 'string') continue;
      let rewritten = val;

      // Step 1: rewrite `${PORT:-N}` argv-fallbacks (e.g. kill-port.sh's
      // arg) to the SEQUOIAS_FRONTEND_PORT-aware fallback chain. Idempotent
      // via direct check on the marker substring.
      if (!rewritten.includes(SEQUOIAS_MARKER)) {
        rewritten = rewritten.replace(
          PORT_DEFAULT_RE,
          '${PORT:-${SEQUOIAS_FRONTEND_PORT:-$1}}',
        );
      }

      // Step 2: for tools that bind from process.env.PORT directly (Next.js,
      // Vite, …) inject an explicit -p flag with the same fallback chain.
      // Without this, even with the env var set, `next dev` binds Next's
      // hardcoded 3000 because parameter expansion in the shell args
      // doesn't export PORT to the child process.
      // Per-tool idempotency: skip if the command segment already carries
      // a parameterized -p / --port flag.
      for (const rule of PORT_FLAG_TOOLS) {
        if (!rewritten.includes(rule.command)) continue;
        if (commandHasPortFlag(rewritten, rule.command)) continue;
        const escaped = rule.command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`\\b${escaped}\\b`);
        rewritten = rewritten.replace(
          re,
          `${rule.command} -p \${PORT:-\${SEQUOIAS_FRONTEND_PORT:-${rule.defaultPort}}}`,
        );
      }

      if (rewritten !== val) {
        parsed.scripts[key] = rewritten;
        changed = true;
      }
    }
    if (changed) {
      // Preserve trailing newline if the original had one — matches npm's
      // own write conventions.
      const trailing = raw.endsWith('\n') ? '\n' : '';
      await fsp.writeFile(pkgPath, JSON.stringify(parsed, null, 2) + trailing);
      modified.push(path.relative(worktreeRoot, pkgPath));
    }
  }
  return modified;
}
