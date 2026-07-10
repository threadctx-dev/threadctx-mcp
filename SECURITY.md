# Security Policy

## Reporting a vulnerability

Email **founders@threadctx.dev** with the details (a proof-of-concept helps).
Please don't open a public issue for anything exploitable — give us a chance
to ship a fix first. You'll get an acknowledgement within 2 business days and
a status update at least weekly until it's resolved. We'll credit you in the
release notes unless you'd rather stay anonymous.

## Supported versions

Only the latest published version of `threadctx-mcp` on npm receives security
fixes. The package is small and has no migration burden between versions, so
staying current is a one-line change (or automatic, if you launch it via
`npx -y threadctx-mcp`).

## Supply chain

- The package is published from this public repository; what's on npm is
  built from the source you can read here.
- One runtime dependency: `@modelcontextprotocol/sdk`, the official MCP SDK.
- No native modules, no postinstall (or any install-time) scripts.
- `package-lock.json` is committed.

## What this software does and doesn't touch

- **Local mode (default):** all data lives in `~/.threadctx/local.json` on
  your machine. Zero network calls. No telemetry.
- **Cloud mode:** the only network egress is HTTPS to
  `https://threadctx.dev/api/v1` (or your own self-hosted URL via
  `THREADCTX_API_URL`). Only memory entries transit — never source code.
- **On first start in a repo** the server adds a memory-usage instruction to
  the repo's agent rule files (AGENTS.md, CLAUDE.md, and tool-specific files
  when detected). Disable with `THREADCTX_NO_AUTO_RULES=1`.

Full details for security reviewers: https://threadctx.dev/security
