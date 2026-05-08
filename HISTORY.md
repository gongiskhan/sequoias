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

## 2.5 IDE coexistence + multi-project + theme + responsive + Tailscale (2026-05-08)

### 2.5.1 What changed in one paragraph

The user uses Rebased (a JetBrains-family fork) for heavier development and wants Sequoias to coexist: monitor Claude Code sessions launched in the IDE alongside the ones it spawns, expose the dashboard over Tailscale to the phone, juggle multiple projects in one rail, and look good in light or dark with system-sync. State now carries a `globalConfig` block (`theme`, `idePath`, `host`, `projects[]`); the CLI's repo path is optional; the server binds `0.0.0.0` by default and prints every reachable URL on startup; the rail is a collapsible project tree; an always-present read-only `claude-live` tab tails `~/.claude/projects/<encoded-cwd>/*.jsonl`, formatted as ANSI in the existing xterm pane.

### 2.5.2 Network exposure trust posture

**Sequoias now binds `0.0.0.0` by default. No auth. Mutating routes (POST/PATCH/DELETE for projects, sessions, globalConfig) are reachable from any LAN host that can dial the port.**

**Why:** the user explicitly opted into phone-over-Tailscale. The advisor flagged this as a step up from loopback-only and asked us to document it before merge so a future hardening pass doesn't regress the user's intent. Tailscale is the intended remote path; trusting the LAN is acceptable on a solo dev machine.

**How to apply:** anyone tightening this back to loopback-only must do so via `--host` or `globalConfig.host`, not by editing the listener hardcode. Future hardening candidates (token-in-URL, mTLS via Tailscale identity, allowlist of remote IPs) belong in this section as planned work — not as silent regressions to the default.

### 2.5.3 Read-only JSONL tab as a virtual PTY entry

**`PtyManager` now hosts entries that don't own a `pty`.** The new `jsonl` kind plumbs through the same WebSocket protocol (`/ws/terminal`) and the same xterm pane on the frontend, but its data source is a `JsonlTailer` polling `~/.claude/projects/<encoded-cwd>/*.jsonl` at 1s. Polling, not `fs.watch` — claude-control found `fs.watch` flaky on macOS and the polling cost is negligible. Rotation is detected by mtime change; on rotation the tailer emits a visible `── new claude session ─────` separator and resets the byte offset. Truncation/replace falls back to the same offset reset.

**Why:** the user wants visibility into IDE-launched Claude Code sessions without reimplementing the rendering pipeline. Reusing the tab strip + xterm avoids a parallel rendering surface and keeps the DX consistent ("it's just another terminal"). The interactive `claude` tab (pty, auto-runs `claude\r`) and the observer `claude-live` tab (jsonl, read-only) coexist on every session.

**How to apply:** when adding new tab kinds (e.g. log files, Render service logs, deploy output), add a new value to the `kind` discriminator and a corresponding source class — don't fork `TerminalPane`. Read-only tabs set `disableStdin` on xterm and skip the `onData` → ws bridge.

### 2.5.4 Path encoding for transcript files: `/` AND `.` both become `-`

**Claude Code escapes a working directory into its `~/.claude/projects/` directory name by replacing both `/` and `.` with `-`,** so `/Users/x/.worktrees/foo/feature` lands at `~/.claude/projects/-Users-x--worktrees-foo-feature/`. Note the double-dash from the leading-dot segments.

**Why:** verified empirically by listing `~/.claude/projects/` on the user's machine before shipping the tailer (per advisor's pre-impl check). claude-control's `workingDirToProjectDir` only handles `/` → `-` and is buggy for any directory that lives under a hidden segment like `.worktrees` or `.claude`. Sequoias uses the corrected formula.

**How to apply:** if Claude Code's encoding ever changes (e.g. lowercased, hash-prefixed, etc.), the failure mode is silent — the JSONL tab will say "no transcripts yet" forever. The recovery is `ls ~/.claude/projects/ | head` against a real working session and re-deriving the formula.

