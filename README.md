# Agentage Sync — Obsidian plugin

**One memory. Every AI. Owned by you.**

Two-way **Git** sync between your Obsidian vault and your private [Agentage Memory](https://agentage.io) — the shared memory layer for every AI — so Claude, ChatGPT, Cursor, and any MCP client read and write the *same* Markdown you own. Your notes are plain `.md` files in a git repo you can clone or export anytime.

> **Status:** desktop git sync + Agentage sign-in (OAuth 2.1 / PKCE) work today. Mobile and automatic background sync are next.

## How it works

- Your notes stay as normal `.md` files in your vault — and as a bare git repo per vault on the server, which is the source of truth.
- **Connect** signs you in to Agentage once (browser, no password stored by the plugin); the token is kept in Obsidian's encrypted secret storage.
- **Sync** clones/pulls/commits/pushes your vault to `sync.agentage.io` over Git, authenticated with that token. Concurrent edits are reconciled with a 3-way merge (per-field frontmatter + diff3 body); conflicts surface as markers + a note, never a silent drop.
- The same memory is exposed over MCP at `memory.agentage.io`, so every AI reads and writes the same notes.

## Setup

1. **Settings → Agentage Sync → Connect to agentage** — sign in.
2. **Expose local / remote MCP** — let your AI apps read and write this memory; copy the MCP address into Claude / ChatGPT / Cursor.
3. **Command palette → "Agentage Sync: Sync now"** — back up and pull. (Background auto-sync is on the roadmap.)

## Install

Not in the community store yet. Two ways:

**Manual** — from the [latest release](https://github.com/agentage/obsidian-memory/releases/latest), copy `main.js`, `manifest.json`, and `styles.css` into `<your-vault>/.obsidian/plugins/agentage-memory/`, then enable **Agentage Sync** under Settings → Community plugins.

**BRAT** — install [BRAT](https://github.com/TfTHacker/obsidian42-brat), then *Add beta plugin* → `agentage/obsidian-memory`.

## Develop

```bash
npm install        # install dependencies
npm run dev        # watch + rebuild main.js
npm run build      # production bundle
npm run verify     # type-check + lint + format + test + build + doc/host/bundle checks
```

Tests run in Node with Vitest (the git round-trips spawn git's own `git-http-backend`, so the `git` binary must be on `PATH`). App-level end-to-end tests (real Obsidian + the live sync/auth wire) live in the `agentage/e2e` repo.

## Privacy & network use

- **Account required:** you need an agentage account to sign in and sync.
- **Optional payments:** Agentage Memory has a free tier; paid plans are optional. See [agentage.io](https://agentage.io).
- **No calls until you act:** a fresh or signed-out install makes **no network requests at all**. The plugin only contacts the network once you Connect or Sync.
- **Network use:** when active, the plugin contacts `auth.agentage.io` (sign-in, OAuth 2.1 / PKCE) and **`sync.agentage.io`** (cloning and syncing your vault over Git). AI access to the same memory happens server-side over MCP at `memory.agentage.io`.
- **Privacy policy:** <https://agentage.io/privacy>. **Terms of Service:** <https://agentage.io/terms> (your right to use the plugin is granted under these — see [`LICENSE`](./LICENSE)).
- **No client-side telemetry.** Your notes live in your own per-tenant git repo (EU-hosted) and as plain Markdown on your machine; the OAuth token is kept in Obsidian's encrypted secret storage, never in `vaults.json` or `data.json`.

## Third-party

- **isomorphic-git** ([MIT](https://github.com/isomorphic-git/isomorphic-git/blob/main/LICENSE.md)) — pure-JS git client (clone/pull/push over `requestUrl`, desktop + mobile).
- **js-yaml** (MIT) + **diff3** — frontmatter parsing and 3-way merge.

## Releasing (maintainers)

See [`RELEASING.md`](./RELEASING.md). `npm version <x.y.z>` bumps `manifest.json` + `versions.json` and tags; pushing the tag fires `.github/workflows/release.yml`, which attaches `main.js`, `manifest.json`, `styles.css` (tag must equal `manifest.json` `version`).

## License

**Proprietary — All Rights Reserved.** Copyright © 2026 agentage. Published for transparency and security review; end users may run it in Obsidian under [`LICENSE`](./LICENSE). For commercial licensing, contact `hello@agentage.io`.
