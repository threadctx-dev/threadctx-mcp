// Unit test for the multi-tool rules injection (src/rules.ts → dist/rules.js).
// Verifies: universal files are always written, tool-specific files are only
// written when that tool's footprint is detected, the block is idempotent, and
// user content outside the managed markers is preserved. Run with: npm test
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { applyRules } = await import(join(here, '..', 'dist', 'rules.js'));

const root = mkdtempSync(join(tmpdir(), 'threadctx-rules-'));

let failed = false;
function assert(cond, label) {
  if (!cond) {
    console.error(`❌ FAIL: ${label}`);
    failed = true;
  } else {
    console.log(`✅ ${label}`);
  }
}
const byKey = (applied) => Object.fromEntries(applied.map((r) => [r.key, r.result]));
const has = (p) => existsSync(join(root, p));

// 1. Clean repo → only the always-on universal files (+ Cursor) are written.
let res = byKey(applyRules(root));
assert(res.agents === 'created', 'clean repo → AGENTS.md created');
assert(res.claude === 'created', 'clean repo → CLAUDE.md created');
assert(res.cursor === 'created', 'clean repo → .cursor/rules/threadctx.mdc created');
assert(res.copilot === undefined, 'clean repo → Copilot skipped (no .github/)');
assert(res.windsurf === undefined, 'clean repo → Windsurf skipped (no .windsurf/)');
assert(res.cline === undefined, 'clean repo → Cline skipped (no .clinerules)');
assert(res.gemini === undefined, 'clean repo → Gemini skipped (no .gemini/)');
assert(has('AGENTS.md') && has('CLAUDE.md') && has('.cursor/rules/threadctx.mdc'), 'universal files exist on disk');
assert(!has('.github/copilot-instructions.md'), 'no Copilot file written into a repo without .github/');

// 2. Second run with no changes → everything unchanged (idempotent).
res = byKey(applyRules(root));
assert(res.agents === 'unchanged' && res.claude === 'unchanged' && res.cursor === 'unchanged', 'second run is a no-op');

// 3. Add each tool's footprint → its file gets written, and only then.
mkdirSync(join(root, '.github'), { recursive: true });
mkdirSync(join(root, '.windsurf'), { recursive: true });
mkdirSync(join(root, '.clinerules'), { recursive: true });
mkdirSync(join(root, '.gemini'), { recursive: true });
res = byKey(applyRules(root));
assert(res.copilot === 'created', 'with .github/ → Copilot instructions created');
assert(res.windsurf === 'created', 'with .windsurf/ → Windsurf rule created');
assert(res.cline === 'created', 'with .clinerules → Cline rule created');
assert(res.gemini === 'created', 'with .gemini/ → GEMINI.md created');
assert(res.agents === 'unchanged', 'existing universal files remain unchanged when tool files appear');

// 4. Windsurf frontmatter uses the current always-on trigger.
const windsurf = readFileSync(join(root, '.windsurf/rules/threadctx.md'), 'utf-8');
assert(/trigger: always_on/.test(windsurf), 'Windsurf file carries `trigger: always_on` frontmatter');
// Cursor frontmatter uses alwaysApply.
const cursor = readFileSync(join(root, '.cursor/rules/threadctx.mdc'), 'utf-8');
assert(/alwaysApply: true/.test(cursor), 'Cursor file carries `alwaysApply: true` frontmatter');

// 5. User content outside the markers is preserved when we refresh a shared file.
const agentsPath = join(root, 'AGENTS.md');
const userLine = '# My project\n\nBuild with `make`. Run tests with `make test`.\n';
writeFileSync(agentsPath, userLine + '\n' + readFileSync(agentsPath, 'utf-8'));
res = byKey(applyRules(root));
assert(res.agents === 'unchanged', 'refreshing AGENTS.md with an unchanged block is a no-op');
const agentsAfter = readFileSync(agentsPath, 'utf-8');
assert(agentsAfter.includes('Build with `make`'), 'user content above the managed block is preserved');
assert(agentsAfter.includes('memory_query'), 'managed block is still present after preserving user content');

console.log(failed ? '\n❌ rules tests failed.' : '\n🎉 All rules tests passed.');
try {
  rmSync(root, { recursive: true, force: true });
} catch {}
process.exit(failed ? 1 : 0);
