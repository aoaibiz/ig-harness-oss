# IG Harness OSS publication policy

This repository is the public, self-hosted IG Harness distribution. Every
published file must be useful to people running IG Harness in their own
Cloudflare and Meta accounts.

## Public scope

- Cloudflare Worker and dashboard source required to run IG Harness
- reusable SDK, MCP server, database schema, and setup CLI
- public examples, tests, and end-user documentation
- placeholder configuration that requires each operator's own identifiers

## Never public

- company or member-only application variants
- private repository names, sync topology, hostnames, or deployment hosts
- credentials, tokens, private keys, cookies, production identifiers, or PII
- local agent state, machine paths, caches, build output, or backup files

The deny-list is enforced by `.gitignore` and
`scripts/pre-publish-guard.sh`. A matching path or value blocks publication.

## Publication gate

1. Start from the exact public base commit; do not reconcile an unrelated
   dirty worktree into the release.
2. Stage only reviewed paths. Do not use `git add -A` for a public release.
3. Run tests, build, and `pnpm guard:prepublish` on the working tree.
4. Commit with a public/noreply author identity.
5. Run `scripts/pre-publish-guard.sh --git <commit>` on the exact candidate.
6. Run an independent secrets/scope audit and correctness review.
7. Push only after every gate is green and the reviewer approves that exact
   commit.

If a usable credential is ever published, revoke or rotate it immediately.
Removing a value from the latest tree does not invalidate copies in Git
history, caches, forks, or logs.

## Contributions

External pull requests are welcome. Review them for correctness, security,
scope, tests, and disclosure risk before merge. Release tags follow semantic
versioning.