### 2.5.5 Project IDs in URLs are FNV-1a 8-hex of the absolute path

**Routes are keyed by `projectIdFor(absPath) = fnv1a32(absPath).toString(16).padStart(8, '0')`** — not by URL-encoded paths. State stays keyed by absolute path internally; the ID is derived on demand. The same FNV-1a hash already lives in `src/ports.ts` for service port allocation.

**Why:** `/api/projects/%2FUsers%2Fggomes%2Fdev%2Ffoo/sessions/...` is brittle (any client that forgets to encode breaks). 8 hex chars are stable, short, and survive being typed into a URL bar by hand.

**How to apply:** never rename a project's absolute path and expect the same ID. If the user moves a repo, the project disappears from the UI and a new entry appears with a new ID — fine for a personal tool, would need migration logic for a multi-user variant.

### 2.5.6 Legacy single-project routes kept as soft aliases

`/api/project`, `/api/sessions/:branch`, `/api/branches`, `/api/config`, `/api/project/terminals` continue to work — they resolve to the *first* project in `Object.values(store.data.projects)`. The id-keyed routes (`/api/projects/:id/...`) are the canonical surface and the UI uses them exclusively.

**Why:** the e2e suite pre-dates project IDs and tests the legacy routes directly via raw HTTP. Migrating those tests to id-keyed URLs in the same change as the route restructure was deemed dead weight by the advisor (drop the alias layer). I kept them anyway because (a) the test fixture is a single-project setup so "first project" is unambiguous, and (b) the legacy alias is ~50 lines of mechanical delegation that doesn't bear any semantic load. Future cleanup: when a test or external client needs id-keyed routes, migrate that one and let the alias rot.

**How to apply:** new routes go id-keyed only. Don't add new legacy aliases.

### 2.5.7 Default active tab stays `claude`, not `claude-live`

A first cut defaulted `<Terminal>` to the `claude-live` jsonl tab (because the new feature was the headline). Test 14 (terminal IO round-trip through xterm + WS) immediately broke: typing into a read-only tab does nothing.

**Default active tab is `claude` (interactive pty).** The `claude-live` tab is a deliberate click — observer mode, used when Claude is being driven from somewhere else.

**Why:** the user's primary mental model is "click a session, get a live shell." The IDE-coexistence feature is a secondary affordance; making it the default punishes the common case. Test 14 is a useful canary for this kind of regression.

### 2.5.8 What was deliberately NOT borrowed from claude-control

Per the plan, only `workingDirToProjectDir` (corrected) and `readJsonlTail` were ported. The following were considered and explicitly deferred:

- **Process-tree-based discovery** (`ps`/`lsof`): unnecessary because hooks already tell us which worktrees have active Claude Code instances. Adding `ps` polling on top is duplicate state.
- **Terminal-app integration** (AppleScript for Terminal.app/iTerm/Ghostty/etc.): out of scope; we have our own xterm tabs.
- **Cost/token tracking, PR status badge polling, conversation preview cards, task summaries, desktop notifications, keyboard shortcuts (1-9 to select session)**: each of these is genuinely useful but expands scope. They are listed here so a future "make Sequoias more like claude-control" task starts from a known shortlist.
- **Heuristic status classifier** (CPU + JSONL mtime fallback): the existing 60s pty-output fallback in `pty-manager.ts:130-137` covers the common "Stop hook missed" case; layering CPU sampling on top would obscure causality.

---

## 2.6 Port allocator out-of-range bug + PWA + UX polish (2026-05-08)

### 2.6.1 The 4111 collision

User hit `EADDRINUSE: address already in use 0.0.0.0:4111` running cortex against the `bug-fixes` worktree. State.json showed the worktree was assigned `api: 73753` — **above the 65535 TCP max**. cortex couldn't bind that port, fell back to the hardcoded default `4111`, which was already taken by the main checkout's cortex.

