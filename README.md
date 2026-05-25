# agentage Vault — Obsidian plugin

**One vault. Every AI. Owned by you.**

Sync your Obsidian notes to your private [agentage](https://agentage.io) cloud so every AI assistant — Claude, ChatGPT, Cursor, and any MCP client — reads and writes the *same* vault. Your notes stay as plain Markdown files you own and can export anytime.

> **Status:** early development (v0.1.0). This is the scaffold — sync and login are landing next. See the [build plan](https://agentage.io).

## How it works

- Your notes stay as normal `.md` files in your Obsidian vault.
- The plugin syncs them to your private agentage cloud and pulls changes back.
- Any AI tool connected to agentage sees the same notes — edit in Obsidian, your AI sees it; your AI writes, it shows up in Obsidian.

## Develop

```bash
npm install      # install dependencies
npm run dev      # watch + rebuild on change
npm run build    # type-check + production bundle (main.js)
```

To test in Obsidian, symlink or copy this folder to
`<your-vault>/.obsidian/plugins/agentage-vault/` (needs `main.js`, `manifest.json`, `styles.css`),
then enable **agentage Vault** under Settings → Community plugins.

## Privacy & network use

- **Account required:** you need an agentage account to sync.
- **Network use:** the plugin connects to your agentage cloud at `mcp.agentage.io` to sync your notes. It makes no other network calls.
- **No client-side telemetry.** Your notes are stored in your own per-tenant store (EU-hosted) and mirrored to plain Markdown on your machine.

## License

MIT © agentage
