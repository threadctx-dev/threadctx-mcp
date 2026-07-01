#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { LocalStore, type StoredMemory } from './local-store.js';
import { startServer } from './server.js';

const [, , command, ...rest] = process.argv;

function parseFlags(args: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (const arg of args) {
    const kv = arg.match(/^--([^=]+)=(.*)$/);
    if (kv) {
      flags[kv[1]] = kv[2];
      continue;
    }
    const bare = arg.match(/^--([^=]+)$/);
    if (bare) flags[bare[1]] = true;
  }
  return flags;
}

// The exact instruction block we drop into an agent's project rules. MCP is
// pull-based — the model only calls memory_query/memory_write if something tells
// it to — so this is the single highest-leverage thing for making the memory
// actually get read. Fenced by markers so re-running `init` updates in place
// instead of appending duplicates.
const RULES_START = '<!-- threadctx:start (managed — edit above/below, not between) -->';
const RULES_END = '<!-- threadctx:end -->';
const RULES_BODY = [
  '## Team memory (threadctx)',
  '',
  '- **Before** starting any non-trivial task, call `memory_query` with a short',
  '  description of what you are about to do. Check for prior decisions, fixes,',
  '  and gotchas on this repo before writing code — not after.',
  '- **After** resolving a non-obvious bug, making an architectural decision, or',
  '  learning something that would save a teammate time, call `memory_write` to',
  '  save it. Write it so a future reader has full context.',
].join('\n');

/**
 * Insert (or refresh) the threadctx rules block in a project rules file,
 * idempotently. Creates the file if missing. Returns what happened so the
 * caller can report it honestly.
 */
function upsertRulesBlock(filePath: string): 'created' | 'updated' | 'unchanged' {
  const block = `${RULES_START}\n${RULES_BODY}\n${RULES_END}\n`;

  if (!existsSync(filePath)) {
    writeFileSync(filePath, block);
    return 'created';
  }

  const existing = readFileSync(filePath, 'utf-8');
  const startIdx = existing.indexOf(RULES_START);

  if (startIdx !== -1) {
    const endIdx = existing.indexOf(RULES_END, startIdx);
    if (endIdx !== -1) {
      const before = existing.slice(0, startIdx);
      const after = existing.slice(endIdx + RULES_END.length);
      const next = `${before}${block.trimEnd()}${after}`;
      if (next === existing) return 'unchanged';
      writeFileSync(filePath, next);
      return 'updated';
    }
  }

  // No managed block yet — append one, keeping the user's existing content.
  const sep = existing.endsWith('\n') ? '\n' : '\n\n';
  writeFileSync(filePath, `${existing}${sep}${block}`);
  return 'updated';
}

