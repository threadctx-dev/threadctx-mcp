#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { LocalStore, type StoredMemory } from './local-store.js';
import { applyRules } from './rules.js';
import { runCapture } from './capture.js';
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

// The server entry every client config points at. Deliberately secret-free:
// in cloud mode the API key comes from the developer's own environment
// (THREADCTX_API_KEY), so these files are safe to commit — which is the whole
// point: a committed project MCP config means the NEXT teammate who opens the
// repo gets prompted by their client to enable threadctx, zero setup.
const SERVER_ENTRY = { command: 'npx', args: ['-y', 'threadctx-mcp'] };

/**
 * Merge a `threadctx` entry into a project-level MCP client config file
 * (`.mcp.json` for Claude Code, `.cursor/mcp.json` for Cursor), creating the
 * file if missing and never touching other servers or unparseable files.
 */
function upsertProjectMcpConfig(filePath: string): 'created' | 'updated' | 'unchanged' | 'skipped' {
  if (!existsSync(filePath)) {
    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(filePath, JSON.stringify({ mcpServers: { threadctx: SERVER_ENTRY } }, null, 2) + '\n');
    return 'created';
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null) return 'skipped';
    parsed.mcpServers = parsed.mcpServers ?? {};
    if (parsed.mcpServers.threadctx) return 'unchanged';
    parsed.mcpServers.threadctx = SERVER_ENTRY;
    writeFileSync(filePath, JSON.stringify(parsed, null, 2) + '\n');
    return 'updated';
  } catch {
    // A hand-edited file with a syntax quirk is the user's to fix — never clobber it.
    return 'skipped';
  }
}

/**
 * Write both committable project MCP configs and report what happened. Shared
 * by `init` (first teammate) and `join` (every teammate after).
 */
function writeProjectMcpConfigs(): void {
  const targets = [
    { path: join(process.cwd(), '.mcp.json'), client: 'Claude Code' },
    { path: join(process.cwd(), '.cursor', 'mcp.json'), client: 'Cursor' },
  ];
  for (const t of targets) {
    const result = upsertProjectMcpConfig(t.path);
    if (result === 'skipped') {
      console.log(`⚠️  Could not update ${t.path} (unparseable JSON) — add the threadctx entry by hand.`);
    } else if (result === 'unchanged') {
      console.log(`✅ Already configured: ${t.path} (${t.client})`);
    } else {
      console.log(`✅ ${result === 'created' ? 'Created' : 'Updated'}: ${t.path} — ${t.client} will offer to enable threadctx. Commit this file.`);
    }
  }
}

/**
 * `threadctx join` — the second-teammate command. The repo already carries a
 * committed `.threadctx.json` (put there by whoever ran `init`); this connects
 * *this* machine to it: project MCP configs for Claude Code/Cursor, refreshed
 * agent rules, and clear per-client instructions for everything else.
 */
function runJoin(): void {
  const configPath = join(process.cwd(), '.threadctx.json');
  if (!existsSync(configPath)) {
    console.log('No .threadctx.json found in this directory — this repo is not set up for threadctx yet.');
    console.log('To set it up for your whole team (you would be the first):');
    console.log('  npx threadctx-mcp init                 # local mode, no account needed');
    console.log('  npx threadctx-mcp init --mode=cloud --api-key=tctx_...   # shared team memory');
    process.exit(1);
  }

  let mode = 'local';
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (parsed?.mode === 'cloud') mode = 'cloud';
  } catch {
    console.log(`⚠️  ${configPath} exists but could not be parsed — continuing with local-mode instructions.`);
  }

  console.log(`Joining this repo's team memory (mode: ${mode}).\n`);
  writeProjectMcpConfigs();

  const describe = (r: string) => (r === 'created' ? 'Created' : r === 'updated' ? 'Updated' : 'Already current');
  for (const rule of applyRules(process.cwd())) {
    console.log(`✅ ${describe(rule.result)}: ${rule.label}`);
  }
  console.log('');

  if (mode === 'cloud') {
    const hasKey = Boolean(process.env.THREADCTX_API_KEY);
    if (hasKey) {
      console.log('✅ THREADCTX_API_KEY is set in your environment — cloud mode will connect.');
    } else {
      console.log('🔑 One thing left: this team uses cloud (shared) memory, which needs your team API key.');
      console.log('   Ask whoever set up threadctx here for the key (it starts with tctx_), then add to');
      console.log('   your shell profile:  export THREADCTX_API_KEY=tctx_...');
      console.log('   Without it, threadctx still works on this machine in local (private) mode.');
    }
    console.log('');
  }

  console.log('Done. Restart Claude Code / Cursor in this repo — when prompted, enable the');
  console.log('threadctx MCP server, and your agent will share the team memory from then on.');
  console.log('Other MCP clients: add this server block to the client config:');
  console.log(JSON.stringify({ mcpServers: { threadctx: SERVER_ENTRY } }, null, 2));
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

  // Committable, secret-free client configs: once these are in the repo, every
  // teammate who opens it in Claude Code or Cursor gets prompted to enable
  // threadctx automatically — the join step disappears for the common clients.
  writeProjectMcpConfigs();

  // Drop the "always check team memory" instruction into the agent's project
  // rules so the tools actually get used, even for clients that don't surface
  // MCP's `initialize.instructions` prominently. Opt out with --no-rules. The
  // server also does this automatically on every start (see server.ts) — this
  // just lets you trigger it explicitly and see the result immediately.
  if (flags['no-rules'] !== true) {
    const describe = (r: string) => (r === 'created' ? 'Created' : r === 'updated' ? 'Updated' : 'Already current');
    for (const rule of applyRules(process.cwd())) {
      console.log(`✅ ${describe(rule.result)}: ${rule.label} — tells your agent to check team memory each task.`);
    }
    console.log(
      '   (AGENTS.md + CLAUDE.md are always written; Copilot/Windsurf/Cline/Gemini files are added only'
    );
    console.log('   when that tool is detected in the repo. Opt out entirely with --no-rules.)');
  }
  console.log('');

  if (mode === 'cloud') {
    console.log('🔑 Your API key stays out of every committed file. Put it in your shell profile:');
    console.log(`   export THREADCTX_API_KEY=${apiKey}`);
    console.log('   (each teammate does the same with the shared team key)');
    console.log('');
  }
  console.log('Restart Claude Code / Cursor in this repo and enable threadctx when prompted.');
  console.log('Commit .threadctx.json, .mcp.json, and .cursor/mcp.json — teammates who open the');
  console.log('repo get offered threadctx automatically; anyone else runs: npx threadctx-mcp join');
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

  if (command === 'join') {
    runJoin();
    return;
  }

  if (command === 'list') {
    runList(rest);
    return;
  }

  if (command === 'capture') {
    const flags = parseFlags(rest);
    const parsedMax = typeof flags.max === 'string' ? parseInt(flags.max, 10) : NaN;
    await runCapture({
      since: typeof flags.since === 'string' ? flags.since : undefined,
      max: Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : 30,
      dryRun: flags['dry-run'] === true,
      diffs: flags.diffs === true,
      model: typeof flags.model === 'string' ? flags.model : undefined,
      force: flags.force === true,
      printWorkflow: flags['print-workflow'] === true,
    });
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
