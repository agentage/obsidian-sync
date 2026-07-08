# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project Overview

**Agentage Sync — Obsidian plugin.** A configuration page + live **CouchDB** sync between an Obsidian vault and the user's agentage Memory, plus OAuth sign-in. AI clients reach the same memory over MCP at `memory.agentage.io`.

- **Plugin id:** `agentage-memory` (locked — the install/auto-update key) · **Display name:** `Agentage Sync`
- **Repo:** `agentage/obsidian-sync` · **Default branch:** `master`
- **Couch is the only device channel.** The plugin replicates a content-addressed doc model (leaf docs + a file doc) to a per-memory CouchDB over Obsidian `requestUrl`; a server bridge commits every couch edit to git (the store stays one bare git repo per memory, server-authoritative, `git grep`-able). Plaintext markdown end to end. The git device channel was removed (see git history before the couch-only cut) - a memory the server has **not** advertised on the couch channel is an explicit error (server flip pending), never a silent fallback.

## Architecture (`src/`)

- **Config** — `settings.ts` (pure model mirroring memory-core `vaults.json`), `settings-tab.ts` (the page: Connect · Setup sync · Expose local/remote MCP · MCP address · config file), `vaults-config.ts` (merge-preserving `~/.agentage/vaults.json` writer; desktop, atomic).
- **Auth** (`auth/`) — `pkce.ts` (S256), `oauth.ts` (DCR + token exchange/refresh/revoke; public PKCE client), `discovery.ts` (`/.well-known/oauth-authorization-server`), `token-store.ts` (`app.secretStorage` + the `auth.json` mirror), `auth-json.ts` (desktop `~/.agentage/auth.json`, atomic 0600, CLI shape), `auth-flow.ts` (DI orchestration: startSignIn/handleCallback/getValidToken-with-refresh/disconnect/isSignedIn). AS = Better Auth at `auth.agentage.io`; custom-scheme redirect `obsidian://agentage-memory-cb`.
- **Couch** (`couch/`) — `couch-sync.ts` (live replication: push-on-save + interval pull, echo-safe, resilient retry queues), `couch-doc.ts` (content-addressed leaf/file doc model + Web Crypto rev), `couch-state.ts` (persisted pull cursor + push-rev cache + pending push/delete queues, through `data.json`), `couch-channel.ts` (holds the single live controller per memory; a switch/sign-out tears it down), `couch-token.ts` (mints/caches the per-memory couch JWT from the resolved `couch_token_url`).
- **Sync** — `resolve-host.ts` (`/.well-known/agentage-sync` + 1h cache; parses the couch advert and routes a memory to `couch` or `error`).
- **Entry** — `main.ts` (wires Obsidian adapters: secretStorage, requestUrl, the couch channel + live vault-event handlers, node fs only for the desktop `~/.agentage` config, the ribbon/status-bar/command). Obsidian-coupled files are coverage-excluded; the rest is unit-tested.

## Key invariants
- **Server reconciles history.** The server bridge commits couch edits to git and reconciles concurrent edits; the plugin is echo-safe (a push/pull whose content already matches is skipped) so the vault↔couch↔git loop converges. Never silent-drop.
- **Couch is the only device channel.** A memory absent from the resolution's `couch_vaults` resolves to `channel: 'error'` - surfaced as a Notice + red status dot ("not on the new sync channel yet - server update pending"), never a git fallback or a no-op.
- **Tokens** live in `app.secretStorage` + `~/.agentage/auth.json` (0600) - **never** `vaults.json`/`data.json`. The per-memory couch JWT is minted on demand from `couch_token_url` (auth service is the sole minter), never persisted.
- **No node builtins on the sync path** — couch uses `requestUrl` + Web Crypto (mobile-safe). The only `node:fs/os/path` use is the desktop `~/.agentage` config mirror (lazy, `isDesktop`-guarded); `node:http` backs the desktop loopback OAuth listener. **Mobile is deferred** (`isDesktopOnly: true`): the sync layer is mobile-safe, but sign-in (the `obsidian://` deep-link round-trip) is not device-verified — re-enable only after a mobile smoke passes.

## Development

```bash
npm install
npm run dev          # esbuild watch -> main.js
npm run build        # production main.js
npm test             # vitest
npm run verify       # type-check + lint + format + test + build + check:hosts/docs/bundle
npm version <x.y.z>  # bump manifest.json + versions.json (release prep)
```

App-level e2e (Playwright-Electron + the live `sync`/`auth` wire) lives in **`agentage/e2e`** (`tests/obsidian`, `tests/sync`), not this repo.

## Conventions
Node 22+, TypeScript strict (ES2024, ESM), esbuild → CommonJS `main.js`. Named exports only (the sole default export is the `Plugin` subclass in `main.ts`). Vitest. ESLint + Prettier (incl. `eslint-plugin-obsidianmd` store rules). `minAppVersion 1.11.4` (secretStorage), `isDesktopOnly: true` (desktop-only; mobile deferred). `normalizePath()` on vault paths; **no client-side telemetry**; the README must disclose network hosts + account/payment requirements (enforced by `check:docs`/`check:hosts`). Conventional commits. Inherits the global Agentage standards (`~/projects/CLAUDE.md`).
