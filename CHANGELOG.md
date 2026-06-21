# Changelog

All notable changes to Agentage Sync are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions match the
`manifest.json` version and the GitHub release tag.

## [0.2.1] - 2026-06-21

### Changed

- Ribbon icon is now `network` (distinct from the `refresh-cw` Sync now action).
- Store description and README intro rewritten to lead with the value: your vault
  becomes one memory every AI reads and writes over MCP.

## [0.2.0] - 2026-06-21

### Changed

- **Relicensed to MIT** - the plugin is now open source (the Agentage Memory
  service it connects to remains a separate hosted product).

### Fixed

- Clear the session when a token refresh is rejected (4xx) so the UI flips to
  signed-out instead of showing a "ready" dot while every sync fails. Transient
  (5xx/network) refresh errors keep the session and stay retryable.
- Disconnect now clears the selected memory, so re-signing in never resurfaces a
  stale or deleted memory as active.
- The memory chooser distinguishes a server/network error ("Couldn't load your
  memories" + Retry) from a genuinely empty account.
- A conflict during the push-retry re-pull is surfaced instead of producing a
  confusing "push not ok after rebase" error.
- An unmergeable (criss-cross) history now surfaces an actionable message instead
  of a raw error.

### Added

- "Use & sync" on non-current rows in the memory chooser.
- `helpUrl`, `SECURITY.md`, this changelog, and README badges + FAQ.

## [0.1.6] - 2026-06-21

### Changed

- **Desktop only** (`isDesktopOnly: true`) - mobile is deferred until sign-in and
  first sync are device-verified. The git engine is already mobile-safe.

## [0.1.5] - 2026-06-21

### Changed

- Status menu shows "Choose Memory" only when no memory is selected; removed
  Disconnect from the menu (it stays in Settings).

## [0.1.4] - 2026-06-21

### Fixed

- The ribbon and an "Open menu" command open a modal action-picker so the actions
  are reachable where there is no status bar.

## [0.1.0] - 2026-06-21

- Initial release: OAuth 2.1 / PKCE sign-in, two-way Git sync to
  `sync.agentage.io`, memory chooser, and 3-way merge with conflict surfacing.

[0.2.1]: https://github.com/agentage/obsidian-sync/releases/tag/0.2.1
[0.2.0]: https://github.com/agentage/obsidian-sync/releases/tag/0.2.0
[0.1.6]: https://github.com/agentage/obsidian-sync/releases/tag/0.1.6
[0.1.5]: https://github.com/agentage/obsidian-sync/releases/tag/0.1.5
[0.1.4]: https://github.com/agentage/obsidian-sync/releases/tag/0.1.4
[0.1.0]: https://github.com/agentage/obsidian-sync/releases/tag/0.1.0
