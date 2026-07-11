# threadctx-mcp

[![smithery badge](https://smithery.ai/badge/oneprofile-dev/threadctx)](https://smithery.ai/servers/oneprofile-dev/threadctx)

Shared memory MCP server for AI coding agents. Works identically with
**Claude Code**, **Cursor**, and any MCP client — same package, same config
shape, no per-client integration work. On first start it also drops a
"check team memory" instruction into whichever agents' rule files your repo
uses (`AGENTS.md`, `CLAUDE.md`, Copilot, Windsurf, Cline, Gemini) so the
memory actually gets read, not just exposed.

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
# instruction to your agents' rule files (AGENTS.md, CLAUDE.md, and any
# detected tool-specific files) on first start.
npx threadctx-mcp

# Set a repo up for your whole team (run once, commit the results)
npx threadctx-mcp init

# Cloud mode — shared team memory via threadctx.dev
npx threadctx-mcp init --mode=cloud --api-key=tctx_xxx

# Joining a repo a teammate already set up? One command:
npx threadctx-mcp join

# See what your agents have written to this machine
npx threadctx-mcp list            # this repo
npx threadctx-mcp list --all      # every repo
```

`init` writes three committable, secret-free files: `.threadctx.json`
(just `{ "mode": ... }`), `.mcp.json` (Claude Code project config), and
`.cursor/mcp.json` (Cursor project config). Commit all three — every
teammate who then opens the repo in Claude Code or Cursor is prompted to
enable threadctx automatically, with nothing to install or configure.
Teammates on other MCP clients run `npx threadctx-mcp join`, which sets up
their machine the same way and prints the config block for their client.

Your API key never appears in any committed file. It is read from the
`THREADCTX_API_KEY` environment variable at runtime (export it in your
shell profile), so secrets stay out of version control by construction.

threadctx also adds a small, clearly-marked instruction to your project
rules telling the agent to call `memory_query` before a task and
`memory_write` after. It writes the two universal files every time —
[`AGENTS.md`](https://agents.md) (the cross-tool standard read by Copilot,
Cursor, Windsurf, Zed, Codex, Aider, and ~24 others) and `CLAUDE.md`
(Claude Code's richer native format) — plus `.cursor/rules/threadctx.mdc`.
It then adds a tool-specific file **only when that tool's footprint is
detected in the repo**, so it never litters your project with rule files for
tools you don't use:

| Tool | File written | Written when |
|---|---|---|
| Cross-tool standard | `AGENTS.md` | always |
| Claude Code | `CLAUDE.md` | always |
| Cursor | `.cursor/rules/threadctx.mdc` | always |
| GitHub Copilot | `.github/copilot-instructions.md` | `.github/` exists |
| Windsurf | `.windsurf/rules/threadctx.md` | `.windsurf/` exists |
| Cline | `.clinerules/threadctx.md` | `.clinerules` exists |
| Gemini CLI | `GEMINI.md` | `.gemini/` exists |

Shared files (`AGENTS.md`, `CLAUDE.md`, Copilot, Gemini) get a marker-fenced
block spliced in, preserving your own content around it; dedicated files are
owned in full. **This happens automatically the first time the server starts
in a project — you don't need to run `init` for it.** Running `init` just
triggers it explicitly and prints the result; either way it's idempotent
(safe to re-run, never duplicates). Opt out entirely with
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

## Passive capture — turn git history into memory

Memory shouldn't depend on an agent *remembering* to call `memory_write`.
`threadctx capture` reads the commits landed since its last run, uses **your
own LLM provider key** to distill the genuinely reusable decisions and
gotchas (skipping trivial commits), dedups them against what's already
stored, and writes the survivors. It's tool-agnostic — it doesn't matter
whether the work happened in Claude Code, Cursor, Copilot, or a plain editor.

```bash
# Off by default because it calls an LLM (billed to your provider). Enable it:
export THREADCTX_CAPTURE_ENABLED=1
export ANTHROPIC_API_KEY=sk-...     # or OPENAI_API_KEY

npx threadctx-mcp capture --dry-run     # preview what it would store
npx threadctx-mcp capture               # store them (incremental since last run)
npx threadctx-mcp capture --since=v1.2.0 --diffs   # a range, with patches

# Scaffold a GitHub Action that captures every merged PR automatically:
npx threadctx-mcp capture --print-workflow > .github/workflows/threadctx-capture.yml
```

Capture calls your LLM provider directly — nothing is routed through
threadctx's servers, so local mode keeps its "no network call beyond your own
LLM provider" promise. It is **off unless `THREADCTX_CAPTURE_ENABLED=1`** (or
a one-off `--force`), so it can never run up token cost as a side effect.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `THREADCTX_MODE` | no | `local` (default) or `cloud` |
| `THREADCTX_API_KEY` | only in cloud mode | issued via `cloud/scripts/create-tenant.ts` |
| `THREADCTX_API_URL` | no | defaults to `https://threadctx.dev/api/v1`; override for self-hosting |
| `THREADCTX_REPO` | no | overrides repo auto-detection from `git remote` |
| `THREADCTX_DB_PATH` | no | local-mode store path; defaults to `~/.threadctx/local.json` |
| `THREADCTX_NO_AUTO_RULES` | no | set to `1` to disable auto-injecting agent rule files on server start |
| `THREADCTX_CAPTURE_ENABLED` | for `capture` | set to `1` to enable the LLM-backed `capture` command (off by default) |
| `THREADCTX_CAPTURE_PROVIDER` | no | force `anthropic` or `openai` when both keys are present |
| `THREADCTX_CAPTURE_MODEL` | no | override the extraction model (defaults: Haiku / gpt-4o-mini) |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | for `capture` | your own provider key; capture calls it directly |

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
| `npx threadctx-mcp init [--mode=cloud --api-key=…] [--no-rules]` | Sets a repo up for the team: writes `.threadctx.json`, committable Claude Code/Cursor project MCP configs, and the project-rules files. |
| `npx threadctx-mcp join` | Joins a repo a teammate already set up: project MCP configs, rules, and per-client instructions. |
| `npx threadctx-mcp list [--all] [--full] [--json]` | Shows what's stored in the local on-disk memory. |
| `npx threadctx-mcp capture [--dry-run] [--since=<ref>] [--max=N] [--diffs] [--model=ID] [--print-workflow]` | Distills recent git history into memories via your own LLM key. Off unless `THREADCTX_CAPTURE_ENABLED=1` (or `--force`). |

Browse, search, edit, and prune team (cloud) memory in a human dashboard at
[threadctx.dev/dashboard](https://threadctx.dev/dashboard) — sign in with your
team API key.
