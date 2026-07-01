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

/**
 * Insert (or refresh) the threadctx rules block in a shared, general-purpose
 * rules file (CLAUDE.md), idempotently. Creates the file if missing, preserves
 * any of the user's own content outside the marker-fenced block.
 */
function upsertMarkedBlock(filePath: string): RuleResult {
  const block = `${MARKER_START}\n${RULES_BODY}\n${MARKER_END}\n`;

  if (!existsSync(filePath)) {
    writeFileSync(filePath, block);
    return 'created';
  }

  const existing = readFileSync(filePath, 'utf-8');
  const startIdx = existing.indexOf(MARKER_START);

  if (startIdx !== -1) {
    const endIdx = existing.indexOf(MARKER_END, startIdx);
    if (endIdx !== -1) {
      const before = existing.slice(0, startIdx);
      const after = existing.slice(endIdx + MARKER_END.length);
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

// Cursor's current, non-deprecated rules format: a dedicated .mdc file per
// rule under .cursor/rules/, with YAML frontmatter. alwaysApply: true means
// it's loaded in every chat regardless of which files are open — the right
// behavior for a project-wide "check team memory" instruction (see
// https://cursor.com/docs/rules). The legacy single .cursorrules file still
// works but Cursor's own docs say it will eventually be removed, so new
// writes target the current format instead.
function cursorRuleContent(): string {
  return [
    '---',
    'description: Use threadctx shared team memory',
    'alwaysApply: true',
    '---',
    '',
    MARKER_START,
    RULES_BODY,
    MARKER_END,
    '',
  ].join('\n');
}

/**
 * Insert (or refresh) the threadctx rule at .cursor/rules/threadctx.mdc. This
 * filename is ours alone (not a shared/general file like CLAUDE.md), so on a
 * mismatch we simply rewrite it in full rather than doing marker surgery.
 */
function upsertCursorRule(projectRoot: string): RuleResult {
  const filePath = join(projectRoot, '.cursor', 'rules', 'threadctx.mdc');
  const content = cursorRuleContent();

  if (!existsSync(filePath)) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
    return 'created';
  }

  if (readFileSync(filePath, 'utf-8') === content) return 'unchanged';
  writeFileSync(filePath, content);
  return 'updated';
}

export interface ApplyRulesResult {
  claudeMd: RuleResult;
  cursorRule: RuleResult;
}

/**
 * Idempotently ensure both Claude Code's (CLAUDE.md) and Cursor's
 * (.cursor/rules/threadctx.mdc) project rules contain the "check team
 * memory" instruction. Safe to call on every server start, not just from
 * `threadctx init` — repeat calls are no-ops once both are already current.
 */
export function applyRules(projectRoot: string): ApplyRulesResult {
  return {
    claudeMd: upsertMarkedBlock(join(projectRoot, 'CLAUDE.md')),
    cursorRule: upsertCursorRule(projectRoot),
  };
}
