import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import process from 'node:process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function createIsolatedVitestDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'metapi-vitest-cli-'));
}

export function createIsolatedVitestWorkerDataDir(
  dataRoot: string,
  env: NodeJS.ProcessEnv,
): string {
  const workerTag = String(
    env.VITEST_POOL_ID
    || env.VITEST_WORKER_ID
    || process.pid,
  ).trim() || String(process.pid);
  const safeWorkerTag = workerTag.replace(/[^a-zA-Z0-9._-]/g, '_');
  const resolvedDataRoot = resolve(dataRoot);
  mkdirSync(resolvedDataRoot, { recursive: true });
  return mkdtempSync(join(resolvedDataRoot, `worker-${safeWorkerTag}-`));
}

export function createIsolatedVitestEnv(
  baseEnv: NodeJS.ProcessEnv,
  dataDir: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  env.NODE_ENV = 'test';
  env.DB_TYPE = 'sqlite';
  env.DATA_DIR = dataDir;
  env.METAPI_VITEST_DATA_ROOT = dataDir;
  delete env.DB_URL;
  return env;
}

export function waitForIsolatedVitestChild(
  child: Pick<ChildProcess, 'once'>,
  options: {
    dataDir: string;
    ownsDataDir: boolean;
  },
): Promise<number> {
  return new Promise((resolveExitCode) => {
    let settled = false;

    const settleOnce = (exitCode: number, spawnError?: Error) => {
      if (settled) {
        return;
      }
      settled = true;

      if (spawnError != null) {
        console.error(`[vitest-isolated] Failed to start Vitest: ${spawnError.message}`);
      }

      try {
        if (options.ownsDataDir) {
          rmSync(options.dataDir, { recursive: true, force: true });
        }
      } catch (cleanupError) {
        const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        console.error(`[vitest-isolated] Failed to remove temporary data directory: ${message}`);
      } finally {
        resolveExitCode(exitCode);
      }
    };

    child.once('error', (error) => {
      settleOnce(1, error);
    });

    child.once('close', (code) => {
      settleOnce(code ?? 1);
    });
  });
}

export async function runIsolatedVitest(
  args = process.argv.slice(2),
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    dataDir?: string;
  } = {},
): Promise<number> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const ownsDataDir = options.dataDir == null;
  const dataDir = options.dataDir ?? createIsolatedVitestDataDir();
  const env = createIsolatedVitestEnv(options.env ?? process.env, dataDir);
  const vitestEntry = resolve(cwd, 'node_modules', 'vitest', 'vitest.mjs');

  const child = spawn(process.execPath, [vitestEntry, ...args], {
    cwd,
    env,
    stdio: 'inherit',
  });

  return waitForIsolatedVitestChild(child, { dataDir, ownsDataDir });
}

const isMainModule = (() => {
  try {
    return process.argv[1] != null && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMainModule) {
  const exitCode = await runIsolatedVitest();
  process.exit(exitCode);
}