function runInit(args: string[]): void {
  const flags = parseFlags(args);
  const mode = flags.mode === 'cloud' ? 'cloud' : 'local';

  // The config file is meant to be committable, so it deliberately never holds
  // the API key — that is read from the THREADCTX_API_KEY environment variable
  // at runtime (set it in your MCP client's `env` block). This keeps secrets
  // out of version control by construction.
  const config: Record<string, string> = { mode };
  if (mode === 'cloud' && typeof flags['api-url'] === 'string') config.apiUrl = flags['api-url'];

  const apiKey = typeof flags['api-key'] === 'string' ? flags['api-key'] : undefined;
  if (mode === 'cloud' && !apiKey) {
    console.error('Cloud mode needs an API key. Pass --api-key=<tctx_...> so this command can');
    console.error('show you the exact config block to paste.');
    console.error('Example: npx threadctx-mcp init --mode=cloud --api-key=tctx_xxx');
    process.exit(1);
  }

  const configPath = join(process.cwd(), '.threadctx.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

  console.log(`✅ Wrote ${configPath} (mode: ${mode}) — safe to commit, contains no secret.`);

  // Drop the "always check team memory" instruction into the agent's project
  // rules so the tools actually get used. Opt out with --no-rules.
  if (flags['no-rules'] !== true) {
    for (const rulesFile of ['CLAUDE.md', '.cursorrules']) {
      const rulesPath = join(process.cwd(), rulesFile);
      const result = upsertRulesBlock(rulesPath);
      const verb = result === 'created' ? 'Created' : result === 'updated' ? 'Updated' : 'Already current in';
      console.log(`✅ ${verb} ${rulesFile} — tells your agent to check team memory each task.`);
    }
  }
  console.log('');

  if (mode === 'cloud') {
    console.log('Add threadctx to your MCP client config (~/.claude/mcp.json and/or .cursor/mcp.json).');
    console.log('Same block for Claude Code and Cursor:');
    console.log('');
    console.log(
      JSON.stringify(
        {
          mcpServers: {
            threadctx: {
              command: 'npx',
              args: ['-y', 'threadctx-mcp'],
              env: { THREADCTX_MODE: 'cloud', THREADCTX_API_KEY: apiKey },
            },
          },
        },
        null,
        2
      )
    );
    console.log('');
    console.log('Keep your API key in that env block (or your shell) — not in .threadctx.json.');
  } else {
    console.log('Local mode is ready — just add threadctx to your MCP client config. No key needed.');
    console.log('See the README for the exact block (identical for Claude Code and Cursor).');
  }
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * A milestone-aware, on-device nudge toward cloud/team mode. Deliberately sends
 * NOTHING off the machine — it's computed purely from the local store and shown
 * only in surfaces a human actually reads (`list`). The whole pitch escalates as
 * the local memory grows, because a large multi-repo store is exactly the point
 * where "my teammates can't see any of this" becomes a real, felt problem.
 */
function cloudNudge(all: StoredMemory[]): string {
  const total = all.length;
  const repos = new Set(all.map((m) => m.repo)).size;

  if (repos >= 2 && total >= 5) {
    return (
      `↑ You've stored ${total} memories across ${repos} repos on this machine — none of it is\n` +
      `  visible to your teammates. Share it as team memory: https://threadctx.dev`
    );
  }
  if (total >= 20) {
    return (
      `↑ You've built up ${total} local memories — turn them into shared team memory\n` +
      `  your whole team can query: https://threadctx.dev`
    );
  }
  return 'Local-only memory — share it across your team at https://threadctx.dev';
}

/**
 * `threadctx list` — show what your agents have written to *this machine* in
 * local mode. Read-only, no network, scoped to the current repo by default
 * (pass --all to see every repo, --full to print untruncated content, --json
 * for machine-readable output).
 */
function runList(args: string[]): void {
  const flags = parseFlags(args);
  const config = loadConfig();

  if (config.mode === 'cloud') {
    console.error('[threadctx] `list` shows the local on-disk store; you are in cloud mode.');
    console.error('[threadctx] Cloud memories live on the server and are retrieved via memory_query.');
    console.error('[threadctx] (Set THREADCTX_MODE=local to inspect the local store, if any.)');
    process.exit(0);
  }

  const store = new LocalStore(config.dbPath);
  const all = store.list();
  const repoFilter = flags.all === true ? undefined : config.repo;
  const memories = repoFilter ? all.filter((m) => m.repo === repoFilter) : all;

  if (flags.json === true) {
    console.log(JSON.stringify(memories, null, 2));
    return;
  }

  const scope = repoFilter ? `for ${repoFilter}` : 'across all repos';
  if (memories.length === 0) {
    console.log(`No local memories ${scope} yet.`);
    console.log('Your agents write these by calling memory_write. Nothing has been stored here.');
    if (repoFilter && all.length > 0) {
      console.log(`(You have ${all.length} in other repos — run with --all to see them.)`);
    }
    return;
  }

  console.log(`threadctx — ${memories.length} local ${memories.length === 1 ? 'memory' : 'memories'} ${scope}\n`);
  for (const m of memories) {
    const date = m.created_at.slice(0, 10);
    const tags = m.tags.length ? `  [${m.tags.join(', ')}]` : '';
    const repoTag = repoFilter ? '' : `  ${m.repo}`;
    console.log(`● ${date}${repoTag}${tags}`);
    console.log(`  ${flags.full === true ? m.content.trim() : truncate(m.content, 160)}`);
    console.log(`  id: ${m.id.slice(0, 8)}\n`);
  }

  console.log(`Stored at ${config.dbPath}.`);
  console.log(cloudNudge(all));
}

async function main(): Promise<void> {
  if (command === 'init') {
    runInit(rest);
    return;
  }

  if (command === 'list') {
    runList(rest);
    return;
  }

  // No subcommand: this is what Claude Code / Cursor actually launch as the
  // MCP server process (they invoke `npx threadctx-mcp` with no arguments).
  await startServer();
}

main().catch((err) => {
  console.error('[threadctx] fatal error:', err);
  process.exit(1);
});
