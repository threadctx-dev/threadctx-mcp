// Tests for the second-teammate flow: `threadctx join` and the committable
// project MCP configs written by init/join (src/cli.ts). Run with: npm test
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'dist', 'cli.js');

let failed = false;
function assert(cond, label) {
  if (!cond) {
    console.error(`❌ FAIL: ${label}`);
    failed = true;
  } else {
    console.log(`✅ ${label}`);
  }
}

function run(cwd, args, expectFailure = false) {
  try {
    return execFileSync('node', [cli, ...args], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    if (expectFailure) return err.stdout ?? '';
    throw err;
  }
}

// 1. join in a repo with no .threadctx.json → exits 1 and points at init.
const bare = mkdtempSync(join(tmpdir(), 'threadctx-join-bare-'));
const bareOut = run(bare, ['join'], true);
assert(/not set up for threadctx yet/.test(bareOut), 'join without .threadctx.json explains and points at init');
assert(!existsSync(join(bare, '.mcp.json')), 'join without config writes nothing');

// 2. join in a team repo (local mode) → writes both project MCP configs + rules.
const team = mkdtempSync(join(tmpdir(), 'threadctx-join-team-'));
writeFileSync(join(team, '.threadctx.json'), JSON.stringify({ mode: 'local' }) + '\n');
const joinOut = run(team, ['join']);
assert(/mode: local/.test(joinOut), 'join reports the mode from .threadctx.json');
const mcpJson = JSON.parse(readFileSync(join(team, '.mcp.json'), 'utf-8'));
assert(mcpJson.mcpServers.threadctx.command === 'npx', '.mcp.json created with threadctx server (Claude Code)');
const cursorJson = JSON.parse(readFileSync(join(team, '.cursor', 'mcp.json'), 'utf-8'));
assert(cursorJson.mcpServers.threadctx.args.includes('threadctx-mcp'), '.cursor/mcp.json created (Cursor)');
assert(existsSync(join(team, 'AGENTS.md')), 'join applies agent rules');
assert(
  !JSON.stringify(mcpJson).includes('tctx_'),
  'committed configs are secret-free'
);

// 3. Existing .mcp.json with another server → merged, nothing clobbered.
const merge = mkdtempSync(join(tmpdir(), 'threadctx-join-merge-'));
writeFileSync(join(merge, '.threadctx.json'), JSON.stringify({ mode: 'cloud' }) + '\n');
writeFileSync(
  join(merge, '.mcp.json'),
  JSON.stringify({ mcpServers: { other: { command: 'other-server' } } }, null, 2)
);
const mergeOut = run(merge, ['join']);
const merged = JSON.parse(readFileSync(join(merge, '.mcp.json'), 'utf-8'));
assert(merged.mcpServers.other.command === 'other-server', 'existing servers in .mcp.json are preserved');
assert(merged.mcpServers.threadctx.command === 'npx', 'threadctx entry merged alongside');
assert(/THREADCTX_API_KEY/.test(mergeOut), 'cloud-mode join explains where the API key goes');

// 4. Unparseable config → left untouched, warned.
const broken = mkdtempSync(join(tmpdir(), 'threadctx-join-broken-'));
writeFileSync(join(broken, '.threadctx.json'), JSON.stringify({ mode: 'local' }) + '\n');
writeFileSync(join(broken, '.mcp.json'), '{ not json');
const brokenOut = run(broken, ['join']);
assert(readFileSync(join(broken, '.mcp.json'), 'utf-8') === '{ not json', 'unparseable .mcp.json is never clobbered');
assert(/by hand/.test(brokenOut), 'unparseable config produces a warning');

// 5. Second join is a no-op on the configs.
const secondOut = run(team, ['join']);
assert(/Already configured: .*\.mcp\.json/.test(secondOut), 'second join reports .mcp.json already configured');

// 6. init also writes the project MCP configs.
const fresh = mkdtempSync(join(tmpdir(), 'threadctx-init-'));
run(fresh, ['init']);
assert(existsSync(join(fresh, '.mcp.json')) && existsSync(join(fresh, '.cursor', 'mcp.json')), 'init writes both project MCP configs');

// 7. The committed rules files carry the join hint; a fresh clone's agent knows what to suggest.
const agents = readFileSync(join(team, 'AGENTS.md'), 'utf-8');
assert(/npx threadctx-mcp join/.test(agents), 'AGENTS.md tells agents to suggest `npx threadctx-mcp join` when tools are missing');

console.log(failed ? '\n❌ join tests failed.' : '\n🎉 All join tests passed.');
for (const dir of [bare, team, merge, broken, fresh]) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}
process.exit(failed ? 1 : 0);
