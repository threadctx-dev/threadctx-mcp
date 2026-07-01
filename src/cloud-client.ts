export interface CloudWriteResponse {
  status: string;
  memory_id: string;
}

export interface CloudQueryResponse {
  context_bundle: string;
  referenced_memory_ids: string[];
  debug?: { num_candidates: number };
}

/**
 * Thin HTTP client for the threadctx cloud API. Talks to either the
 * hosted threadctx.dev service or a self-hosted deployment (set
 * THREADCTX_API_URL to override).
 */
export class CloudClient {
  constructor(
    private apiUrl: string,
    private apiKey: string
  ) {}

  private async request<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.apiUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 402) {
        throw new Error(
          'threadctx free-tier quota reached for this period. Upgrade at https://threadctx.dev/pricing.'
        );
      }
      if (res.status === 401) {
        throw new Error('threadctx API key is invalid or missing. Check THREADCTX_API_KEY.');
      }
      throw new Error(`threadctx cloud request failed (${res.status}): ${text}`);
    }

    return res.json() as Promise<T>;
  }

  write(repo: string, content: string, tags: string[]): Promise<CloudWriteResponse> {
    return this.request<CloudWriteResponse>('/memory/write', { repo, content, tags });
  }

  query(repo: string, taskDescription: string, maxResults: number): Promise<CloudQueryResponse> {
    return this.request<CloudQueryResponse>('/memory/query', {
      repo,
      task_description: taskDescription,
      max_results: maxResults,
    });
  }
}
