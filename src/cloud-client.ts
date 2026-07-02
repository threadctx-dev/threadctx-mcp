export interface CloudWriteResponse {
  status: string;
  memory_id: string;
}

export interface CloudQueryResponse {
  context_bundle: string;
  referenced_memory_ids: string[];
  debug?: { num_candidates: number };
}

export interface CloudMemory {
  id: string;
  repo: string;
  content: string;
  tags: string[];
  created_at: string;
}

export interface CloudListResponse {
  memories: CloudMemory[];
  total: number;
}

/**
 * Thin HTTP client for the threadctx cloud API. Talks to either the
 * hosted threadctx.dev service or a self-hosted deployment (set
 * THREADCTX_API_URL to override).
 */
export class CloudClient {
  constructor(
    private apiUrl: string,
    private apiKey: string,
    private actorId?: string
  ) {}

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
    // Anonymous per-developer id for seat accounting (see config.resolveActorId).
    if (this.actorId) headers['X-Threadctx-Actor'] = this.actorId;
    return headers;
  }

  private async request<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.apiUrl}${path}`, {
      method: 'POST',
      headers: this.authHeaders(),
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

  /**
   * Most-recent memories for a repo, used by `threadctx capture` to dedup new
   * extractions against what's already stored. Best-effort: on any error (e.g. an
   * older server without the list endpoint) it returns [] so capture still runs.
   */
  async recent(repo: string, limit = 100): Promise<CloudMemory[]> {
    try {
      const url = `${this.apiUrl}/memory/list?repo=${encodeURIComponent(repo)}&limit=${limit}`;
      const res = await fetch(url, { method: 'GET', headers: this.authHeaders() });
      if (!res.ok) return [];
      const json = (await res.json()) as CloudListResponse;
      return json.memories ?? [];
    } catch {
      return [];
    }
  }
}