**Root cause:** `src/ports.ts` `rangeFor()` used `slot = fnv1a32(service) % 100`, allowing fallback bands to start as high as `6000 + 99*1000 = 105000`. Any service whose hash slot was ≥ 60 produced an entirely invalid TCP range.

**Fix:** cap slots to `Math.floor((MAX_TCP_PORT - FALLBACK_BAND_START + 1) / FALLBACK_BAND_SIZE)` (= 59 with current constants), so all bands stay in `[6000, 64999]`. Added a regression test (`rangeFor: every service name lands within TCP port range`) plus a 100-iteration property test on `basePort`.

**Why this didn't bite earlier:** the original `cortex` and `ekoa_app` are explicit ranges (4000-4999 and 5000-5999). Only ad-hoc service names like `api`, `ui`, `ekoa_streaming_allowed_origins` hit the fallback hash; some happened to land in valid bands (`ui` → 13000s) and some didn't (`api` → 73000s). Plain bad luck on which keys appeared in the user's `.env` files.

**How to apply:** existing sessions with ports > 65535 in state.json need re-allocation. Click the **Sync env** button on the affected session card — `resyncEnvFiles` re-allocates and rewrites the env files. New ports will differ from the old ones (different band) but are stable per `(branch, service)` from now on.

### 2.6.2 Open-in-browser port chips

Each port on the session card / main header is now a clickable chip linking to `http://<window.location.hostname>:<port>` in a new tab. Uses the page's hostname so it works correctly when accessed over Tailscale (the chip respects the same host the user is browsing from). Chrome opens the worktree's app; Safari does the same.

**Design note:** chips render as `<key>:<value> ↗` (key dim, value bold, external-link icon). The colon is a real DOM node (`<span class="port-chip-sep">:</span>`) — initial implementation used a CSS `::after` pseudo-element, which Playwright's `toContainText` can't read because it tests `textContent`, not `innerText`. Test 2 (`creates a session with allocated ports`) regressed and surfaced this within minutes.

### 2.6.3 xterm selection

`TerminalPane`'s xterm theme now reads `--terminal-selection` and `--terminal-selection-inactive` from CSS vars. Selection was previously invisible because xterm fell back to its default which assumed black-on-white.

### 2.6.4 PWA install

Added `ui/public/manifest.webmanifest`, `ui/public/sw.js`, `ui/public/icon.svg`, manifest + apple-touch-icon meta in `index.html`, and SW registration in `main.tsx`. The service worker is intentionally minimal — it never intercepts `/api/`, `/ws/`, or `/_hook` (those are local-only and need to fail loudly when the server is down, not be cached). For other routes it does network-first with a 504 fallback. Sequoias is a local dashboard, so offline caching is anti-feature; the SW exists only to satisfy install criteria.

**iOS gotcha:** Safari prefers PNG `apple-touch-icon` over SVG. The current SVG icon works in iOS but quality may suffer on older versions; a PNG fallback can be added later if it becomes a problem.

### 2.6.5 ProjectTree expand/collapse race

A `useEffect` was watching `[projects, collapsed]` and auto-expanding the first project whenever all projects were collapsed. This re-fired on every user click, undoing the collapse. Removed the effect entirely — initial state from `localStorage` is honored, and if all projects are collapsed by the user, we leave them collapsed.

**Why:** the effect was a half-baked safeguard against "everything is collapsed and looks empty"; the actual UX problem it was solving (user opens app and sees an empty tree) is better handled by initializing collapsed state to empty (which `loadCollapsed()` already does on first load — localStorage is empty → empty Set → all expanded).

---

## 2.7 Auto-heal of invalid ports + sequoia visual identity (2026-05-08, second session)

### 2.7.1 The 4111 collision returned

