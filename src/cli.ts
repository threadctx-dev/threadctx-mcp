#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from './server.js';

const [, , command, ...rest] = process.argv;

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (const arg of args) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) flags[match[1]] = match[2];
  }
  return flags;
}

function runInit(args: string[]): void {
  const flags = parseFlags(args);
  const mode = flags.mode === 'cloud' ? 'cloud' : 'local';

  // The config file is meant to be committable, so it deliberately never holds
  // the API key — that is read from the THREADCTX_API_KEY environment variable
  // at runtime (set it in your MCP client's `env` block). This keeps secrets
  // out of version control by construction.
  const config: Record<string, string> = { mode };
  if (mode === 'cloud' && flags['api-url']) config.apiUrl = flags['api-url'];

  const apiKey = flags['api-key'];
  if (mode === 'cloud' && !apiKey) {
    console.error('Cloud mode needs an API key. Pass --api-key=<tctx_...> so this command can');
    console.error('show you the exact config block to paste.');
    console.error('Example: npx threadctx-mcp init --mode=cloud --api-key=tctx_xxx');
    process.exit(1);
  }

  const configPath = join(process.cwd(), '.threadctx.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

  console.log(`✅ Wrote ${configPath} (mode: ${mode}) — safe to commit, contains no secret.`);
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

async function main(): Promise<void> {
  if (command === 'init') {
    runInit(rest);
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
