# Releasing

The plugin ships as a GitHub Release with three assets — `main.js`, `manifest.json`,
`styles.css` — on a tag equal to `manifest.json`'s `version` (Obsidian requires
tag == manifest version). `.github/workflows/release.yml` builds and publishes it.

## One-time setup

- **`RELEASE_PAT` secret** (required for the auto-bump path). A fine-grained PAT
  or GitHub App token with **contents: write** + **pull-requests: write**. The
  auto-bump opens a PR to land the version bump (the `master-protection` ruleset
  blocks direct pushes); a PR opened with the default `GITHUB_TOKEN` does **not**
  trigger `pr-validation`, so `gh pr checks --watch` would hang. Add it under
  Settings → Secrets and variables → Actions.

## Cutting a release

Three ways in:

1. **Tag push (manual):**
   ```bash
   npm version patch        # bumps package.json + manifest.json + versions.json, commits, tags (bare, no `v`)
   git push --follow-tags   # fires release.yml → builds + publishes
   ```
   Direct master push is blocked by the ruleset, so prefer the dispatch path
   below, or land the bump via PR first and push only the tag.

2. **Manual dispatch:** Actions → **Release** → *Run workflow*. Computes the next
   patch, lands it via an auto-merged PR, tags, builds, publishes. Tick **draft**
   to create a draft Release so you can verify the three assets before publishing
   — **use this for the community-store submission release**.

3. **Nightly `repository_dispatch`** (`release-plugin`, fired by `agentage/e2e` on
   a green nightly): same as dispatch, auto-published, a no-op when nothing is new
   since the last tag.

## Community store submission (one-time)

1. Cut a **published** release (`tag == manifest.version`, three assets).
2. At <https://github.com/obsidianmd/obsidian-releases>, add an entry to
   `community-plugins.json`:
   ```json
   { "id": "agentage-memory", "name": "Agentage Memory", "author": "agentage",
     "description": "...", "repo": "agentage/obsidian-memory" }
   ```
3. Open the PR; pass the automated scan (mirrored locally by `npm run lint` via
   `eslint-plugin-obsidianmd`, plus `npm run check:hosts` / `check:docs` /
   `check:bundle`).
