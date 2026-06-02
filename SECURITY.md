# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security or privacy vulnerabilities.

Instead, report privately using GitHub's
[private vulnerability reporting](https://github.com/TolyK/TokenMaxed/security/advisories/new)
("Report a vulnerability" on the Security tab). We aim to acknowledge reports
within a few days.

When reporting, please include:

- A description of the issue and its impact.
- Steps to reproduce, or a proof of concept.
- Any relevant version/commit information.

## Scope of particular interest

Because TokenMaxed's core promise is local-first and content-free, we are
especially interested in reports of:

- **Content leakage** — any path by which prompt or code/file content could
  reach a network client.
- **Minimization bypass** — any way an untrusted lane could receive more than
  the scrubbed, bounded, no-tool payload it is supposed to get.
- **Secret exposure** — credentials, tokens, or repo identifiers appearing in
  logs, the event ledger, or outbound payloads.

## Supported versions

TokenMaxed is pre-1.0 (v0). Security fixes are applied to `main`. There are no
long-term support branches yet.
