import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// The exact instruction dropped into an agent's project rules. MCP is
// pull-based — the model only calls memory_query/memory_write if something
// tells it to — so this is the highest-leverage thing for making the memory
// actually get read. Also sent verbatim as the MCP `initialize` response's
// `instructions` field (see server.ts) so it reaches every client even
// before any file gets written.
export const RULES_BODY = [
  '## Team memory (threadctx)',
  '',
  '- **Before** starting any non-trivial task, call `memory_query` with a short',
  '  description of what you are about to do. Check for prior decisions, fixes,',
  '  and gotchas on this repo before writing code — not after.',
  '- **After** resolving a non-obvious bug, making an architectural decision, or',
  '  learning something that would save a teammate time, call `memory_write` to',
  '  save it. Write it so a future reader has full context.',
].join('\n');

const MARKER_START = '<!-- threadctx:start (managed — edit above/below, not between) -->';
const MARKER_END = '<!-- threadctx:end -->';

export type RuleResult = 'created' | 'updated' | 'unchanged';

// The marker-fenced block, shared by every target. For "shared" files we splice
// just this block in and leave the rest of the file alone; for "dedicated" files
// (ones whose filename is ours) the whole file is this block, optionally under a
// tool-specific frontmatter header.
const managedBlock = `${MARKER_START}\n${RULES_BODY}\n${MARKER_END}\n`;

/**
 * Insert (or refresh) the threadctx rules block in a shared, general-purpose
 * rules file (CLAUDE.md, AGENTS.md, Copilot/Gemini instructions), idempotently.
 * Creates the file if missing, preserves any of the user's own content outside
 * the marker-fenced block.
 */
function upsertMarkedBlock(filePath: string): RuleResult {
  if (!existsSync(filePath)) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, managedBlock);
    return 'created';
  }

  const existing = readFileSync(filePath, 'utf-8');
  const startIdx = existing.indexOf(MARKER_START);

  if (startIdx !== -1) {
    const endIdx = existing.indexOf(MARKER_END, startIdx);
    if (endIdx !== -1) {
      const before = existing.slice(0, startIdx);
      const after = existing.slice(endIdx + MARKER_END.length);
      const next = `${before}${managedBlock.trimEnd()}${after}`;
      if (next === existing) return 'unchanged';
      writeFileSync(filePath, next);
      return 'updated';
    }
  }

  // No managed block yet — append one, keeping the user's existing content.
  const sep = existing.endsWith('\n') ? '\n' : '\n\n';
  writeFileSync(filePath, `${existing}${sep}${managedBlock}`);
  return 'updated';
}

/**
 * Insert (or refresh) a dedicated rule file whose entire contents we own (e.g.
 * .cursor/rules/threadctx.mdc). Because the filename is ours alone, on a
 * mismatch we simply rewrite it in full rather than doing marker surgery.
 * `frontmatter` lines (if any) are written above the managed block — some tools
 * require a small YAML header to mark a rule as always-active.
 */
function upsertDedicatedFile(filePath: string, frontmatter: string[]): RuleResult {
  const header = frontmatter.length ? `---\n${frontmatter.join('\n')}\n---\n\n` : '';
  const content = `${header}${managedBlock}`;

  if (!existsSync(filePath)) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
    return 'created';
  }

  if (readFileSync(filePath, 'utf-8') === content) return 'unchanged';
  writeFileSync(filePath, content);
  return 'updated';
}

// A single rules target: one file for one (family of) agent tool(s). See the
// TARGETS table below for the concrete set. Formats verified against each
// tool's current docs (2026) — getting the path/format wrong makes the whole
// feature a silent no-op, so these are deliberately conservative:
//   - AGENTS.md is the cross-tool open standard (agents.md, now a Linux
//     Foundation project) that 28+ tools read natively: Copilot, Cursor,
//     Windsurf, Zed, Codex, Aider, Devin, Jules, VS Code, JetBrains Junie, and
//     Claude Code. Writing this one file is the highest-leverage surface.
//   - CLAUDE.md is Claude Code's richer native format (kept alongside AGENTS.md).
//   - Cursor's current format is a dedicated .mdc under .cursor/rules/ with
//     `alwaysApply: true` frontmatter (the legacy single .cursorrules is
//     deprecated). https://cursor.com/docs/rules
//   - Windsurf's current format is a Markdown file under .windsurf/rules/ with
//     `trigger: always_on` frontmatter (legacy single .windsurfrules still works).
//   - Cline is the notable holdout that does NOT read AGENTS.md, so it needs its
//     own .clinerules/ entry or it gets no instruction at all.
//   - Copilot reads AGENTS.md now, but .github/copilot-instructions.md is its
//     strong, long-standing native surface, so we reinforce it when a repo
//     already has a .github/ dir.
interface RuleTarget {
  // Stable key for programmatic result lookup; also what tests assert on.
  key: string;
  // Human-facing path shown in CLI/server output.
  label: string;
  // Path relative to the project root.
  relPath: string[];
  // 'shared' files may contain the user's own content (marker-splice); 'dedicated'
  // files are ours in full (overwrite on drift).
  kind: 'shared' | 'dedicated';
  // Frontmatter for dedicated files that need an always-active header.
  frontmatter?: string[];
  // When present, the file is only written if this returns true — used to avoid
  // littering a repo with rule files for tools it doesn't use. Universal files
  // (AGENTS.md, CLAUDE.md) and the primary Cursor target have no detector.
  detect?: (projectRoot: string) => boolean;
}

