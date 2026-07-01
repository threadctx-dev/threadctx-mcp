import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface LocalMemory {
  id: string;
  content: string;
  tags: string[];
  created_at: string;
  score: number;
}

export interface StoredMemory {
  id: string;
  repo: string;
  content: string;
  tags: string[];
  created_at: string;
}

/**
 * Local mode storage: a single JSON file on disk, zero network calls,
 * zero accounts, and — deliberately — zero native dependencies.
 *
 * We avoid a native SQLite addon on purpose: the headline install path is
 * `npx threadctx-mcp`, and a node-gyp compile step is the most common way
 * that "30-second install" promise breaks (toolchain missing, Node ABI
 * mismatch, etc.). A flat JSON file is more than enough for one developer's
 * own session history (hundreds–thousands of entries) and works on every
 * Node >= 18 without a compiler.
 *
 * Matching is simple keyword overlap rather than semantic search — that keeps
 * local mode embedding-free (no API key required). Cloud mode (CloudClient)
 * gets real semantic search via Upstash Vector.
 */
export class LocalStore {
  private memories: StoredMemory[];

  constructor(private dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.memories = this.load();
  }

  private load(): StoredMemory[] {
    if (!existsSync(this.dbPath)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.dbPath, 'utf-8'));
      return Array.isArray(parsed) ? (parsed as StoredMemory[]) : [];
    } catch {
      // Corrupt or partially-written file: don't crash the agent's session.
      // Start fresh in memory; the next write rewrites a valid file.
      return [];
    }
  }

  private persist(): void {
    // Atomic write: serialize to a temp file then rename, so a crash mid-write
    // can never leave a half-written (and unparseable) store behind.
    const tmp = `${this.dbPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.memories, null, 2), 'utf-8');
    renameSync(tmp, this.dbPath);
  }

  write(repo: string, content: string, tags: string[]): string {
    const id = randomUUID();
    this.memories.push({
      id,
      repo,
      content,
      tags,
      created_at: new Date().toISOString(),
    });
    this.persist();
    return id;
  }

  /**
   * Return stored memories newest-first, optionally scoped to one repo. Used by
   * the `threadctx list` CLI so a developer can see exactly what their agents
   * have written to their own machine — no query keywords, no scoring.
   */
  list(repo?: string): StoredMemory[] {
    return this.memories
      .filter((m) => (repo ? m.repo === repo : true))
      .slice()
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }

  query(repo: string, taskDescription: string, maxResults: number): LocalMemory[] {
    const keywords = taskDescription
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3);

    return this.memories
      .filter((m) => m.repo === repo)
      .map((m) => {
        const haystack = `${m.content} ${m.tags.join(' ')}`.toLowerCase();
        const score = keywords.reduce((acc, k) => acc + (haystack.includes(k) ? 1 : 0), 0);
        return {
          id: m.id,
          content: m.content,
          tags: m.tags,
          created_at: m.created_at,
          score,
        };
      })
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score || (a.created_at < b.created_at ? 1 : -1))
      .slice(0, maxResults);
  }
}
