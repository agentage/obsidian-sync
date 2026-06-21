# Agentage Sync

> **One memory. Every AI. Owned by you.**

[![Release](https://img.shields.io/github/v/release/agentage/obsidian-sync?sort=semver&label=release)](https://github.com/agentage/obsidian-sync/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.11.4%2B-7c3aed.svg)](https://obsidian.md)

Two-way **Git** sync between your Obsidian vault and your private [Agentage Memory](https://agentage.io) - the shared memory layer for every AI. Your notes stay plain Markdown that you own, and Claude, ChatGPT, Cursor, and any MCP client read and write the *same* files.

> ⚠️ **Status:** **desktop only** today (`isDesktopOnly`). Desktop git sync + Agentage sign-in (OAuth 2.1 / PKCE) work. Mobile is planned (see [Mobile](#mobile-planned)); background auto-sync is next.

## Features

- 🔄 **Two-way Git sync** - clone / pull / commit / push your vault to `sync.agentage.io`. The server is a bare git repo per memory that you can clone or export anytime.
- 🧠 **Pick or create a memory** - choose which memory this vault syncs into, or create a new one, from a single dialog (search your memories, see file/folder counts).
- 🤝 **Shared with every AI over MCP** - the same memory is exposed at `memory.agentage.io`, so Claude / ChatGPT / Cursor read and write the same notes. [How to connect →](https://agentage.io/connect)
- 🔐 **Sign in once** - OAuth 2.1 / PKCE; the token is kept in Obsidian's encrypted secret storage, never in your notes or config.
- 🧩 **Plain Markdown, safe merges** - notes stay `.md`; concurrent edits reconcile with a 3-way merge (per-field frontmatter + diff3 body), and conflicts surface as markers + a note - never a silent drop.
- 📊 **Status at a glance** - a status-bar dot (green / red / gray) with a click menu: Sync now, Open dashboard, settings. The same actions are in the command palette and the ribbon.

## Installation

### Community plugins (recommended)

*Coming soon - pending Obsidian review.* Once listed: **Settings → Community plugins → Browse**, search **Agentage Sync**, then **Install** and **Enable**.

### BRAT (beta)

Install [BRAT](https://github.com/TfTHacker/obsidian42-brat), then **Add beta plugin** → `agentage/obsidian-sync`. BRAT keeps it auto-updated.

### Manual

From the [latest release](https://github.com/agentage/obsidian-sync/releases/latest), copy `main.js`, `manifest.json`, and `styles.css` into `<your-vault>/.obsidian/plugins/agentage-memory/`, then enable **Agentage Sync** under Settings → Community plugins.

## Getting started

1. **Settings → Agentage Sync → Sign in to Agentage** - a browser window opens once; no password is stored by the plugin.
2. **Choose a memory** - click the status-bar dot (or run **Agentage Sync: Choose memory** from the command palette) → **Choose memory…** → pick an existing memory or **Create a new** one. (A fresh memory makes the cleanest first sync.)
3. **Sync now** - from the dot menu or the command palette (**Agentage Sync: Sync now**). Your notes are committed and pushed.
4. **Connect your AI apps** - point Claude / ChatGPT / Cursor at your memory over MCP. [See how to connect →](https://agentage.io/connect)

## Settings

- **Sign in to Agentage / Disconnect** - sign in or out.
- **Memory** - the memory this vault syncs into; change it or create one via the chooser.
- **Expose remote MCP** - let AI apps read and write this memory (on by default).

## How it works

- Your notes are normal `.md` files in your vault - and a bare git repo per memory on the server, which is the source of truth.
- **Sync** runs a real git client (vendored [isomorphic-git](https://github.com/isomorphic-git/isomorphic-git)) over Obsidian's network layer, authenticated with your sign-in token (sent only as an `Authorization` header, never in the URL). It never force-pushes - it commits before pulling and 3-way merges.
- The same repo is what AI apps read and write over MCP - one memory, every AI.

## Mobile (planned)

This release is **desktop only** (`isDesktopOnly: true`), so Obsidian won't offer it on phones yet. The git engine already runs over Obsidian's vault adapter (no Node APIs on the sync path), so the groundwork is in place - what's left is verifying sign-in and first sync on real iOS/Android. Mobile will be re-enabled once that's solid.

## Privacy & network use

- **Account required:** you need an agentage account to sign in and sync.
- **Free:** Agentage Memory is free to use, up to a 100 MB storage cap per account.
- **No calls until you act:** a fresh or signed-out install makes **no network requests at all** - the plugin only contacts the network once you Connect or Sync.
- **Network use:** when active, the plugin contacts `auth.agentage.io` (sign-in, OAuth 2.1 / PKCE) and **`sync.agentage.io`** (syncing your vault over Git). "Open dashboard" opens `dashboard.agentage.io` in your browser. AI access to the same memory happens server-side over MCP at `memory.agentage.io`.
- **Privacy policy:** <https://agentage.io/privacy>. **Terms of Service:** <https://agentage.io/terms>.
- **No client-side telemetry.** Your notes live in your own per-tenant git repo (EU-hosted) and as plain Markdown on your machine; the OAuth token is kept in Obsidian's encrypted secret storage, never in `vaults.json` or `data.json`.

## Building from source

```bash
npm install
npm run dev      # esbuild watch → main.js
npm run build    # production bundle
npm run verify   # type-check + lint + format + test + build + doc/host/bundle checks
```

Tests run in Node with Vitest (the git round-trips spawn git's own `git-http-backend`, so the `git` binary must be on `PATH`). App-level end-to-end tests live in the [`agentage/e2e`](https://github.com/agentage/e2e) repo.

## Third-party

- **[isomorphic-git](https://github.com/isomorphic-git/isomorphic-git)** (MIT) - pure-JS git client.
- **js-yaml** (MIT) + **diff3** - frontmatter parsing and 3-way merge.

## FAQ

- **Why desktop only?** Mobile sign-in (the `obsidian://` callback inside Obsidian's mobile WebView) isn't device-verified yet, so the plugin is `isDesktopOnly` until it is. The git engine is already mobile-safe - see [Mobile (planned)](#mobile-planned).
- **Where is my sign-in token stored?** In Obsidian's encrypted secret storage (and a 0600 `~/.agentage/auth.json` on desktop, shared with the agentage CLI) - never in `vaults.json` or `data.json`.
- **What happens on a conflict?** Nothing is silently dropped. Concurrent edits 3-way merge (per-field frontmatter + diff3 body); anything that can't auto-merge gets conflict markers and an **Agentage Sync Conflicts** note listing the files. Resolve the markers, then sync again.
- **Can I leave / export?** Yes - your memory is a plain git repo you can clone or export anytime, and your notes stay as Markdown on disk.

## Support

Questions or problems? Email **[support@agentage.io](mailto:support@agentage.io)** or open an issue. For security reports, see [`SECURITY.md`](./SECURITY.md).

## License

[MIT](./LICENSE) © 2026 agentage. The plugin is open source; the Agentage Memory service it connects to is a separate hosted product governed by its [Terms](https://agentage.io/terms).
