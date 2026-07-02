// Minimal, dependency-free LLM client used by `threadctx capture` to distill
// git history into memories. Deliberately uses each provider's raw HTTP API via
// global fetch (Node 18+) rather than an SDK, to keep the `npx threadctx-mcp`
// install a single small package with no transitive AI-SDK weight.
//
// The key is the *user's own* provider key (ANTHROPIC_API_KEY / OPENAI_API_KEY),
// read from the environment — capture never routes text through threadctx's
// servers, so local mode still makes no network call beyond the LLM provider the
// user already trusts with their code.

export type ProviderName = 'anthropic' | 'openai';

export interface LlmProvider {
  name: ProviderName;
  apiKey: string;
  model: string;
}

const DEFAULT_MODELS: Record<ProviderName, string> = {
  // Small, fast, cheap models — extraction is a cheap classification-ish task and
  // capture may run over many commits, so we default low-cost and let --model or
  // THREADCTX_CAPTURE_MODEL override for higher-fidelity runs.
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-4o-mini',
};

/**
 * Pick a provider from the environment. Explicit provider via
 * THREADCTX_CAPTURE_PROVIDER wins; otherwise Anthropic is preferred when both
 * keys are present. Returns null when no usable key is configured.
 */
export function detectProvider(explicitModel?: string): LlmProvider | null {
  const forced = process.env.THREADCTX_CAPTURE_PROVIDER as ProviderName | undefined;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const model = explicitModel || process.env.THREADCTX_CAPTURE_MODEL;

  const build = (name: ProviderName, apiKey: string): LlmProvider => ({
    name,
    apiKey,
    model: model || DEFAULT_MODELS[name],
  });

  if (forced === 'anthropic' && anthropicKey) return build('anthropic', anthropicKey);
  if (forced === 'openai' && openaiKey) return build('openai', openaiKey);
  if (anthropicKey) return build('anthropic', anthropicKey);
  if (openaiKey) return build('openai', openaiKey);
  return null;
}

/** Send a system+user prompt and return the model's raw text response. */
export async function complete(provider: LlmProvider, system: string, user: string): Promise<string> {
  return provider.name === 'anthropic'
    ? completeAnthropic(provider, system, user)
    : completeOpenai(provider, system, user);
}

async function completeAnthropic(provider: LlmProvider, system: string, user: string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: provider.model,
      max_tokens: 2048,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API error (${res.status}): ${await res.text().catch(() => '')}`);
  const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  return (json.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
}

async function completeOpenai(provider: LlmProvider, system: string, user: string): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify({
      model: provider.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI API error (${res.status}): ${await res.text().catch(() => '')}`);
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content ?? '';
}

/**
 * Parse the first top-level JSON array out of a model response, tolerating
 * ```json fences and surrounding prose. Returns [] if nothing parseable is found
 * rather than throwing, so a chatty model can never crash a capture run.
 */
export function parseJsonArray(text: string): unknown[] {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
