# Contributing to TokenMaxed

Thanks for your interest in contributing! TokenMaxed is built in the open in
small, reviewed commits. This guide covers how to get set up and what we expect
in a change.

## Getting started

```bash
git clone https://github.com/TolyK/TokenMaxed.git
cd TokenMaxed
npm install
npm test
npm run typecheck
```

- **Node.js >= 22.18** is required. Tests run TypeScript directly via Node's
  built-in type stripping, which is enabled by default starting in 22.18. A
  separate `npm run build` emits JavaScript via `tsc` for publishing.
- The repo is a workspace monorepo. The portable routing brain lives in
  `packages/core` and must stay **pure**: no I/O, no network, no host-specific
  code.

## Non-negotiable invariants

These are the heart of the project. A change that violates one will not be
merged, and CI enforces them as the relevant checks land:

1. **No content → network.** Nothing derived from a prompt or from code/file
   content may reach a network client. The local event log is content-free by
   construction (integers, enums, labels, model ids — never free text).
2. **Honest accounting.** Every savings figure carries its assumptions. We never
   present an estimated headline as a guaranteed amount, and we never claim
   provider-specific cache savings off that provider.
3. **Enforcement order is law.** No untrusted or API lane may exist before the
   minimization/policy gate ships.

## Making a change

1. Open an issue first for anything non-trivial so we can agree on the approach.
2. Keep commits small and focused; each should pass `npm test` and
   `npm run typecheck`.
3. Add or update tests for any behavior change.
4. Write code that reads like the surrounding code — match the existing naming,
   comment density, and style.
5. Open a pull request against `main` describing the change and how you verified
   it.

## Commit messages

Use clear, imperative subject lines (e.g. "Add lane registry loader"). Reference
the relevant issue where applicable.

## Reporting bugs and requesting features

Use the issue templates under [`.github/ISSUE_TEMPLATE`](./.github/ISSUE_TEMPLATE).
For security- or privacy-sensitive reports, follow [SECURITY.md](./SECURITY.md)
instead of opening a public issue.
