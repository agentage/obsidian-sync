# Agentage Memory — Obsidian plugin

**One memory. Every AI. Owned by you.**

Sync your Obsidian notes to your private [Agentage Memory](https://agentage.io) — the shared memory layer for every AI — so Claude, ChatGPT, Cursor, and any MCP client read and write the *same* memory. Your notes stay as plain Markdown files you own and can export anytime.

> **Status:** early access (v0.1.0). Two-way sync, initial vault seeding, and concurrent-edit conflict handling work today; account login (OAuth) is landing next. See [agentage.io](https://agentage.io).

## How it works

- Your notes stay as normal `.md` files in your Obsidian vault.
- The plugin syncs them to your private Agentage Memory cloud and pulls changes back.
- Any AI tool connected to agentage sees the same notes — edit in Obsidian, your AI sees it; your AI writes, it shows up in Obsidian.

## Install

The plugin isn't in the community store yet. Two ways to install it today:

**Manual** — from the [latest release](https://github.com/agentage/obsidian-memory/releases/latest), download `main.js`, `manifest.json`, and `styles.css` into `<your-vault>/.obsidian/plugins/agentage-memory/`, then enable **Agentage Memory** under Settings → Community plugins.

**BRAT** — install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin, then *Add beta plugin* → `agentage/obsidian-memory`. BRAT keeps it updated as new releases ship.

After enabling, open Settings → Agentage Memory and point **Server URL** at your Agentage Memory endpoint.

## Develop

```bash
npm install        # install dependencies
npm run dev        # watch + rebuild on change
npm run build      # production bundle (main.js)
npm run verify     # full gate: type-check + lint + format + test + build
```

To test in Obsidian, symlink or copy this folder to
`<your-vault>/.obsidian/plugins/agentage-memory/` (needs `main.js`, `manifest.json`, `styles.css`),
then enable **Agentage Memory** under Settings → Community plugins.

### Local CouchDB (for sync development)

A throwaway local CouchDB (with CORS pre-configured for Obsidian) is provided via Docker Compose:

```bash
npm run couchdb:up      # start CouchDB on http://localhost:5984 (admin / agentage)
npm run couchdb:down    # stop containers
npm run couchdb:reset   # stop + drop the data volume
```

In the plugin settings (Settings → Agentage Memory), set **Server URL** to `http://localhost:5984` (Username `admin`, Password `agentage` defaults match) and click **Test connection** — you should see *Connected (HTTP 200)*.

Then open any note and run **Command Palette → "Push current note to Agentage Memory"**. The note is written as one whole document with `_id = <vault-path>`. Verify on the server:

```bash
curl -sS -u admin:agentage http://localhost:5984/agentage-memory/_all_docs
```

### End-to-end tests (Playwright Electron)

```bash
npm run test:e2e          # launches Obsidian + drives it via Playwright
OBSIDIAN_BIN=/path npm run test:e2e   # override binary location
```

**Snap caveat:** Snap-installed Obsidian on Linux runs in a confined sandbox; Playwright may fail to attach. If you hit permission errors, install the AppImage version from <https://obsidian.md/download>, make it executable, and point `OBSIDIAN_BIN` at it.

**CI:** these tests **run on every PR**. The workflow installs the latest Obsidian `.deb` into the Ubuntu runner, points `OBSIDIAN_BIN` at `/opt/Obsidian/obsidian`, and drives Playwright under `xvfb-run`. Failures upload `test-results/` + `playwright-report/` as workflow artifacts.

## Privacy & network use

- **Account required:** you need an agentage account to sync.
- **Paid service:** Agentage Memory is a subscription product (with a free tier). See [agentage.io](https://agentage.io) for current plans.
- **Network use:** the plugin connects to your Agentage Memory cloud at `mcp.agentage.io` to sync your notes. It makes no other network calls.
- **No client-side telemetry.** Your notes are stored in your own per-tenant store (EU-hosted) and mirrored to plain Markdown on your machine.

## Releasing (maintainers)

```bash
npm version patch          # bumps package.json + manifest.json + versions.json, commits, tags (bare, no `v`)
git push --follow-tags     # pushes the commit + tag → .github/workflows/release.yml builds + publishes the GitHub Release
```

The tag must equal `manifest.json` `version` (Obsidian requirement); the workflow guards this and attaches `main.js`, `manifest.json`, `styles.css`.

## License

**Proprietary — All Rights Reserved.** Copyright © 2026 agentage.

The source is published here for transparency and security review. End users may run the plugin inside Obsidian under the terms in [`LICENSE`](./LICENSE); no rights to fork, redistribute, or build derivative works are granted. For commercial licensing, contact `hello@agentage.io`.
