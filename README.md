# Agentage Memory Sync — Obsidian plugin

**One memory. Every AI. Owned by you.**

Two-way **Git** sync between your Obsidian vault and your private [Agentage Memory](https://agentage.io) — the shared memory layer for every AI — so Claude, ChatGPT, Cursor, and any MCP client read and write the *same* Markdown you own. Your notes live as plain `.md` files in a git repo you can clone, export, or walk away with anytime.

> **Status — rebuilding (vision change, June 2026).** The published build (v0.1.1) is an early **CouchDB-replication prototype** (bundled **PouchDB**). The plugin is being rebuilt onto **git smart-HTTP**: it speaks the real git protocol via [`isomorphic-git`](https://github.com/isomorphic-git/isomorphic-git) over Obsidian's `requestUrl` (desktop **and** mobile, no CORS proxy) to a per-vault bare git repo at **`sync.agentage.io`**, with the same memory exposed as MCP at `memory.agentage.io/mcp`. The store is now one bare git repo per vault (server-authoritative), so your notes stay plain searchable Markdown end to end. Architecture, conflict model, and the phased plan live in the agentage Memory research vault (`research/obsidian-git-sync`).

## How it works

- Your notes stay as normal `.md` files in your vault — and as a **bare git repo per vault** on the server, which is the source of truth.
- The plugin does **bidirectional git sync** (clone / pull / commit / push) to `sync.agentage.io`, authenticated with your Agentage account (an OAuth token sent as an HTTP header — never in the URL).
- The same repo is exposed as an **MCP endpoint** at `memory.agentage.io/mcp`, so every AI reads and writes the same notes: edit in Obsidian → your AI sees it; your AI writes → it shows up in Obsidian.
- Concurrent edits are reconciled client-side with a **3-way (diff3) merge + per-field frontmatter merge**, and any overwritten state is kept in a recoverable backup ref — never a silent drop.
- Because the server stores **plaintext Markdown** (no client-side encryption), the cloud can search your memory with `git grep` — that is what makes one shared, searchable memory across every AI possible.

## Setup (three steps)

1. **Pick repo** — choose which memory (vault) to sync.
2. **Setup sync** — sign in once; the plugin clones your vault and keeps it in sync (pull on open + on a short interval, push on change).
3. **Expose as MCP** — copy your `memory.agentage.io/mcp` connection string into Claude, ChatGPT, or Cursor. The plugin does not host MCP; it surfaces the cloud endpoint that already serves the same repo.

## Install

The plugin isn't in the community store yet. Two ways to install it today:

**Manual** — from the [latest release](https://github.com/agentage/obsidian-memory/releases/latest), download `main.js`, `manifest.json`, and `styles.css` into `<your-vault>/.obsidian/plugins/agentage-memory/`, then enable **Agentage Memory Sync** under Settings → Community plugins.

**BRAT** — install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin, then *Add beta plugin* → `agentage/obsidian-memory`. BRAT keeps it updated as new releases ship.

After enabling, open Settings → Agentage Memory Sync and sign in to connect your vault.

## Develop

```bash
npm install        # install dependencies
npm run dev        # watch + rebuild on change
npm run build      # production bundle (main.js)
npm run verify     # full gate: type-check + lint + format + test + build + doc/host/bundle checks
```

To test in Obsidian, symlink or copy this folder to
`<your-vault>/.obsidian/plugins/agentage-memory/` (needs `main.js`, `manifest.json`, `styles.css`),
then enable **Agentage Memory Sync** under Settings → Community plugins.

### Local sync server (for sync development)

The rebuilt sync engine talks git smart-HTTP to `sync.agentage.io`, served by the `@agentage/git-sync` package in the [`agentage/web`](https://github.com/agentage/web) monorepo over the bare-repo-per-vault store; run that locally to develop against it. The legacy local CouchDB (`docker compose` + the `couchdb:*` scripts) is retained only for the current prototype build and will be removed when the git engine lands.

### End-to-end tests (Playwright Electron)

```bash
npm run test:e2e          # launches Obsidian + drives it via Playwright
OBSIDIAN_BIN=/path npm run test:e2e   # override binary location
```

**Snap caveat:** Snap-installed Obsidian on Linux runs in a confined sandbox; Playwright may fail to attach. If you hit permission errors, install the AppImage version from <https://obsidian.md/download>, make it executable, and point `OBSIDIAN_BIN` at it.

**CI:** these tests **run on every PR**. The workflow installs the latest Obsidian `.deb` into the Ubuntu runner, points `OBSIDIAN_BIN` at `/opt/Obsidian/obsidian`, and drives Playwright under `xvfb-run`. Failures upload `test-results/` + `playwright-report/` as workflow artifacts.

## Privacy & network use

- **Account required:** you need an agentage account to sign in and sync.
- **Optional payments:** Agentage Memory has a free tier; paid plans are optional. See [agentage.io](https://agentage.io) for current plans.
- **No calls until you act:** a fresh or signed-out install makes **no network requests at all**. The plugin only contacts the network once you sign in or point it at a sync endpoint.
- **Network use — a single host:** when active, the plugin talks to **one host only, `sync.agentage.io`**: account sign-in (OAuth 2.1 / PKCE), refreshing your sync token, and git clone/pull/push of your vault. AI access to the same memory happens server-side over MCP at `memory.agentage.io`; the plugin itself contacts no other host.
- **Privacy policy:** <https://agentage.io/privacy>. **Terms of Service:** <https://agentage.io/terms> (your right to use the plugin is granted under these — see [`LICENSE`](./LICENSE)).
- **No client-side telemetry.** Your notes are stored in your own per-tenant git repo (EU-hosted) and mirrored to plain Markdown on your machine; export anytime with `git clone` or `/export`.

## Third-party

- **isomorphic-git** ([MIT](https://github.com/isomorphic-git/isomorphic-git/blob/main/LICENSE.md)) — pure-JS git client for the rebuilt git smart-HTTP sync engine (desktop + mobile).
- **PouchDB** ([Apache-2.0](https://github.com/pouchdb/pouchdb/blob/master/LICENSE)) — bundled in the current prototype build (v0.1.x) for CouchDB replication; being replaced by isomorphic-git.

## Releasing (maintainers)

See [`RELEASING.md`](./RELEASING.md). In short: `npm version patch` bumps `package.json` + `manifest.json` + `versions.json` and tags (bare, no `v`); pushing the tag fires `.github/workflows/release.yml`, which builds and attaches `main.js`, `manifest.json`, `styles.css`. The tag must equal `manifest.json` `version` (Obsidian requirement).

## License

**Proprietary — All Rights Reserved.** Copyright © 2026 agentage.

The source is published here for transparency and security review. End users may run the plugin inside Obsidian under the terms in [`LICENSE`](./LICENSE); no rights to fork, redistribute, or build derivative works are granted. For commercial licensing, contact `hello@agentage.io`.
