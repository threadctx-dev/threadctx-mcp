// End-to-end MCP smoke test. Spawns the built server over stdio, runs the real
// JSON-RPC handshake the way Claude Code / Cursor do, and exercises both tools
// plus edge cases. Run with: npm test
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'dist', 'cli.js');

const dbDir = mkdtempSync(join(tmpdir(), 'threadctx-test-'));
const env = {
  ...process.env,
  THREADCTX_MODE: 'local',
  THREADCTX_REPO: 'acme/payments-service',
  THREADCTX_DB_PATH: join(dbDir, 'local.json'),
};

// cwd is the same throwaway tmpdir as THREADCTX_DB_PATH — without this, the
// server's auto rules-injection (see rules.ts) would write CLAUDE.md and
// .cursor/rules/ into wherever `npm test` happens to be run from.
const child = spawn('node', [cli], { env, cwd: dbDir, stdio: ['pipe', 'pipe', 'inherit'] });

let buf = '';
const pending = new Map();
child.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

let id = 0;
function rpc(method, params) {
  const reqId = ++id;
  return new Promise((resolve) => {
    pending.set(reqId, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: reqId, method, params }) + '\n');
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

let failed = false;
function assert(cond, label) {
  if (!cond) {
    console.error(`❌ FAIL: ${label}`);
    failed = true;
  } else {
    console.log(`✅ ${label}`);
  }
}

function cleanup(code) {
  child.kill();
  try {
    rmSync(dbDir, { recursive: true, force: true });
  } catch {}
  process.exit(code);
}

const run = async () => {
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke-test', version: '1.0.0' },
  });
  assert(init.result?.serverInfo?.name === 'threadctx', 'initialize → server identifies as threadctx');
  notify('notifications/initialized', {});

  const tools = await rpc('tools/list', {});
  const names = tools.result.tools.map((t) => t.name).sort();
  assert(
    JSON.stringify(names) === JSON.stringify(['memory_query', 'memory_write']),
    'tools/list → memory_write + memory_query'
  );

  const write = await rpc('tools/call', {
    name: 'memory_write',
    arguments: {
      content:
        'Switched retry backoff to exponential after fixed delay caused a thundering herd in prod incident #412.',
      tags: ['incident', 'retry-logic'],
    },
  });
  assert(/Stored memory/.test(write.result.content[0].text), 'memory_write → stores and confirms');

  const hit = await rpc('tools/call', {
    name: 'memory_query',
    arguments: { task_description: 'implementing retry logic for the billing webhook handler' },
  });
  const hitText = hit.result.content[0].text;
  assert(/thundering herd/.test(hitText), 'memory_query → retrieves the relevant memory');
  assert(/via threadctx — shared team memory \(1 hit\)/.test(hitText), 'memory_query → attribution footer renders');

  const miss = await rpc('tools/call', {
    name: 'memory_query',
    arguments: { task_description: 'completely unrelated kubernetes networking topic' },
  });
  assert(/No relevant team memory found/.test(miss.result.content[0].text), 'memory_query → graceful empty result');

  const bad = await rpc('tools/call', { name: 'memory_write', arguments: { content: '   ' } });
  assert(bad.result.isError === true, 'memory_write → rejects empty content');

  // Tags should also be searchable.
  const tagHit = await rpc('tools/call', {
    name: 'memory_query',
    arguments: { task_description: 'past incident postmortem' },
  });
  assert(/thundering herd/.test(tagHit.result.content[0].text), 'memory_query → matches on tags too');

  console.log(failed ? '\n❌ Smoke tests failed.' : '\n🎉 All MCP smoke tests passed.');
  cleanup(failed ? 1 : 0);
};

run().catch((e) => {
  console.error(e);
  cleanup(1);
});
