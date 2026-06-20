# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Agentage Memory Sync — Obsidian plugin.** Bidirectional **Git** sync between an Obsidian vault and the user's private Agentage Memory, so every AI client (Claude, ChatGPT, Cursor, …) reads and writes the same Markdown over MCP.

**Vision change (June 2026):** the plugin was a **CouchDB replication client** (PouchDB local replica ↔ per-tenant CouchDB). It is being rebuilt as a **git smart-HTTP client**: it vendors [`isomorphic-git`](https://github.com/isomorphic-git/isomorphic-git) over Obsidian's `requestUrl` (desktop **and** mobile, no CORS proxy) and clone/pull/commit/pushes a per-vault **bare git repo** at `sync.agentage.io`. The store is server-authoritative bare-git-per-vault; AI clients reach the same repo via the cloud MCP at `memory.agentage.io`. Plaintext Markdown end to end (no client E2EE) so the cloud can `git grep` it.

> **The current `src/` is the legacy PouchDB prototype.** Do not extend it. The rebuild swaps the PouchDB engine for an isomorphic-git engine while reusing the rest of the scaffolding (see below). The architecture, conflict/merge model, server hardening, mobile strategy, and the phased build plan are specified in the agentage Memory **research vault** (`research/obsidian-git-sync` — `obsidian-git-sync.md`, `tech-notes.md`, `conflict-and-merge.md`, `prior-art-sync.md`). That vault is the source of truth; do not duplicate spec content here.

**Repository:** `agentage/obsidian-memory` (repo name keeps the durable noun; display name is `Agentage Memory Sync`)
**Default Branch:** `master`
**Plugin id:** `agentage-memory` (locked — the install/auto-update key; never change it)

## Target architecture (rebuild)

```
Obsidian plugin (isomorphic-git client)   ── git smart-HTTP ──►  sync.agentage.io (Express shim)
  http = requestUrl (CORS-free)                                    auth = same get-session introspection
  fs   = adapter over vault.adapter (plaintext on disk)            structural per-vault authz (ADR-013)
  merge = client-side diff3 + per-field YAML LWW                    git-http-backend over the bare repos
  onAuth -> Authorization: Bearer <token> (NEVER in URL, #1942)            │
                                                                           ▼
                                              <reposRoot>/<userId>/<vault>.git  (server SoT)
                                              refs/heads/main · update-ref CAS · fast-forward-only
                                                                           │  (same repos)
                                              memory.agentage.io/mcp  ──►  git grep + 6 memory__* tools
```

- **Server is authoritative and never merges:** it is fast-forward-only (a raced push rejects → the client re-pulls + merges). Merge runs only in the plugin (needs a worktree).
- **Conflicts:** 3-way diff3 on the body + split-YAML-frontmatter-first per-key LWW/union, with a backup ref before any destructive write. No silent last-writer-wins. (See `conflict-and-merge.md`.)
- **No shallow clone** (read/write v1; shallow breaks push, isomorphic-git #682); full single-branch clone.

## Reuse vs replace (rebuild plan)

- **Reuse (~70%, keep):** `pkce.ts` / `oauth.ts` / `token-store.ts` (OAuth PKCE + `app.secretStorage`), `auth-flow.ts` (protocol-callback), `vault-watcher.ts`, echo-suppress, status bar, settings-tab, the `createSyncController` factory/DI shape, conflict-sidecar surfacing.
- **Replace (drop):** the PouchDB engine — `pouch.ts`, `replication.ts`, `inbound.ts`/`apply-doc.ts`, `obsidian-fetch.ts`, `bootstrap.ts` — with an isomorphic-git engine (transport + fs adapter + diff3 merge driver). Drop the `pouchdb-browser` dep and the `couchdb:*` scripts + `docker-compose.yml` when the swap lands.
- **3-step UX:** PICK REPO (`GET /v1/vaults` + create) · SETUP SYNC (PKCE/magic-link + clone) · EXPOSE AS MCP (surface the `memory.agentage.io/mcp` connect string; the plugin hosts nothing).

## Development Commands

```bash
npm install          # Install dependencies
npm run dev          # esbuild watch (rebuild main.js on change)
npm run build        # Production bundle -> main.js
npm run type-check   # tsc --noEmit
npm run lint         # ESLint (incl. eslint-plugin-obsidianmd store rules)
npm run format:check # Prettier check
npm run test         # Vitest unit tests
npm run verify       # Full gate: type-check + lint + format + test + build + check:hosts/docs/bundle
npm run clean        # Remove build output + coverage
npm version <x.y.z>  # Bump manifest.json + versions.json (Obsidian release prep)
```

`check:hosts` / `check:docs` are store-disclosure guards: the README must disclose the single sync host (`sync.agentage.io`) + privacy/terms + third-party attribution, and the old wrong MCP host must never appear (the correct MCP host is `memory.agentage.io`).

## Plugin-specific conventions (Obsidian platform)

- **Entry is a DEFAULT export.** `main.ts` exports the `Plugin` subclass as default — Obsidian requires it. This is the _only_ default export; everything else uses **named exports** (project standard).
- **Build output is CommonJS.** esbuild bundles to `main.js` (`format: 'cjs'`); `obsidian`/`electron`/node builtins are externals. `main.js` is git-ignored and attached to GitHub Releases.
- **`minAppVersion` ≥ 1.11.4** — required for `app.secretStorage` (OAuth tokens go there, never `data.json`, which is plaintext).
- **`isDesktopOnly: false`** — the isomorphic-git engine runs on mobile (over `requestUrl`); keep the flag. The `.git` dir must be a real on-disk dir the fs adapter can traverse; route binary git objects via `adapter.readBinary`; gitignore `.obsidian` + heavy media to protect mobile heap.
- **Pure logic out of `main.ts`.** Code that imports `obsidian` can't be unit-tested (no runtime in Vitest); keep testable logic in dependency-free modules (e.g. `settings.ts`, the merge driver).
- **Store compliance:** `normalizePath()` on every vault path; **no client-side telemetry**; README must disclose network hosts + account/payment requirements.

## Dependency injection (factory pattern, no container)

`createSyncController(deps)` takes a single typed `SyncDeps` object — Obsidian capabilities (`app`, `secrets`, `load`/`save`, `registerEvent`, `statusBar`) — and returns a singleton `SyncController`. All state lives in closure variables, not instance fields. Obsidian-coupled code stays in `main.ts` / gateway modules; the controller and engine stay dependency-free and unit-testable. Mirrors the house Service-Provider DI pattern (factory + singleton + deps-as-params).

## Stack & standards

Node 22+, TypeScript strict (ES2024, ESM source). esbuild bundle, Vitest tests (70% coverage gate), ESLint + Prettier. Named exports, files < 200 lines, conventional commits (`feat:`/`fix:`/`chore:`/`docs:`), branches `feature/*` `bugfix/*` `hotfix/*`. PRs gated by `pr-validation.yml` (type-check + lint + format + test + build) + Playwright Electron e2e. Inherits the global Agentage coding standards (`~/projects/CLAUDE.md`).
