# threadctx-mcp

Shared memory MCP server for AI coding agents. Works identically with
**Claude Code** and **Cursor** — same package, same config shape, no
per-client integration work.

## Modes

- **Local (default, free, no signup):** memory stored as a plain JSON file
  at `~/.threadctx/local.json` — **zero native dependencies**, so
  `npx threadctx-mcp` installs instantly on any machine with Node 18+ (no
  compiler, no node-gyp step). No network calls except to whichever LLM
  provider your agent already uses. Matching is keyword-based, scoped to
  the current repo (detected via `git remote`). Run `npx threadctx-mcp list`
  any time to see exactly what your agents have stored.
- **Cloud (paid Team tier+):** memory shared across everyone on the repo,
  with real semantic search. Requires an API key from
  [threadctx.dev](https://threadctx.dev) (or your own self-hosted
  deployment — see `../cloud/README.md`).

## Quick start

```bash
# Local mode — nothing to configure. Also auto-adds the "check team memory"
# instruction to CLAUDE.md / .cursor/rules/threadctx.mdc on first start.
npx threadctx-mcp

# Optional: write a committable .threadctx.json config, or re-apply the
# project-rules block explicitly.
npx threadctx-mcp init

# Cloud mode — prints the exact MCP config block to paste
npx threadctx-mcp init --mode=cloud --api-key=tctx_xxx

# See what your agents have written to this machine
npx threadctx-mcp list            # this repo
npx threadctx-mcp list --all      # every repo
```

`init` writes a `.threadctx.json` file (just `{ "mode": "cloud" }`) to the
current directory. It is safe to commit — it never contains your API key.
The key is read from the `THREADCTX_API_KEY` environment variable at
runtime (set it in your MCP client's `env` block, as shown below), so
secrets stay out of version control by construction.

threadctx also adds a small, clearly-marked instruction to your project
rules — `CLAUDE.md` for Claude Code, `.cursor/rules/threadctx.mdc` for
Cursor — telling the agent to call `memory_query` before a task and
`memory_write` after. **This happens automatically the first time the
server starts in a project — you don't need to run `init` for it.** Running
`init` just triggers it explicitly and prints the result; either way it's
idempotent (safe to re-run, never duplicates). Opt out entirely with
`THREADCTX_NO_AUTO_RULES=1`, or per-`init`-call with `--no-rules`.

The same instruction is also sent as part of the MCP `initialize` handshake
itself (the protocol's `instructions` field), so it reaches the model even
before any rules file exists, and for clients that don't read project-rules
files at all. The file-based rules are belt-and-suspenders on top of that,
since not every MCP client is guaranteed to surface `instructions`
prominently.

## Claude Code setup

Add to your Claude Code MCP config (`claude mcp add` or edit
`~/.claude/mcp.json` directly):

```json
{
  "mcpServers": {
    "threadctx": {
      "command": "npx",
      "args": ["-y", "threadctx-mcp"],
      "env": {
        "THREADCTX_MODE": "cloud",
        "THREADCTX_API_KEY": "tctx_xxx"
      }
    }
  }
}
```

## Cursor setup

Add the same block to `.cursor/mcp.json` in your project root (or via
Cursor Settings → Tools & MCP):

```json
{
  "mcpServers": {
    "threadctx": {
      "command": "npx",
      "args": ["-y", "threadctx-mcp"],
      "env": {
        "THREADCTX_MODE": "cloud",
        "THREADCTX_API_KEY": "tctx_xxx"
      }
    }
  }
}
```

That's it — the same package and config work in both clients because
MCP is a portable, open protocol.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `THREADCTX_MODE` | no | `local` (default) or `cloud` |
| `THREADCTX_API_KEY` | only in cloud mode | issued via `cloud/scripts/create-tenant.ts` |
| `THREADCTX_API_URL` | no | defaults to `https://threadctx.dev/api/v1`; override for self-hosting |
| `THREADCTX_REPO` | no | overrides repo auto-detection from `git remote` |
| `THREADCTX_DB_PATH` | no | local-mode store path; defaults to `~/.threadctx/local.json` |
| `THREADCTX_NO_AUTO_RULES` | no | set to `1` to disable auto-injecting `CLAUDE.md` / `.cursor/rules/threadctx.mdc` on server start |

## Local development

```bash
npm install
npm run dev     # runs the server via tsx, watches for changes
npm run build   # compiles to dist/ for publishing
```

## How the tools work

- `memory_write(content, tags?)` — the agent calls this after resolving a
  non-obvious bug, making an architectural decision, or learning
  something worth remembering.
- `memory_query(task_description, max_results?)` — the agent calls this
  before starting risky or repeated work. Results are returned with a
  consistent attribution footer (`· via threadctx — shared team memory (N
  hits)`) so the same string is recognizable whether you're reading
  Claude Code's terminal output or Cursor's agent panel.

Tool descriptions are written to bias the model toward calling
`memory_query` proactively, and — as of 0.3.0 — the server reinforces this
two more ways with zero setup required: the MCP `initialize` response
carries the same instruction to every connecting client, and `CLAUDE.md` /
`.cursor/rules/threadctx.mdc` get it auto-injected on first start. MCP tools
are still fundamentally pull-based (no mechanism can force a tool call), but
these three layers together are the strongest guarantee we can build.

## CLI subcommands

| Command | What it does |
|---|---|
| `npx threadctx-mcp` | Runs the MCP server (this is what Claude Code / Cursor launch). Auto-injects project rules on first start in a project. |
| `npx threadctx-mcp init [--mode=cloud --api-key=…] [--no-rules]` | Writes `.threadctx.json` and explicitly (re-)applies the project-rules block. |
| `npx threadctx-mcp list [--all] [--full] [--json]` | Shows what's stored in the local on-disk memory. |