const dirExists = (root: string, ...segs: string[]) => existsSync(join(root, ...segs));
const pathExists = (root: string, ...segs: string[]) => existsSync(join(root, ...segs));

const TARGETS: RuleTarget[] = [
  // --- Universal: always written, broad coverage, low noise ---
  {
    key: 'agents',
    label: 'AGENTS.md',
    relPath: ['AGENTS.md'],
    kind: 'shared',
  },
  {
    key: 'claude',
    label: 'CLAUDE.md',
    relPath: ['CLAUDE.md'],
    kind: 'shared',
  },
  {
    // Kept always-on (not footprint-gated) to preserve prior behavior: Cursor is
    // a primary target and its global-MCP users may not have a project .cursor/.
    key: 'cursor',
    label: '.cursor/rules/threadctx.mdc',
    relPath: ['.cursor', 'rules', 'threadctx.mdc'],
    kind: 'dedicated',
    frontmatter: ['description: Use threadctx shared team memory', 'alwaysApply: true'],
  },

  // --- Footprint-detected: only written when the tool is clearly in use ---
  {
    key: 'copilot',
    label: '.github/copilot-instructions.md',
    relPath: ['.github', 'copilot-instructions.md'],
    kind: 'shared',
    detect: (root) => dirExists(root, '.github'),
  },
  {
    key: 'windsurf',
    label: '.windsurf/rules/threadctx.md',
    relPath: ['.windsurf', 'rules', 'threadctx.md'],
    kind: 'dedicated',
    frontmatter: ['trigger: always_on', 'description: Use threadctx shared team memory'],
    detect: (root) => dirExists(root, '.windsurf'),
  },
  {
    // Cline doesn't read AGENTS.md, so this file is the only way it ever sees the
    // instruction. Cline accepts either a .clinerules file or a .clinerules/ dir.
    key: 'cline',
    label: '.clinerules/threadctx.md',
    relPath: ['.clinerules', 'threadctx.md'],
    kind: 'dedicated',
    detect: (root) => pathExists(root, '.clinerules'),
  },
  {
    // Gemini CLI uses its own GEMINI.md (doesn't read AGENTS.md).
    key: 'gemini',
    label: 'GEMINI.md',
    relPath: ['GEMINI.md'],
    kind: 'shared',
    detect: (root) => dirExists(root, '.gemini'),
  },
];

export interface AppliedRule {
  key: string;
  label: string;
  result: RuleResult;
}

function applyTarget(projectRoot: string, t: RuleTarget): RuleResult {
  const filePath = join(projectRoot, ...t.relPath);
  return t.kind === 'shared'
    ? upsertMarkedBlock(filePath)
    : upsertDedicatedFile(filePath, t.frontmatter ?? []);
}

/**
 * Idempotently ensure every applicable agent's project rules contain the "check
 * team memory" instruction. Universal files (AGENTS.md, CLAUDE.md) and Cursor
 * are always written; tool-specific files (Copilot, Windsurf, Cline, Gemini) are
 * written only when that tool's footprint is detected in the repo, so we never
 * scatter rule files for tools the team doesn't use. Safe to call on every
 * server start — repeat calls are no-ops once each file is already current.
 */
export function applyRules(projectRoot: string): AppliedRule[] {
  const applied: AppliedRule[] = [];
  for (const t of TARGETS) {
    if (t.detect && !t.detect(projectRoot)) continue;
    applied.push({ key: t.key, label: t.label, result: applyTarget(projectRoot, t) });
  }
  return applied;
}
