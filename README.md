# Sequoias

Local desktop dashboard for managing parallel Claude Code sessions across git worktrees. One process, one browser tab; no cloud, no auth, no telemetry.

Single user, macOS only, Node 20+.

## Install

```
npm install
npm run build
```

## Run

```
npm start -- /path/to/your/repo
npm start -- /path/to/your/repo --port 8888
npm start -- /path/to/your/repo --ide rebased
```

The repo path must be a git repo. Sequoias places worktrees under `~/.worktrees/<repo>/<branch-slug>` and persists state at `~/.sequoias/state.json`. It registers Claude Code hooks at `~/.claude/settings.json` on startup and removes them byte-identically on shutdown.

Open `http://localhost:7777`.

## What you can do

- **Create a session.** Click *New session*, type a branch name, pick a base branch. Sequoias creates the worktree, copies and rewrites every `.env*` file with conflict-free ports (deterministic per `<branch>:<service>`), and spawns a terminal in the worktree.
- **Switch between sessions.** Click any card in the left rail to focus its terminal. Sessions sort by status: waiting → working → idle → errored → dead.
- **Open Claude Code.** Each new session auto-launches `claude` in its terminal. Status badges update from hook events: green/working when Claude is processing, amber/waiting when it needs input, gray/idle after each turn. To suppress auto-launch (e.g. when you want to start with `claude --resume`), set `SEQUOIAS_AUTO_CLAUDE=0` before starting Sequoias.
- **Multiple terminals per session.** Click the gear icon next to *New session* to define extra terminals — services, servers, anything you'd otherwise launch in another window. Each terminal gets a `name`, a `cwd` (relative to the worktree root), a `cmd` (sent to the spawned shell with a trailing Enter), and an `autostart` flag. Each one receives the session's allocated ports as `SEQUOIAS_PORT_<NAME>` env vars. Per-tab Start / Restart / Stop controls live in the tab strip; archiving a session kills all its terminals. Configuration is stored per-project in `~/.sequoias/state.json`, not in your repo.
- **Create a PR.** Click the PR icon. Pushes the branch and runs `gh pr create --fill`. The resulting URL appears on the card.
- **Archive.** Click the trash icon. Removes the worktree (and optionally the branch).

## Manual sanity check

After `npm start -- /path/to/real/repo`, open the UI and create one session. In its terminal run `claude`, ask "what is 2+2", and confirm the status badge cycles **working → idle** as Claude responds. This is the smoke test no automation fully replaces.

## Tests

```
npm test           # unit tests for ports + env-rewriter
npm run test:e2e   # Playwright e2e (14 cases, browser-driven)
```

The e2e suite spawns the server with an isolated `$HOME` per test, so it never touches your real `~/.claude/settings.json` or `~/.sequoias/`.

## Notes

- **`spawn-helper` postinstall fix.** `node-pty@1` ships a prebuilt `spawn-helper` that loses its execute bit during npm tarball extraction on some setups, causing `posix_spawnp failed`. `scripts/fix-pty-helper.cjs` re-`chmod +x`'s it.
- **Concurrent edits to `~/.claude/settings.json` while Sequoias is running** are clobbered on shutdown. Sequoias snapshots the file at startup, restores those exact bytes on shutdown, and does not merge in changes made by other tools mid-run. Don't edit settings.json while Sequoias is up.

## Architecture summary

- `src/server.ts` — Express + WebSocket. Boots store, installs hooks, registers routes, starts PtyManager.
- `src/store.ts` — JSON state at `~/.sequoias/state.json`. Atomic writes, debounced saves, WS broadcast on every change.
- `src/ports.ts` — Deterministic FNV-1a port allocation per `<branch>:<service>` with `lsof` linear-probing.
- `src/env-rewriter.ts` — Discover `.env*` files (respecting `.gitignore`), rewrite ports per-file scope, rewrite localhost URLs that reference main-checkout ports.
- `src/worktree.ts` — `git worktree add/remove`, env file copy/rewrite, `.sequoias-meta.json`.
- `src/pty-manager.ts` — `node-pty` shells per session, WS terminal bridge, 60s idle fallback.
- `src/claude-hooks.ts` — Non-destructive merge of Sequoias hooks into `~/.claude/settings.json`; byte-identical restore on SIGTERM/SIGINT.
- `src/routes.ts` — REST endpoints + `/_hook` receiver.
- `ui/` — React 18 + Vite. Dark mode only. xterm.js terminal pane.
