import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';

export interface ThreadctxConfig {
  mode: 'local' | 'cloud';
  apiKey?: string;
  apiUrl: string;
  repo: string;
  dbPath: string;
  actorId: string;
}

const DEFAULT_API_URL = 'https://threadctx.dev/api/v1';

interface FileConfig {
  mode?: 'local' | 'cloud';
  apiKey?: string;
  apiUrl?: string;
  repo?: string;
}

function readFileConfig(): FileConfig {
  const projectConfigPath = join(process.cwd(), '.threadctx.json');
  const homeConfigPath = join(os.homedir(), '.threadctx', 'config.json');

  const path = existsSync(projectConfigPath)
    ? projectConfigPath
    : existsSync(homeConfigPath)
      ? homeConfigPath
      : null;

  if (!path) return {};

  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    console.error(`[threadctx] Failed to parse config at ${path}:`, err);
    return {};
  }
}

function detectRepoName(): string {
  try {
    const remote = execSync('git config --get remote.origin.url', {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    const match = remote.match(/[:/]([^/]+\/[^/]+?)(\.git)?$/);
    return match ? match[1] : 'unknown-repo';
  } catch {
    return 'unknown-repo';
  }
}

/**
 * A stable, anonymous per-developer id used only for seat accounting in cloud
 * mode (distinct-actor counting vs. purchased seats). It's a random UUID
 * persisted once at ~/.threadctx/actor — no email, no machine fingerprint, no
 * PII. Can be overridden with THREADCTX_ACTOR_ID (e.g. to pin per-CI identities).
 */
function resolveActorId(dbPath: string): string {
  if (process.env.THREADCTX_ACTOR_ID) return process.env.THREADCTX_ACTOR_ID;
  const actorPath = join(dirname(dbPath), 'actor');
  try {
    if (existsSync(actorPath)) {
      const existing = readFileSync(actorPath, 'utf-8').trim();
      if (existing) return existing;
    }
    const id = randomUUID();
    mkdirSync(dirname(actorPath), { recursive: true });
    writeFileSync(actorPath, id, 'utf-8');
    return id;
  } catch {
    // If disk isn't writable, fall back to an ephemeral id — seat counts will
    // be slightly inflated for this session, which is acceptable and safe.
    return randomUUID();
  }
}

export function loadConfig(): ThreadctxConfig {
  const fileConfig = readFileConfig();

  const apiKey = process.env.THREADCTX_API_KEY ?? fileConfig.apiKey;
  const mode: 'local' | 'cloud' =
    (process.env.THREADCTX_MODE as 'local' | 'cloud' | undefined) ??
    fileConfig.mode ??
    (apiKey ? 'cloud' : 'local');

  const dbPath = process.env.THREADCTX_DB_PATH ?? join(os.homedir(), '.threadctx', 'local.json');

  return {
    mode,
    apiKey,
    apiUrl: process.env.THREADCTX_API_URL ?? fileConfig.apiUrl ?? DEFAULT_API_URL,
    repo: process.env.THREADCTX_REPO ?? fileConfig.repo ?? detectRepoName(),
    dbPath,
    actorId: resolveActorId(dbPath),
  };
}
