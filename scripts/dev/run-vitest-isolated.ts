import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import process from 'node:process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function createIsolatedVitestDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'metapi-vitest-cli-'));
}

export function createIsolatedVitestEnv(
  baseEnv: NodeJS.ProcessEnv,
  dataDir: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  env.NODE_ENV = 'test';
  env.DB_TYPE = 'sqlite';
  env.DATA_DIR = dataDir;
  delete env.DB_URL;
  return env;
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
  const dataDir = options.dataDir ?? createIsolatedVitestDataDir();
  const env = createIsolatedVitestEnv(options.env ?? process.env, dataDir);
  const vitestEntry = resolve(cwd, 'node_modules', 'vitest', 'vitest.mjs');

  return new Promise((resolveExitCode) => {
    const child = spawn(process.execPath, [vitestEntry, ...args], {
      cwd,
      env,
      stdio: 'inherit',
    });

    child.on('error', (error) => {
      console.error(`[vitest-isolated] Failed to start Vitest: ${error.message}`);
      resolveExitCode(1);
    });

    child.on('close', (code) => {
      resolveExitCode(code ?? 1);
    });
  });
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
