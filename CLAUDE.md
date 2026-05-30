# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Agentage Memory — Obsidian plugin.** Syncs an Obsidian vault to the user's private Agentage Memory so every AI client (Claude, ChatGPT, Cursor, …) reads and writes the same notes. The plugin is a **CouchDB replication client** (PouchDB local replica ↔ per-tenant CouchDB); AI clients reach the same memory via the cloud MCP at `memory.agentage.io`.

**Repository:** `agentage/obsidian-memory`
**Default Branch:** `master`
**Plugin id:** `agentage-memory` · **Display name:** `Agentage Memory`

## Development Commands

```bash
npm install          # Install dependencies
npm run dev          # esbuild watch (rebuild main.js on change)
npm run build        # Production bundle -> main.js
npm run type-check   # tsc --noEmit
npm run lint         # ESLint
npm run format:check # Prettier check
npm run test         # Vitest unit tests
npm run verify       # Full gate: type-check + lint + format:check + test + build
npm run clean        # Remove build output + coverage
npm version <x.y.z>  # Bump manifest.json + versions.json (Obsidian release prep)
```

## Architecture

```
src/
├── main.ts            # Obsidian entry: thin Plugin adapter, wires deps into the controller
├── sync-controller.ts # createSyncController closure — owns sync state + lifecycle
├── settings.ts        # Settings type, defaults, pure helpers (no Obsidian import)
├── settings-tab.ts    # PluginSettingTab UI, drives the controller
├── pouch.ts           # local PouchDB store (testable) ── replication.ts # remote CouchDB (E2E)
├── inbound.ts         # apply-pulled + seed logic (Obsidian-free, testable)
├── vault-watcher.ts   # vault→cloud event wiring ── status-bar.ts # status-bar render
└── *.test.ts          # Vitest unit tests, colocated
manifest.json          # Obsidian plugin manifest (id, version, minAppVersion)
versions.json          # plugin version -> minAppVersion map
esbuild.config.mjs     # Bundler (TS -> cjs main.js)
```

Layering: **Obsidian-coupled** (`main`, `sync-controller`, `settings-tab`, `vault-watcher`, `status-bar`, `obsidian-vault-gateway`, `obsidian-fetch`, `auth-flow`) + **HTTP-coupled** (`replication`) are coverage-excluded / E2E-covered; everything else is dependency-free and unit-tested.

**Auth.** OAuth sign-in (GoTrue, PKCE S256, no DCR): `pkce.ts` (verifier/challenge/authorize-URL — tested), `oauth.ts` (token exchange/refresh over an injected `HttpPost` — tested), `token-store.ts` (access/refresh tokens in `app.secretStorage` — tested), `auth-flow.ts` (Obsidian/Electron glue: `requestUrl`, external browser, `obsidian://agentage-memory-cb` callback). Sign-in establishes the Agentage *identity*. When signed in, the controller trades the account token for a per-tenant sync target via `bootstrap.ts` (`requestSyncBootstrap` → `POST /api/sync/bootstrap` → `{syncUrl, dbName, token, expiresAt}`) and replicates with a `bearerAuthProvider` (refreshed on expiry) — no stored CouchDB password. Signed out (or local-dev / e2e), it falls back to the Basic-creds path. The backend endpoint is pending → the authed e2e (`auth-sync.spec.ts`) is `BOOTSTRAP_URL`-gated.

**Dependency injection (factory pattern, no container).** `createSyncController(deps)` takes a single typed `SyncDeps` object — Obsidian capabilities (`app`, `secrets`, `load`/`save`, `registerEvent`, `statusBar`) — and returns a singleton `SyncController` interface. All state lives in closure variables, not instance fields. Obsidian-coupled code stays in `main.ts` / `obsidian-vault-gateway.ts`; `sync-controller.ts` and the rest of `src/` stay dependency-free and unit-testable. Mirrors the house Service-Provider DI pattern (factory + singleton + deps-as-params).

## Plugin-specific conventions (Obsidian platform)

- **Entry is a DEFAULT export.** `main.ts` exports the `Plugin` subclass as default — Obsidian requires it. This is the _only_ default export; everything else uses **named exports** (project standard).
- **Build output is CommonJS.** esbuild bundles to `main.js` (`format: 'cjs'`); `obsidian`/`electron`/node builtins are externals. `main.js` is git-ignored and attached to GitHub Releases.
- **`minAppVersion` ≥ 1.11.4** — required for `app.secretStorage` (OAuth tokens go there, never `data.json`, which is plaintext).
- **`isDesktopOnly: false`** — PouchDB/IndexedDB works on mobile; keep the flag (flipping it later re-triggers store review). Mobile _testing_ is deferred for v1.
- **Pure logic out of `main.ts`.** Code that imports `obsidian` can't be unit-tested (no runtime in Vitest); keep testable logic in dependency-free modules (e.g. `settings.ts`).
- **Store compliance:** `normalizePath()` on every vault path; **no client-side telemetry**; README must disclose network hosts + account/payment requirements.

## Stack & standards

Node 22+, TypeScript strict (ES2024, ESM source). esbuild bundle, Vitest tests (70% coverage gate), ESLint + Prettier. Named exports, files < 200 lines, conventional commits (`feat:`/`fix:`/`chore:`), branches `feature/*` `bugfix/*` `hotfix/*`. PRs gated by `pr-validation.yml` (type-check + lint + format + test + build). Inherits the global Agentage coding standards.
