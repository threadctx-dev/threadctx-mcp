import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig, type ThreadctxConfig } from './config.js';
import { LocalStore } from './local-store.js';
import { CloudClient } from './cloud-client.js';
import { complete, detectProvider, parseJsonArray, type LlmProvider } from './llm.js';

// `threadctx capture` — turn git history into team memory without any agent
// remembering to call memory_write. This is the tool-agnostic capture path: it
// doesn't matter whether the work was done in Claude Code, Cursor, Copilot, or a
// plain editor — if it landed as commits, it can become durable memory. Runs
// locally on demand, or in CI on merge via the shipped GitHub Action.

interface Commit {
  hash: string;
  date: string;
  subject: string;
  body: string;
}

interface ExtractedMemory {
  content: string;
  tags: string[];
}

const US = '\x1f'; // unit separator between fields
const RS = '\x1e'; // record separator between commits
const MAX_BODY_CHARS = 1200; // bound a runaway commit body's token cost

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
}

function isGitRepo(): boolean {
  try {
    git(['rev-parse', '--is-inside-work-tree']);
    return true;
  } catch {
    return false;
  }
}

function isAncestor(sha: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], {
      cwd: process.cwd(),
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

// Per-repo capture state (last commit we've already distilled) lives next to the
// local store, keyed by repo slug, so re-running capture is incremental and
// idempotent — you only ever process commits landed since the last run.
function markerPath(config: ThreadctxConfig): string {
  const slug = config.repo.replace(/[^a-zA-Z0-9._-]+/g, '__');
  return join(dirname(config.dbPath), 'capture', `${slug}.json`);
}

function readLastSha(config: ThreadctxConfig): string | null {
  const path = markerPath(config);
  if (!existsSync(path)) return null;
  try {
    return (JSON.parse(readFileSync(path, 'utf-8')) as { lastSha?: string }).lastSha ?? null;
  } catch {
    return null;
  }
}

function writeLastSha(config: ThreadctxConfig, sha: string): void {
  const path = markerPath(config);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ lastSha: sha, updatedAt: new Date().toISOString() }, null, 2) + '\n');
}

function collectCommits(range: string | null, max: number): Commit[] {
  const format = ['%H', '%ad', '%s', '%b'].join(US) + RS;
  const args = ['log', '--no-merges', '--date=short', `--pretty=format:${format}`];
  if (range) args.push(range);
  else args.push(`-n`, String(max));

  const raw = git(args);
  if (!raw) return [];

  return raw
    .split(RS)
    .map((rec) => rec.replace(/^\s+/, ''))
    .filter(Boolean)
    .map((rec) => {
      const [hash, date, subject, body = ''] = rec.split(US);
      return { hash, date, subject, body: body.trim().slice(0, MAX_BODY_CHARS) };
    })
    .filter((c) => c.hash && c.subject);
}

const SYSTEM_PROMPT = [
  'You extract durable, reusable engineering knowledge from git history for a team memory system.',
  'A good memory is a non-obvious decision, a fix for a tricky bug, a gotcha, a constraint, or an',
  'architectural choice that would save a teammate real time later. Write each as a SELF-CONTAINED',
  'note (2-5 sentences) with enough context to be understood months later by someone who was not there.',
  '',
  'STRICT RULES:',
  '- Skip trivial/mechanical commits: version bumps, formatting, lint, typo fixes, routine dependency',
  '  bumps, "wip", merge commits, and anything with no reusable lesson.',
  '- Do NOT restate the diff; capture the WHY and the lesson, not the change.',
  '- Do NOT duplicate anything in the "Already stored" list; skip near-duplicates.',
  '- Prefer fewer, higher-quality notes. Returning an empty array is correct when nothing qualifies.',
  '- Output ONLY a JSON array. Each item: {"content": string, "tags": string[] (1-4 short tags)}.',
].join('\n');

