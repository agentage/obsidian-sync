# Agentage Memory — Obsidian plugin

**One memory. Every AI. Owned by you.**

Sync your Obsidian notes to your private [Agentage Memory](https://agentage.io) — the shared memory layer for every AI — so Claude, ChatGPT, Cursor, and any MCP client read and write the *same* memory. Your notes stay as plain Markdown files you own and can export anytime.

> **Status:** early development (v0.1.0). This is the scaffold — sync and login are landing next. See the [build plan](https://agentage.io).

## How it works

- Your notes stay as normal `.md` files in your Obsidian vault.
- The plugin syncs them to your private Agentage Memory cloud and pulls changes back.
- Any AI tool connected to agentage sees the same notes — edit in Obsidian, your AI sees it; your AI writes, it shows up in Obsidian.

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

## Privacy & network use

- **Account required:** you need an agentage account to sync.
- **Network use:** the plugin connects to your Agentage Memory cloud at `mcp.agentage.io` to sync your notes. It makes no other network calls.
- **No client-side telemetry.** Your notes are stored in your own per-tenant store (EU-hosted) and mirrored to plain Markdown on your machine.

## License

MIT © agentage
