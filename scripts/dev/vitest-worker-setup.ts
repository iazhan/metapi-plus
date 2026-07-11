import process from 'node:process';
import {
  createIsolatedVitestDataDir,
  createIsolatedVitestWorkerDataDir,
} from './run-vitest-isolated.js';

export function configureVitestWorkerEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const dataRoot = String(env.METAPI_VITEST_DATA_ROOT || '').trim()
    || createIsolatedVitestDataDir();
  const workerDataDir = createIsolatedVitestWorkerDataDir(dataRoot, env);

  env.NODE_ENV = 'test';
  env.DB_TYPE = 'sqlite';
  env.DATA_DIR = workerDataDir;
  env.METAPI_VITEST_DATA_ROOT = dataRoot;
  delete env.DB_URL;

  return workerDataDir;
}

configureVitestWorkerEnvironment();