Previous fix (2.6.1) capped the allocator to valid TCP range, but the user's existing sessions in state.json still had stale invalid ports (`api: 73512`, `api: 73753`) and the env files inside the worktrees still pointed at those invalid values. The user hit the same EADDRINUSE 4111 because cortex's bind on the invalid port was failing and falling back to its hardcoded 4111 default.

**Fix:** server startup now scans all loaded sessions for any port > 65535 (or ≤ 0) and runs `resyncEnvFiles({ forceRecopy: true })` on them. Two changes in `worktree.ts` were required:

1. **forceRecopy option.** `resyncEnvFiles` previously only copied env files from the main checkout when the worktree was missing them. For healing, we need to overwrite the worktree's stale files with the main version, then run the rewriter on a clean slate.
2. **Extended port map for the rewriter.** The rewriter only substitutes URL ports that match a port in the *main* checkout's port map. URLs in the worktree already pointing at old worktree-allocated ports (e.g. `localhost:73512`) wouldn't match. We now build an `extendedMap` that includes both the main port map AND the session's existing (possibly stale) ports → service map, so URLs at any of those values get rewritten.

**Why:** without the extension, healing the `API_PORT=73512` line worked, but `NEXT_PUBLIC_API_URL=http://localhost:73512` stayed broken — and *that* is what apps actually read at runtime.

**How to apply:** the auto-heal runs once per server start. If it can't reach a worktree (deleted on disk), it logs a warning and continues. Don't make this destructive — never delete env file contents the user may have customized; the rewriter only touches recognized port numbers and matching URL fragments.

### 2.7.2 Sequoia visual identity

Replaced the cool-blue/charcoal-steel palette with a sequoia-grove visual language:

- **Dark theme**: warm forest greens for surfaces (#161E1A bg, #1C2620 rail, #253028 cards), bark orange for accent (#D08960). Reads as "forest at dusk" rather than "tech dashboard at night."
- **Light theme**: parchment cream (#EFE8DA) instead of cool grey-white. Pure white cards float on the parchment — strong visual hierarchy. Deep forest text (#1F2A22) gives a verified 11.6:1 contrast ratio against parchment, well above WCAG AAA. Accent is deep redwood (#8B4A2B).
- **Brand mark**: replaced the dot+wordmark with a sequoia silhouette (4-cluster canopy + bark trunk, two-tone gradient) plus an italic-serif "Sequoias" wordmark (Newsreader / Source Serif Pro). Reads like National Park Service signage — deliberate without being twee.
- **Typography**: JetBrains Mono first in mono stack (was just `ui-monospace`). Body sans unchanged. Italic serif for brand/dialog headings adds texture.
- **Terminal**: dark theme uses dark forest (#11181C, slightly cooler than rail to keep terminal text crisp); light theme uses warm cream (#F8F3E8). Selection at 40% accent in dark, 22% in light — much more visible than xterm's default.
- **Status badges, port chips, action buttons**: each gets a bordered pill style with semantically-tinted backgrounds (amber-soft for waiting, green-soft for working, redwood-red-soft for errored).

**Why italic serif for the wordmark instead of geometric sans?** Most productivity dashboards use cool geometric type (Inter, GT America, Söhne). The italic serif is a deliberate counter-signal — sequoias are old, the National Parks are old, and the brand mark should feel rooted, not optimized. It's one of the few places where the "120% on a single detail" rule pays off.

**Skipped on purpose**: framer-motion (no new dependency for a productivity app), gradient-y hover effects (slop territory), per-component icons in headings (slop), drop-shadows on every card. Card depth comes from background contrast alone, not shadow stacking.

### 2.7.3 Click semantics on session cards

Port chips inside session cards stop event propagation so a chip click opens the URL without selecting the session, while a click on any other part of the card selects the session and opens its terminal. Visual hint: hovering a chip recolors it to the bark accent; hovering the card body shifts the bg subtly.

**How to apply:** when adding new clickable elements inside the card (not via `<a>`), wrap them in `onClick={stop}` if you don't want the parent select to fire.

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
