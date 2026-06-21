# Security Policy

## Reporting a vulnerability

Please **do not open a public GitHub issue** for security vulnerabilities.

Email **[support@agentage.io](mailto:support@agentage.io)** with the details (a
description, reproduction steps, and impact). We aim to acknowledge within a few
business days and will coordinate a fix and disclosure timeline with you.

## Scope

This repository is the Obsidian client. Relevant areas:

- OAuth 2.1 / PKCE sign-in and token handling (the token is kept in Obsidian's
  encrypted secret storage and a `0600 ~/.agentage/auth.json`, never in
  `vaults.json` / `data.json`).
- The git sync transport (token sent only as an `Authorization` header, never in
  a URL).

Server-side issues with the Agentage Memory service (`auth.agentage.io`,
`sync.agentage.io`, `memory.agentage.io`) can be reported to the same address.

## Supported versions

The latest released version is supported. Please reproduce on the current release
before reporting.
