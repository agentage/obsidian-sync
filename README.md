# Agentage Sync

> **Expose your vault as MCP - any AI agent can read and write your notes.**

[![Release](https://img.shields.io/github/v/release/agentage/obsidian-sync?sort=semver&label=release)](https://github.com/agentage/obsidian-sync/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.11.4%2B-7c3aed.svg)](https://obsidian.md)

Stop copying notes into every chatbot. **Agentage Sync** makes your [Obsidian](https://obsidian.md) vault one shared [Agentage Memory](https://agentage.io) that every AI reads and writes over MCP - Claude, ChatGPT, Cursor, or any MCP client - so the same context follows you across apps. It works through two-way **Git** sync to a private hosted memory: notes stay plain Markdown you own, merges are safe with flagged conflicts, and you pick which memory to sync to. Desktop only, with up to 100 MB of storage included.

> ⚠️ **Status:** **desktop only** for now - mobile is on the way.

## Features

- 🔄 **Two-way Git sync** - clone / pull / commit / push your vault to `sync.agentage.io`. The server is a bare git repo per memory that you can clone or export anytime.
- 🧠 **Pick or create a memory** - choose which memory this vault syncs into, or create a new one, from a single dialog (search your memories, see file/folder counts).
- 🤝 **Shared with every AI over MCP** - the same memory is exposed at `memory.agentage.io`, so Claude / ChatGPT / Cursor read and write the same notes. [How to connect →](https://agentage.io/connect)
- 🔐 **Sign in once** - a secure browser sign-in; your access is kept in Obsidian's encrypted storage, never in your notes or config.
- 🧩 **Plain Markdown, safe merges** - notes stay `.md`; edits from different places merge automatically, and anything that can't be is flagged with a note - never a silent drop.
- 📊 **Status at a glance** - a status-bar dot (green / red / gray) with a click menu: Sync now, Open dashboard, settings. The same actions are in the command palette and the ribbon.

## Installation

### Community plugins (recommended)

**Settings → Community plugins → Browse**, search **Agentage Sync**, then **Install** and **Enable** - or open the [community store listing](https://community.obsidian.md/plugins/agentage-memory).

### Manual

From the [latest release](https://github.com/agentage/obsidian-sync/releases/latest), copy `main.js`, `manifest.json`, and `styles.css` into your vault's `.obsidian/plugins/agentage-memory/` folder, then enable **Agentage Sync** under Settings → Community plugins.

## Getting started

1. **Settings → Agentage Sync → Sign in to Agentage** - a browser window opens once; no password is stored by the plugin.
2. **Choose a memory** - click the status-bar dot (or run **Agentage Sync: Choose memory** from the command palette) → **Choose memory…** → pick an existing memory or **Create a new** one. (A fresh memory makes the cleanest first sync.)
3. **Sync now** - from the dot menu or the command palette (**Agentage Sync: Sync now**). Your notes are committed and pushed.
4. **Connect your AI apps** - point Claude / ChatGPT / Cursor at your memory over MCP. [See how to connect →](https://agentage.io/connect)

## Settings

- **Sign in to Agentage / Disconnect** - sign in or out.
- **Memory** - the memory this vault syncs into; change it or create one via the chooser.
- **Expose remote MCP** - let AI apps read and write this memory (on by default).

## Privacy & network use

- **Account required:** you need an agentage account to sign in and sync.
- **Storage:** each account includes up to 100 MB.
- **No calls until you act:** a fresh or signed-out install makes **no network requests at all** - the plugin only contacts the network once you Connect or Sync.
- **Network use:** when active, the plugin contacts `auth.agentage.io` (sign-in, OAuth 2.1 / PKCE) and **`sync.agentage.io`** (syncing your vault over Git). "Open dashboard" opens `dashboard.agentage.io` in your browser. AI access to the same memory happens server-side over MCP at `memory.agentage.io`.
- **Privacy policy:** <https://agentage.io/privacy>. **Terms of Service:** <https://agentage.io/terms>.
- **No client-side telemetry.** Your notes live in your own per-tenant git repo (EU-hosted) and as plain Markdown on your machine; the OAuth token is kept in Obsidian's encrypted secret storage, never in `vaults.json` or `data.json`.

## Third-party

- **[isomorphic-git](https://github.com/isomorphic-git/isomorphic-git)** (MIT) - pure-JS git client.
- **js-yaml** (MIT) + **diff3** - frontmatter parsing and 3-way merge.

## FAQ

- **Why desktop only?** Mobile sign-in isn't fully tested on phones yet, so the plugin is desktop-only for now. Mobile is on the way.
- **Where is my sign-in token stored?** In Obsidian's encrypted storage - never in your notes or plugin settings.
- **What happens on a conflict?** Nothing is silently dropped. If the same note changed in two places, anything that can't be merged automatically is flagged in an **Agentage Sync Conflicts** note listing the files. Fix them, then sync again.
- **Can I leave or export?** Yes - you can export your memory anytime, and your notes stay as plain Markdown files on your computer.

## Support

Questions or problems? Email **[support@agentage.io](mailto:support@agentage.io)** or open an issue. For security reports, see [`SECURITY.md`](./SECURITY.md).

## License

[MIT](./LICENSE) © 2026 agentage. The plugin is open source; the Agentage Memory service it connects to is a separate hosted product governed by its [Terms](https://agentage.io/terms).
