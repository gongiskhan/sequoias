# Sequoias — History

This is a living log of *why* Sequoias looks the way it does. Code says what; git log says when; this file says **why**, and what was tried, rejected, or considered. It exists because Sequoias is a stepping stone toward a Workspace primitive in a larger project (Garrison), and we don't want to lose the design rationale on the way.

**Update discipline.** Every session that touches the codebase non-trivially should append to the relevant section here before stopping. The Stop hook in `.claude/settings.json` exists to remind future Claude instances of this. See the "How to update" section at the bottom for the same discipline used by the Claude Code memory system — it's not arbitrary; the structure (lead with rule/fact, then **Why:**, then **How to apply:**) survives long after the immediate context is gone.

---

## 1. Genesis (2026-05-07)

### The original spec ("silly-goblet")

The user pasted a single self-contained spec document into a fresh Claude Code session. The full text lives in `~/.claude/plans/sequoias-build-silly-goblet.md`. Key invariants the user committed to in writing:

- **Single user, macOS only, no auth, no telemetry.** State at `~/.sequoias/state.json`. Not a SaaS.
- **No `.wt.config` per-worktree file.** Auto-discover env files; rewrite ports automatically. (This was already a hard-won decision on the user's side; the spec called it out as a non-goal explicitly.)
- **No Electron/Tauri.** Plain Node + browser UI.
- **No tmux.** xterm.js panes in the UI. The user explicitly rejected tmux for this — they'd built tmux-based workspace launchers before (`ct.sh`, `cte` alias) and chose to retire that approach.
- **No project plugin system, no MCP server, no faculties.** Those belong in Garrison; this is the prototype that informs Garrison's Workspace primitive later.
- **No database.** JSON file + in-memory map.
- **No mobile UI / no Tailscale / no QR codes.** Future.
- **No auto-merge, no auto-fix, no AI-assisted PR descriptions.** Manual `gh pr create` only.

The spec also fixed:
- File layout (`src/`, `ui/`, `tests/`)
- Stack (Node 20+, TypeScript, Express, `ws`, node-pty, React 18 + Vite, xterm.js, simple-git, execa, Playwright)
- 14 Playwright e2e cases as the acceptance contract
- An 11-step build order (skeleton → store → ports/env → worktree → UI → pty → hooks → PR/archive → persistence → polish → README)
- Hook command shape (curl-from-shell using `$CLAUDE_PROJECT_DIR`) and the byte-identical settings.json restore requirement

Acceptance criteria (verbatim from spec §11):
1. `pnpm install && pnpm build && pnpm start /path` works on a clean macOS machine.
2. `pnpm test:e2e` passes all 14 cases × 3 consecutive runs, no flakes.
3. `~/.claude/settings.json` restored byte-identical after server stop.
4. UI does what §8 says, no more.
5. Real PR creation works against GitHub.

### First user-driven deviation: npm only

The user rejected pnpm in plan-mode approval: "no pnpm at all! only npm". Plan was edited to use `npm install`, `npm run build`, `npm start`, `npm test`, `npm run test:e2e` throughout. No other deviation from the original spec at this point.

### Advisor's contributions during planning

Before substantive coding, an advisor consultation surfaced three risks the spec under-specified and two the user hadn't articulated:

**Specified more precisely (advisor's input incorporated into plan):**
1. **Settings.json restore must use raw bytes, not JSON roundtrip.** On startup capture original bytes verbatim into memory + `~/.sequoias/settings-snapshot.bytes`. Parse a *separate* copy for runtime mutation. On shutdown, write the original bytes back. JSON.stringify roundtrip would silently change formatting and break test #11.
2. **`_sequoias: true` tag goes on the matcher-group object,** not the inner hook command. Defensive marker for crash recovery; not the primary restore mechanism.
3. **`$CLAUDE_PROJECT_DIR` is fine as-is** — Sequoias launches `claude` with `cwd=worktreePath`, so the env var equals the worktree path and the hook payload's `cwd` field matches `session.worktreePath` on the server side.

**New risks the advisor flagged (added to plan):**
4. **Test isolation via `$HOME` override.** The user's real `~/.claude/settings.json` has 5+ valuable existing hooks (ccm, memory-compiler, status-hook, wrangle). A crashed test could mutate it. Tests *must* spawn the server with `HOME=tmpdir`. Production paths must derive from `os.homedir()` at call time, never module-init.
5. **Orphaned-hook cleanup on startup.** If a previous Sequoias run crashed before restoring, settings.json carries stale `_sequoias: true` entries. On startup, *first* strip them (writing cleaned bytes back), *then* snapshot. Otherwise the snapshot bakes in stale entries and "restore" propagates them forward.

A second advisor call during the build flagged two more issues (both addressed):
6. **`status-working` had no spinner** — spec §8 said "working = green + spinner". Initial CSS only used a static dot. Fixed with a rotating ring.
7. **Auto-launch of `claude` was opt-in by default.** The build had inverted the spec's intent for test compatibility. Flipped: `SEQUOIAS_AUTO_CLAUDE` defaults to on; tests set `=0` in their fixture env. Production matches §7.3 ("spawn pty: cd <worktreePath> && claude").

### Build execution

11-step order from spec §12 followed verbatim. Notable real-world incidents during the build:

- **`node-pty` `posix_spawnp failed`.** On the first session-create attempt, every pty spawn failed. Root cause: `node-pty@1`'s prebuilt `prebuilds/darwin-arm64/spawn-helper` lost its execute bit during npm tarball extraction. Diagnosed via direct `node-pty.fork` calls. Permanent fix: `scripts/fix-pty-helper.cjs` runs as `postinstall`, `chmod +x`'s the helper. This is in the README under "Notes" because it can bite future installs on different machines.
- **DELETE flakes (test #10).** `git worktree remove` raced with pty children still holding cwd handles. Two layers of fix: (a) added `await new Promise(r => setTimeout(r, 80))` between `ptyManager.killSession` and `removeWorktree`, (b) `rmRetry` helper in test fixtures with backoff for cleanup.
- **Settings.json byte-identical on tmpHome.** Verified with explicit SHA-256 comparison in test #11 across both an existing-baseline-file and an absent-file path.

After the 11 steps, ran `npm run test:e2e` 4 times consecutively — all 14 e2e + 12 unit cases passed. Acceptance criteria 1, 2, 3 met by automation; 4 covered by browser smoke; 5 (real GitHub PR) is manual-only.

---

## 2. User-driven changes after initial acceptance (2026-05-07)

### 2.1 Multi-terminal per session

**User request:** "should fire another terminal in the same tab running cortex and the ekoa app... we should have ways to restart and kill the server and app as well"

Initial proposal (accepted): tabbed terminal pane per session. Tab 1 = Claude shell (default). Extra tabs come from a `sequoias.json` at the project root. Each terminal has `name`, `cwd` (relative to worktree), `cmd`, `autostart`, `background`. Background mode (no visible tab, output buffered) deferred until requested.

Implementation: `src/config.ts` loads project-root config; `src/pty-manager.ts` keys ptys by `(projectPath, branch, terminalName)`; `src/routes.ts` exposes `/api/sessions/:branch/terminals` + `/restart` + `/kill`; `ui/components/Terminal.tsx` renders the tab strip; CSS adds tab styling with running/stopped dots.

### 2.2 Hot-reload + retroactive controls

**User screenshot showed only `claude` tab on an existing session and asked:** "does it only work for new sessions? we should have controls to start/stop/restart/kill even for old sessions"

Two real gaps surfaced:
1. Config was read once at server start. Editing `sequoias.json` without restarting Sequoias didn't update the UI.
2. Tab buttons (Restart/Kill icons) were too cryptic. When a terminal was stopped, "restart" was effectively "start" but the icon didn't reflect that.

Fixes:
- `fs.watch` on the project root for `sequoias.json` changes. On change, reparse, replace `configRef.current`, broadcast `config-changed` over WS. UI re-fetches `/api/sessions/:branch/terminals`. Debounce 80ms.
- Buttons made context-aware: stopped terminal → single green Play icon (Start); running terminal → Restart + Stop. Tooltips name the terminal explicitly (`"Start svc-y"`, `"Stop claude"`).
- Retroactive controls confirmed working: any session created before `sequoias.json` existed picks up new tabs immediately and can start/stop them via the same buttons.

### 2.3 Move terminals from sequoias.json to per-project Sequoias state

**User request:** "i meant buttons to control[ ] cortex and the [ekoa] app, not claude!!! although u can leave claude also" → followed by "dont want it on the project, want it h[e]re. make this know about the projects"

The user didn't want terminal config in their repo — they wanted Sequoias itself to remember per-project terminal configs. This was a meaningful design shift.

Implementation:
- `Project.terminals: StoredTerminal[]` added to state.json schema (optional, defaults to `[]`).
- `src/config.ts` collapsed to a thin helper: `validateTerminals` (input validation: alphanumeric names, no `claude` reuse, no duplicates) + `resolveTerminals` (prepends implicit `claude` terminal).
- `fs.watch` of `sequoias.json` removed entirely — config now lives in `~/.sequoias/state.json`.
- `PUT /api/project/terminals` validates, replaces `project.terminals`, persists, broadcasts `config-changed`.
- `ui/components/SettingsDialog.tsx`: gear icon in rail header opens a modal with editable rows (name, cwd, cmd, autostart, delete) and an "Add terminal" button.

Verified via real-browser smoke: settings dialog → add `svc-x` → save → state.json contains `terminals: [{name: "svc-x", ...}]` → create session → both `claude` and `svc-x` tabs spawn. Crucially: zero `sequoias.json` exists in the repo.

### 2.4 Cortex `.env` missing in worktrees

**User pasted:** `[ekoa] fatal error: Error: [startup] FATAL: Supabase not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in cortex/.env`

Root cause traced to `discoverEnvFiles` in `src/env-rewriter.ts`. The walker consulted `.gitignore` to skip ignored paths. But `.env` files are *intentionally* gitignored (line 33 of ekoa-dev's `.gitignore`: `.env`). The walker correctly skipped `cortex/.env`. The root `.env` survived only because of an accidental special-case for top-level files (`if (entryRel !== entry.name && ig.ignores(entryRel)) continue`).

User's diagnosis was on point: "the .env files should be copied when creating the worktrees... using .gitignore was not a bad idea. we just needed to include the .env files as an exception... we should use the git worktree functionality, plus the .env files (edited)".

Final design (matches user's mental model):
- **Tracked content** comes from `git worktree add` automatically. Anything gitignored (node_modules, build outputs, logs) is correctly absent.
- **`.env*` files are explicit exceptions** — Sequoias scans for them and copies them across, regardless of `.gitignore`.
- Scan is shallow: root + first-level subdirs only. Deeper nesting is unusual for env files and would traverse irrelevant directories.
- `.gitignore` is no longer parsed at all.

Also added `POST /api/sessions/:branch/resync-env` + a refresh icon on session cards for healing existing worktrees that were created before the fix. Endpoint re-discovers main env files, copies any missing into worktree, allocates ports for newly-seen `_PORT` keys, rewrites in place. Idempotent (allocations are deterministic per `<branch>:<service>`).

The user's existing `local-exec` worktree was healed manually with a one-shot `cp ~/dev/ekoa-dev/cortex/.env ~/.worktrees/ekoa-dev/local-exec/cortex/.env`.

**Open question for future projects:** are there other gitignored files that need to come across (`.npmrc` with auth tokens, credential JSONs, `.claude/settings.local.json`)? Not for ekoa-dev. If we ever hit one, add an "Extra files to sync" field to project settings. Deferred until needed.

---

## 3. Side-quests (not Sequoias work, captured for posterity)

These were mid-session distractions resolved while building Sequoias. Not part of Sequoias' core history but worth recording so future-us doesn't re-investigate.

### 3.1 `.zshrc` line 82 sourced a missing `ct.sh`

User's `~/.zshrc` had a `source ~/.claude/scripts/ct.sh` line and a dependent `cte` alias for an old tmux-based workspace launcher (precursor to Sequoias). The script had been moved to `~/.claude-backups/architectus-20260423-135126/scripts/ct.sh` and only the source line remained, producing `no such file or directory` warnings on every shell. Lines 81-84 deleted from `.zshrc`; backup at `~/.zshrc.bak.1778187164`.

### 3.2 cortex `ReferenceError` post-merge

After the user merged `origin/local-executor` into `local-exec` with `-X ours`, two functions were referenced in `cortex/src/server.ts` but never imported (pre-existing bug exposed by the merge): `handlePollPairing` (line 462) and `attachBridgeWs` (line 1065). Added imports from `./bridge/pairing-handler.js` and `./bridge/ws-server.js` respectively. Pre-existing unrelated type error in `automation/engine.ts:1639` (`PageHandle` vs `Page`) was not blocking startup so left alone.

---

## 4. Memory snapshot

This project's auto-memory store lives at `~/.claude/projects/-Users-ggomes-dev-sequoias/memory/`. Mirroring relevant entries here so the document is self-contained.

*(No memory entries captured yet — this section will fill as the project gathers usage feedback.)*

---

## 5. How to update this document

This section borrows the discipline from the Claude Code auto-memory system, which has a tested structure for what makes an entry worth keeping versus noise.

### What to capture

- **Decisions and their motivations.** Especially when a path was considered and rejected. Code shows the chosen path; this file shows why the alternatives were dropped.
- **Surprising user feedback.** Both corrections ("no pnpm") and validations ("don't want it on the project, want it here") shape the tool. Save *why* the user said it, so edge cases later can be judged consistently.
- **Real incidents.** The `posix_spawnp` debugging, the `.gitignore`/`cortex/.env` interaction. Future-us re-encountering similar symptoms can grep for prior context.
- **Constraints from the broader project (Garrison).** Sequoias is a prototype; design choices that exist *because* of how they'd graduate into Garrison's Workspace primitive belong here.

### What NOT to capture

- File paths and module structure that `ls` and `grep` find faster.
- Code patterns the source already shows.
- Git activity that `git log` covers.
- One-off fix recipes — the fix is in the code, the commit message has its own context.
- Restating CLAUDE.md content. CLAUDE.md is operating manual; HISTORY.md is rationale.

### How to phrase entries

For decisions:

```
**Decision/rule (one sentence).**

Why: <the constraint, the prior incident, the rejected alternative>.
How to apply: <when this rule kicks in, what edge cases it covers>.
```

For incidents:

```
**Symptom + 1-line summary of root cause.**

What was tried and dropped, what worked, where the fix lives now.
```

Don't pad. A clear sentence is better than a clear paragraph.

### When to update

- Before declaring done on any non-trivial change, append to the relevant section.
- When the user explicitly redirects ("don't do X anymore"), capture the redirect.
- When you investigate something that doesn't end up changing code (rejected hypotheses, dead ends), note them — they save future investigation time.
- The Stop hook in `.claude/settings.json` emits a reminder via stderr at every turn-end as a safety net. Don't rely on it; update proactively.
