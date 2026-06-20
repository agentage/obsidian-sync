# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project Overview

**Agentage Sync — Obsidian plugin.** A configuration page + bidirectional **git** sync between an Obsidian vault and the user's agentage Memory, plus OAuth sign-in. AI clients reach the same memory over MCP at `memory.agentage.io`.

- **Plugin id:** `agentage-memory` (locked — the install/auto-update key) · **Display name:** `Agentage Sync`
- **Repo:** `agentage/obsidian-memory` · **Default branch:** `master`
- The plugin is a **git client** (vendored `isomorphic-git` over Obsidian `requestUrl`) talking to the agentage git server at `sync.agentage.io`; the store is one bare git repo per vault, server-authoritative. Plaintext markdown end to end (no client E2E) so the cloud can `git grep` it.

## Architecture (`src/`)

- **Config** — `settings.ts` (pure model mirroring memory-core `vaults.json`), `settings-tab.ts` (the page: Connect · Setup sync · Expose local/remote MCP · MCP address · config file), `vaults-config.ts` (merge-preserving `~/.agentage/vaults.json` writer; desktop, atomic).
- **Auth** (`auth/`) — `pkce.ts` (S256), `oauth.ts` (DCR + token exchange/refresh/revoke; public PKCE client), `discovery.ts` (`/.well-known/oauth-authorization-server`), `token-store.ts` (`app.secretStorage` + the `auth.json` mirror), `auth-json.ts` (desktop `~/.agentage/auth.json`, atomic 0600, CLI shape), `auth-flow.ts` (DI orchestration: startSignIn/handleCallback/getValidToken-with-refresh/disconnect/isSignedIn). AS = Better Auth at `auth.agentage.io`; custom-scheme redirect `obsidian://agentage-memory-cb`.
- **Git** (`git/`) — `git-client.ts` (DI clone/fetch/pull/push/merge; full single-branch, token-in-header, **never force**), `merge-note.ts` (split-YAML field-LWW + diff3 body), `backup-ref.ts`, `http-requesturl.ts` (requestUrl `HttpClient`), `vault-fs.ts` (mobile `vault.adapter` fs-shim — built, not yet wired), `stream-utils.ts`, `git-test-server.ts` (test-only `git-http-backend`).
- **Sync** — `resolve-host.ts` (`/.well-known/agentage-sync` + 1h cache), `sync-controller.ts` (single-flight lifecycle: ensure repo → commit-before-pull → merge → conflict note → push).
- **Entry** — `main.ts` (wires Obsidian adapters: secretStorage, requestUrl, node fs on desktop, the ribbon/status-bar/command). Obsidian-coupled files are coverage-excluded; the rest is unit/integration-tested.

## Key invariants
- **Client owns history.** The server is plain git (force-push allowed, no fast-forward-only), so the plugin **never force-pushes**; it commits-before-pull, 3-way merges, and surfaces conflicts (markers + a `conflict:true` note). Never silent-drop.
- **Tokens** live in `app.secretStorage` + `~/.agentage/auth.json` (0600) — **never** `vaults.json`/`data.json`.
- **isomorphic-git gotchas:** token via `onAuth` header only (never the URL, #1942); full single-branch clone (no `depth` — shallow breaks push, #682); no gc (re-clone on bloat — mobile, future).
- **Merge:** split YAML frontmatter before diff3 (markers inside `---` corrupt the note).
- **Desktop** uses node fs (the tested path); mobile (`vault.adapter` via `vault-fs.ts`) is a later milestone.

## Development

```bash
npm install
npm run dev          # esbuild watch -> main.js
npm run build        # production main.js
npm test             # vitest (spawns git-http-backend; needs the git binary)
npm run verify       # type-check + lint + format + test + build + check:hosts/docs/bundle
npm version <x.y.z>  # bump manifest.json + versions.json (release prep)
```

App-level e2e (Playwright-Electron + the live `sync`/`auth` wire) lives in **`agentage/e2e`** (`tests/obsidian`, `tests/sync`), not this repo.

## Conventions
Node 22+, TypeScript strict (ES2024, ESM), esbuild → CommonJS `main.js`. Named exports only (the sole default export is the `Plugin` subclass in `main.ts`). Vitest. ESLint + Prettier (incl. `eslint-plugin-obsidianmd` store rules). `minAppVersion 1.11.4` (secretStorage), `isDesktopOnly: false`. `normalizePath()` on vault paths; **no client-side telemetry**; the README must disclose network hosts + account/payment requirements (enforced by `check:docs`/`check:hosts`). Conventional commits. Inherits the global Agentage standards (`~/projects/CLAUDE.md`).
