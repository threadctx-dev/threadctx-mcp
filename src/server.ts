import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './config.js';
import { LocalStore } from './local-store.js';
import { CloudClient } from './cloud-client.js';

// Consistent attribution string across every surface (Claude Code terminal
// output, Cursor's agent panel, future surfaces). See spec section 2.4 —
// the same short string everywhere is what makes the brand legible.
const attributionFooter = (n: number) => `· via threadctx — shared team memory (${n} hit${n === 1 ? '' : 's'})`;

export async function startServer(): Promise<void> {
  const config = loadConfig();

  if (config.mode === 'cloud' && !config.apiKey) {
    console.error(
      '[threadctx] THREADCTX_MODE=cloud but no API key was found. Falling back to local mode. ' +
        'Set THREADCTX_API_KEY or run `npx threadctx init --mode=cloud --api-key=...`.'
    );
  }

  const useCloud = config.mode === 'cloud' && Boolean(config.apiKey);
  const localStore = useCloud ? null : new LocalStore(config.dbPath);
  const cloudClient = useCloud ? new CloudClient(config.apiUrl, config.apiKey!, config.actorId) : null;
  const repo = config.repo;

  const server = new Server(
    { name: 'threadctx', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'memory_write',
        description:
          'Store a learning, decision, fix, or gotcha for this repository so other agents and ' +
          'teammates can find it later. Call this whenever you resolve a non-obvious bug, make an ' +
          'architectural decision, or discover something that would save someone time in the future.',
        inputSchema: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: 'The learning to remember, written so a future reader has full context.',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional short tags, e.g. ["incident", "retry-logic"].',
            },
          },
          required: ['content'],
        },
      },
      {
        name: 'memory_query',
        description:
          "Retrieve relevant past learnings, fixes, decisions, or gotchas from the team's shared " +
          'memory before starting risky or repeated work — e.g. touching a service that has caused ' +
          'incidents before, or implementing something similar to past work. Call this before, not after.',
        inputSchema: {
          type: 'object',
          properties: {
            task_description: { type: 'string', description: 'What you are about to do, in plain language.' },
            max_results: { type: 'number', description: 'Max number of memories to return (default 5).' },
          },
          required: ['task_description'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      if (name === 'memory_write') {
        const content = String((args as Record<string, unknown>)?.content ?? '');
        const rawTags = (args as Record<string, unknown>)?.tags;
        const tags = Array.isArray(rawTags) ? rawTags.map(String) : [];

        if (!content.trim()) throw new Error('content is required');

        const id = localStore
          ? localStore.write(repo, content, tags)
          : (await cloudClient!.write(repo, content, tags)).memory_id;

        return { content: [{ type: 'text', text: `Stored memory ${id} for ${repo}.` }] };
      }

      if (name === 'memory_query') {
        const taskDescription = String((args as Record<string, unknown>)?.task_description ?? '');
        const rawMaxResults = (args as Record<string, unknown>)?.max_results;
        const maxResults = typeof rawMaxResults === 'number' ? rawMaxResults : 5;

        if (!taskDescription.trim()) throw new Error('task_description is required');

        let bundle: string;
        let hitCount: number;

        if (localStore) {
          const hits = localStore.query(repo, taskDescription, maxResults);
          hitCount = hits.length;
          bundle = hits.map((h) => `- ${h.content}`).join('\n');
        } else {
          const result = await cloudClient!.query(repo, taskDescription, maxResults);
          hitCount = result.referenced_memory_ids?.length ?? 0;
          bundle = result.context_bundle ?? '';
        }

        if (hitCount === 0) {
          return { content: [{ type: 'text', text: 'No relevant team memory found for this task.' }] };
        }

        return {
          content: [{ type: 'text', text: `${bundle}\n\n${attributionFooter(hitCount)}` }],
        };
      }

      throw new Error(`Unknown tool: ${name}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `threadctx error: ${message}` }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[threadctx] MCP server running in ${useCloud ? 'cloud' : 'local'} mode for repo "${repo}".`);
}
