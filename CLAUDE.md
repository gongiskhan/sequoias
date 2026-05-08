# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Sequoias is a local Node.js dashboard for managing parallel Claude Code sessions across git worktrees on a single Mac. One process serves a React UI on port 7777 (configurable). Single user, no auth, no telemetry. State persists in `~/.sequoias/state.json`. Built per a strict spec — see `~/.claude/plans/sequoias-build-silly-goblet.md` for the original spec.

**Read `HISTORY.md` first** for design rationale, prior decisions, and why specific paths were rejected. CLAUDE.md tells you *how* to operate the codebase; HISTORY.md tells you *why* it looks the way it does. After any non-trivial change, append to the relevant section of HISTORY.md before stopping — there's a Stop hook in `.claude/settings.json` that nudges if you forget. The discipline for entries is in HISTORY.md section 5 (lead with the rule/fact, then **Why:**, then **How to apply:**).

## Commands

```
npm install        # also runs scripts/fix-pty-helper.cjs (see "node-pty quirk" below)
npm run build      # vite build (UI -> dist/ui) + tsc (server -> dist/server)
npm start -- <repo-path> [--port 7777] [--ide <command>]
npm test           # node:test unit suite (tests/unit/*.test.ts via tsx)
npm run test:e2e   # full Playwright e2e suite (14 cases)
```

Single test: `npx playwright test tests/e2e/full-flow.spec.ts -g "8. sessions sort"` or `node --test --import tsx tests/unit/ports.test.ts`.

`npm run dev` is incomplete — it watches TypeScript and runs Vite but does not actually start the server. Use `npm start` for end-to-end runs.

## Architecture

### Process / data flow

```
CLI (src/cli.ts)
  → startServer (src/server.ts)
      ├── loadStore           → reads ~/.sequoias/state.json
      ├── ensureProject       → keys per-project under state.projects[absolutePath]
      ├── installHooks        → merges Sequoias hooks into ~/.claude/settings.json
      ├── PtyManager          → spawns shells per (project, branch, terminal)
      ├── Express + WS        → REST API + /ws/terminal + /ws/events
      └── close()             → killAll ptys → flush state → restoreHooks
```

A "session" = one git worktree at `~/.worktrees/<repo>/<branch-slug>` running N "terminals". Each terminal is a `node-pty` shell with the worktree as cwd, configured via `Project.terminals`. There is always an implicit `claude` terminal first; user-defined terminals come from `Project.terminals` in state.json (edited via the UI gear button — they live in Sequoias state, NOT in the user's repo).

### State shape

`State.projects` is keyed by absolute repo path. Each `Project` holds `sessions` (keyed by branch name) and `terminals` (the user-defined extras). `Session.ports` is `{ <serviceName>: <number> }` — services are derived from env-file `*_PORT` keys (e.g. `CORTEX_PORT` → service `cortex`).

### Status state machine (`src/status.ts`)

Driven entirely by Claude Code hooks. The `claude` terminal's pty cwd matches the worktree path, which matches `$CLAUDE_PROJECT_DIR` in hook payloads. The `/_hook` endpoint in `routes.ts` matches incoming `cwd` to `session.worktreePath` and applies:

- `UserPromptSubmit` → `working`
- `Stop` → `idle`
- `Notification` → `waiting`
- pty exit code 0 / non-0 → `dead` / `errored`
- 60s of `working` with no hook event but recent pty output → `idle` (fallback)

### `~/.claude/settings.json` lifecycle (`src/claude-hooks.ts`)

This is the most fragile part. The contract is **byte-identical restoration on shutdown**.

1. On startup: read original bytes, parse a copy, strip any matcher groups tagged `_sequoias: true` (orphan cleanup from prior crashed runs), write cleaned bytes back if changed.
2. Snapshot the cleaned bytes to `~/.sequoias/settings-snapshot.bytes` plus a meta file recording `existedBefore`.
3. Inject Sequoias matcher-group entries on `UserPromptSubmit`, `Stop`, `Notification`. The tag `_sequoias: true` lives on the matcher-group object, not the inner command. Each command is a `curl` to `/_hook` using `$CLAUDE_PROJECT_DIR`.
4. On SIGINT/SIGTERM: write the snapshot bytes back verbatim. If `!existedBefore`, unlink. Never re-stringify the original — JSON.stringify roundtrip would lose user formatting.

Test #11 in the e2e suite verifies SHA-256 equivalence pre/post-run.

### Port allocation (`src/ports.ts`)

FNV-1a hash of `<branch>:<service>` modulo a per-service range, then `lsof` linear-probe up to 50 ports forward. Same `(branch, service)` always yields the same port — critical for restart resilience and for users who memorize ports. Defaults: `cortex 4000-4999`, `ekoa_app 5000-5999`. Unknown services hash into 1000-port bands starting at 6000.

### Env file rewriting (`src/env-rewriter.ts`)

`.env*` files are copied from main checkout → worktree, then rewritten in place. **Discovery does not consult `.gitignore`** — `.env*` files are intentionally gitignored and we explicitly bring them across. Scan is shallow (root + first-level subdirs only) to avoid traversing deep into vendored dirs. Rewriting rules per file (per-file scope, never cross-pollinate keys):

- Keys matching `*_PORT` → allocate a new port keyed on the service inferred from the key (`CORTEX_PORT` → `cortex`; `NEXT_*` / `*_APP` / `*_FRONTEND` → `ekoa_app`; otherwise lowercase prefix).
- URL values containing `localhost:<oldPort>` or `127.0.0.1:<oldPort>` where `<oldPort>` is in the main checkout's port map → substitute the corresponding worktree port.

Anything else in `.gitignore` (node_modules, build outputs, logs) is correctly absent in the worktree because `git worktree add` only checks out tracked files.

## Test isolation (critical)

Every e2e test spawns the server with `HOME=tmpdir`, `SEQUOIAS_AUTO_CLAUDE=0`, and a mock `gh` in PATH. This is why tests can't corrupt the real `~/.claude/settings.json` even on crash. All paths in production code derive from `os.homedir()` at call time (not module init) so the override propagates. Don't introduce module-level path constants — they will silently bypass test isolation.

Per-test fixture: `tests/fixtures/fake-repo.ts` creates a real git repo + a bare-repo origin (so `gh pr create`'s implicit `git push -u origin <branch>` works in the PR test).

## Important runtime quirks

- **node-pty `spawn-helper`.** `node-pty@1`'s prebuilt `prebuilds/darwin-arm64/spawn-helper` loses its execute bit during npm tarball extraction on some systems, causing every `pty.spawn` to fail with `posix_spawnp failed`. `scripts/fix-pty-helper.cjs` runs as `postinstall` to `chmod +x` it. If you see that error, run `npm install` again or chmod the file directly.
- **Auto-launch of `claude`.** New sessions auto-`claude\r` into the claude terminal by default. Set `SEQUOIAS_AUTO_CLAUDE=0` to spawn just a shell — required when the embedded terminal needs to be scripted (e.g. in tests).
- **State writes are debounced 50ms.** Routes that need to read state.json synchronously after a mutation (DELETE, session create) call `store.flush()` before responding. The shutdown path also flushes before restoring hooks.

## Acceptance criteria

The 14 e2e cases in `tests/e2e/full-flow.spec.ts` and the 12 unit cases in `tests/unit/` are the contract. Run `npm run test:e2e` three times consecutively before declaring a non-trivial change done — single passes have hidden flakes around pty cleanup races.
