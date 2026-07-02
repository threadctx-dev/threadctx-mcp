// Unit tests for the capture command's pure helpers: robust JSON extraction from
// a chatty LLM response, provider detection, and memory coercion/validation.
// These are the parts most likely to break silently on a real model, so they're
// tested without any network. Run with: npm test
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { parseJsonArray, detectProvider } = await import(join(here, '..', 'dist', 'llm.js'));
const { coerceMemories } = await import(join(here, '..', 'dist', 'capture.js'));

let failed = false;
function assert(cond, label) {
  if (!cond) {
    console.error(`❌ FAIL: ${label}`);
    failed = true;
  } else {
    console.log(`✅ ${label}`);
  }
}

// --- parseJsonArray tolerates fences and surrounding prose ---
assert(parseJsonArray('[]').length === 0, 'parseJsonArray: empty array');
assert(
  parseJsonArray('Here you go:\n```json\n[{"content":"x"}]\n```\nHope that helps!').length === 1,
  'parseJsonArray: strips ```json fence and prose'
);
assert(parseJsonArray('not json at all').length === 0, 'parseJsonArray: non-JSON → []');
assert(parseJsonArray('{"content":"x"}').length === 0, 'parseJsonArray: object (not array) → []');
assert(parseJsonArray('[broken').length === 0, 'parseJsonArray: malformed → [] (no throw)');

// --- coerceMemories validates and bounds ---
const coerced = coerceMemories([
  { content: 'A genuinely useful, self-contained lesson about retry backoff.', tags: ['retry', 'incident'] },
  { content: 'short', tags: [] }, // rejected: too short
  { content: 123 }, // rejected: wrong type
  { content: 'Another valid memory with enough length to be kept around.', tags: ['a', 'b', 'c', 'd', 'e', 'f'] },
  'not an object', // rejected
]);
assert(coerced.length === 2, 'coerceMemories: keeps only the two valid, long-enough notes');
assert(coerced[0].tags.length === 2, 'coerceMemories: preserves valid tags');
assert(coerced[1].tags.length === 4, 'coerceMemories: caps tags at 4');

// --- detectProvider honors env keys ---
const savedA = process.env.ANTHROPIC_API_KEY;
const savedO = process.env.OPENAI_API_KEY;
const savedP = process.env.THREADCTX_CAPTURE_PROVIDER;
const savedM = process.env.THREADCTX_CAPTURE_MODEL;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.THREADCTX_CAPTURE_PROVIDER;
delete process.env.THREADCTX_CAPTURE_MODEL;

assert(detectProvider() === null, 'detectProvider: no keys → null');
process.env.OPENAI_API_KEY = 'sk-test';
assert(detectProvider()?.name === 'openai', 'detectProvider: OpenAI key → openai');
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
assert(detectProvider()?.name === 'anthropic', 'detectProvider: prefers Anthropic when both set');
process.env.THREADCTX_CAPTURE_PROVIDER = 'openai';
assert(detectProvider()?.name === 'openai', 'detectProvider: THREADCTX_CAPTURE_PROVIDER forces openai');
assert(detectProvider('my-model')?.model === 'my-model', 'detectProvider: explicit model override wins');

// restore env
if (savedA === undefined) delete process.env.ANTHROPIC_API_KEY;
else process.env.ANTHROPIC_API_KEY = savedA;
if (savedO === undefined) delete process.env.OPENAI_API_KEY;
else process.env.OPENAI_API_KEY = savedO;
if (savedP === undefined) delete process.env.THREADCTX_CAPTURE_PROVIDER;
else process.env.THREADCTX_CAPTURE_PROVIDER = savedP;
if (savedM === undefined) delete process.env.THREADCTX_CAPTURE_MODEL;
else process.env.THREADCTX_CAPTURE_MODEL = savedM;

console.log(failed ? '\n❌ capture tests failed.' : '\n🎉 All capture tests passed.');
process.exit(failed ? 1 : 0);
