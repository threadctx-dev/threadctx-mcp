import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import os from 'node:os';

export interface ThreadctxConfig {
  mode: 'local' | 'cloud';
  apiKey?: string;
  apiUrl: string;
  repo: string;
  dbPath: string;
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

export function loadConfig(): ThreadctxConfig {
  const fileConfig = readFileConfig();

  const apiKey = process.env.THREADCTX_API_KEY ?? fileConfig.apiKey;
  const mode: 'local' | 'cloud' =
    (process.env.THREADCTX_MODE as 'local' | 'cloud' | undefined) ??
    fileConfig.mode ??
    (apiKey ? 'cloud' : 'local');

  return {
    mode,
    apiKey,
    apiUrl: process.env.THREADCTX_API_URL ?? fileConfig.apiUrl ?? DEFAULT_API_URL,
    repo: process.env.THREADCTX_REPO ?? fileConfig.repo ?? detectRepoName(),
    dbPath: process.env.THREADCTX_DB_PATH ?? join(os.homedir(), '.threadctx', 'local.json'),
  };
}