function buildUserPrompt(repo: string, commits: Commit[], existing: string[], includeDiffs: boolean): string {
  const existingBlock = existing.length
    ? existing.map((c) => `- ${c.replace(/\s+/g, ' ').slice(0, 240)}`).join('\n')
    : '(none)';

  const commitBlock = commits
    .map((c) => {
      const diff = includeDiffs ? diffFor(c.hash) : '';
      return [
        `commit ${c.hash.slice(0, 10)} (${c.date})`,
        `subject: ${c.subject}`,
        c.body ? `body:\n${c.body}` : '',
        diff ? `diff (truncated):\n${diff}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n---\n\n');

  return [
    `Repository: ${repo}`,
    '',
    'Already stored (do not duplicate these):',
    existingBlock,
    '',
    `New commits to distill (${commits.length}):`,
    '',
    commitBlock,
    '',
    'Return the JSON array now.',
  ].join('\n');
}

function diffFor(hash: string): string {
  try {
    // Names + patch, but bounded: full diffs blow up tokens and can leak secrets,
    // so --diffs is opt-in and each commit's patch is hard-capped.
    return git(['show', '--no-color', '--stat', '--patch', '--format=', hash]).slice(0, 3000);
  } catch {
    return '';
  }
}

export function coerceMemories(raw: unknown[]): ExtractedMemory[] {
  const out: ExtractedMemory[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const content = typeof obj.content === 'string' ? obj.content.trim() : '';
    if (content.length < 20) continue; // reject empty/degenerate notes
    const tags = Array.isArray(obj.tags)
      ? obj.tags.filter((t): t is string => typeof t === 'string').map((t) => t.trim().slice(0, 50)).slice(0, 4)
      : [];
    out.push({ content: content.slice(0, 4000), tags });
  }
  return out;
}

interface CaptureFlags {
  since?: string;
  max: number;
  dryRun: boolean;
  diffs: boolean;
  model?: string;
  force: boolean;
  printWorkflow: boolean;
}

// A ready-to-commit GitHub Actions workflow that runs capture automatically when
// a PR merges — this is what makes capture a passive, always-on team habit rather
// than a manual chore. Printed by `threadctx capture --print-workflow` so a team
// can scaffold it in one line:
//   npx threadctx-mcp capture --print-workflow > .github/workflows/threadctx-capture.yml
// It captures exactly the merged PR's commits (--since the base sha), and is
// itself gated by THREADCTX_CAPTURE_ENABLED so it never runs unless configured.
export const WORKFLOW_TEMPLATE = `# Auto-distill merged PRs into threadctx team memory.
# Requires two repo secrets:
#   THREADCTX_API_KEY  – your threadctx cloud key (Team plan)
#   ANTHROPIC_API_KEY  – or OPENAI_API_KEY; capture uses your own provider
name: threadctx capture

on:
  pull_request:
    types: [closed]
    branches: [main]

jobs:
  capture:
    # Only on real merges, and only when the secret is present (skips on forks).
    if: github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # full history so capture can see the merged commits
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Distill merged commits into team memory
        env:
          THREADCTX_CAPTURE_ENABLED: '1'
          THREADCTX_MODE: cloud
          THREADCTX_API_KEY: \${{ secrets.THREADCTX_API_KEY }}
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
        run: npx -y threadctx-mcp capture --since \${{ github.event.pull_request.base.sha }}
`;

// The master on/off switch for the only LLM-billed feature. Accepts the usual
// truthy spellings; anything else (including unset) means OFF.
function captureEnabled(): boolean {
  const v = (process.env.THREADCTX_CAPTURE_ENABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * `threadctx capture [--since=<ref>] [--max=N] [--diffs] [--dry-run] [--model=ID]`
 * Distills commits landed since the last capture (or the last N commits) into
 * memories using your own LLM provider key, dedups against what's stored, and
 * writes the survivors to the local or cloud store.
 */
export async function runCapture(flags: CaptureFlags): Promise<void> {
  // Print-only: scaffold the CI workflow. Costs nothing, so it runs before any
  // enable-gate or git checks.
  if (flags.printWorkflow) {
    process.stdout.write(WORKFLOW_TEMPLATE);
    return;
  }

  // Capture is the only feature that calls an LLM, so it's OFF by default and
  // must be explicitly switched on. This guarantees zero token spend unless a
  // human/CI opts in — nothing here ever runs an LLM as a side effect of normal
  // MCP usage. Enable with THREADCTX_CAPTURE_ENABLED=1 (or --force for a one-off).
  if (!captureEnabled() && !flags.force) {
    console.error('[threadctx] `capture` is off by default because it calls an LLM (billed to your own');
    console.error('[threadctx] provider key). Turn it on explicitly when you want it:');
    console.error('[threadctx]   export THREADCTX_CAPTURE_ENABLED=1   # persistent on/off switch');
    console.error('[threadctx]   npx threadctx-mcp capture --dry-run   # or add --force for a one-off run');
    process.exit(1);
  }

  if (!isGitRepo()) {
    console.error('[threadctx] `capture` must run inside a git repository (none found here).');
    process.exit(1);
  }

  const provider = detectProvider(flags.model);
  if (!provider) {
    console.error('[threadctx] capture needs your own LLM provider key to distill commits.');
    console.error('[threadctx] Set ANTHROPIC_API_KEY or OPENAI_API_KEY in your environment and re-run.');
    console.error('[threadctx] (Nothing is sent to threadctx servers — capture calls your provider directly.)');
    process.exit(1);
  }

  const config = loadConfig();

  // Resolve the commit range: explicit --since wins, else incremental from the
  // last captured SHA (if it's still an ancestor of HEAD), else last --max.
  let range: string | null = null;
  if (flags.since) {
    range = `${flags.since}..HEAD`;
  } else {
    const lastSha = readLastSha(config);
    if (lastSha && isAncestor(lastSha)) range = `${lastSha}..HEAD`;
  }

  const commits = collectCommits(range, flags.max);
  if (commits.length === 0) {
    console.log('[threadctx] No new commits to capture. You are up to date.');
    return;
  }

  const head = git(['rev-parse', 'HEAD']);

  // Existing memories for dedup context (best-effort in cloud mode).
  const localStore = config.mode === 'cloud' && config.apiKey ? null : new LocalStore(config.dbPath);
  const cloudClient =
    config.mode === 'cloud' && config.apiKey
      ? new CloudClient(config.apiUrl, config.apiKey, config.actorId)
      : null;
  const existing = localStore
    ? localStore.list(config.repo).map((m) => m.content)
    : (await cloudClient!.recent(config.repo, 100)).map((m) => m.content);

  console.log(
    `[threadctx] Distilling ${commits.length} commit${commits.length === 1 ? '' : 's'} for ${config.repo} ` +
      `via ${provider.name} (${provider.model})…`
  );

  const responseText = await complete(
    provider,
    SYSTEM_PROMPT,
    buildUserPrompt(config.repo, commits, existing, flags.diffs)
  );
  const memories = coerceMemories(parseJsonArray(responseText));

  if (memories.length === 0) {
    console.log('[threadctx] Nothing worth remembering in these commits (that is a fine outcome).');
    if (!flags.dryRun) writeLastSha(config, head);
    return;
  }

  console.log(`\n[threadctx] ${memories.length} candidate ${memories.length === 1 ? 'memory' : 'memories'}:\n`);
  memories.forEach((m, i) => {
    console.log(`${i + 1}. ${m.content}`);
    if (m.tags.length) console.log(`   tags: ${m.tags.join(', ')}`);
    console.log('');
  });

  if (flags.dryRun) {
    console.log('[threadctx] --dry-run: nothing written. Re-run without --dry-run to store these.');
    return;
  }

  let stored = 0;
  for (const m of memories) {
    try {
      if (localStore) localStore.write(config.repo, m.content, m.tags);
      else await cloudClient!.write(config.repo, m.content, m.tags);
      stored += 1;
    } catch (err) {
      console.error(`[threadctx] Failed to store a memory: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  writeLastSha(config, head);
  console.log(
    `[threadctx] Stored ${stored} ${stored === 1 ? 'memory' : 'memories'} to ${
      localStore ? 'the local store' : 'threadctx cloud'
    }. Your team can now query these.`
  );
}
