# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**agentage Vault — Obsidian plugin.** Syncs an Obsidian vault to the user's private agentage cloud so every AI client (Claude, ChatGPT, Cursor, …) reads and writes the same notes. The plugin is a **CouchDB replication client** (PouchDB local replica ↔ per-tenant CouchDB); AI clients reach the same vault via the cloud MCP at `mcp.agentage.io`.

**Repository:** `agentage/obsidian-vault`
**Default Branch:** `master`
**Plugin id:** `agentage-vault` · **Display name:** `Agentage Vault Sync`

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
├── main.ts          # Obsidian entry (Plugin lifecycle + settings tab)
├── settings.ts      # Settings type, defaults, pure helpers (no Obsidian import)
└── *.test.ts        # Vitest unit tests, colocated
manifest.json        # Obsidian plugin manifest (id, version, minAppVersion)
versions.json        # plugin version -> minAppVersion map
esbuild.config.mjs   # Bundler (TS -> cjs main.js)
```

## Plugin-specific conventions (Obsidian platform)

- **Entry is a DEFAULT export.** `main.ts` exports the `Plugin` subclass as default — Obsidian requires it. This is the *only* default export; everything else uses **named exports** (project standard).
- **Build output is CommonJS.** esbuild bundles to `main.js` (`format: 'cjs'`); `obsidian`/`electron`/node builtins are externals. `main.js` is git-ignored and attached to GitHub Releases.
- **`minAppVersion` ≥ 1.11.4** — required for `app.secretStorage` (OAuth tokens go there, never `data.json`, which is plaintext).
- **`isDesktopOnly: false`** — PouchDB/IndexedDB works on mobile; keep the flag (flipping it later re-triggers store review). Mobile *testing* is deferred for v1.
- **Pure logic out of `main.ts`.** Code that imports `obsidian` can't be unit-tested (no runtime in Vitest); keep testable logic in dependency-free modules (e.g. `settings.ts`).
- **Store compliance:** `normalizePath()` on every vault path; **no client-side telemetry**; README must disclose network hosts + account/payment requirements. See the build plan in `agentage-valut/research/obsidian-plugin/plan.md`.

## Stack & standards

Node 22+, TypeScript strict (ES2024, ESM source). esbuild bundle, Vitest tests (70% coverage gate), ESLint + Prettier. Named exports, files < 200 lines, conventional commits (`feat:`/`fix:`/`chore:`), branches `feature/*` `bugfix/*` `hotfix/*`. PRs gated by `pr-validation.yml` (type-check + lint + format + test + build). Inherits the global standards in `~/projects/CLAUDE.md`.
