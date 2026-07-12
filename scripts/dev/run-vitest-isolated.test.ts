import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import * as isolatedVitestRunner from './run-vitest-isolated.js';

type WaitForIsolatedVitestChild = (
  child: EventEmitter,
  options: {
    dataDir: string;
    ownsDataDir: boolean;
  },
) => Promise<number>;

function getWaitForIsolatedVitestChild(): WaitForIsolatedVitestChild {
  const waitForChild = (isolatedVitestRunner as Record<string, unknown>)
    .waitForIsolatedVitestChild;
  expect(waitForChild).toBeTypeOf('function');
  if (typeof waitForChild !== 'function') {
    throw new Error('Expected waitForIsolatedVitestChild to be exported');
  }
  return waitForChild as WaitForIsolatedVitestChild;
}

describe('isolated vitest runner', () => {
  it('removes real sqlite targets inherited from the parent shell', () => {
    const repoDataDir = resolve(process.cwd(), 'data');
    const isolatedDataDir = resolve(process.cwd(), 'tmp', 'vitest-isolated');

    const env = isolatedVitestRunner.createIsolatedVitestEnv({
      DATA_DIR: './data',
      DB_URL: './data/hub.db',
      DB_TYPE: 'postgres',
      NODE_ENV: 'development',
      KEEP_ME: 'yes',
    }, isolatedDataDir);

    expect(env.DATA_DIR).toBe(isolatedDataDir);
    expect(env.DB_TYPE).toBe('sqlite');
    expect(env.DB_URL).toBeUndefined();
    expect(env.NODE_ENV).toBe('test');
    expect(env.KEEP_ME).toBe('yes');
    expect(env.METAPI_VITEST_DATA_ROOT).toBe(isolatedDataDir);
    expect(resolve(env.DATA_DIR)).not.toBe(repoDataDir);
    expect(resolve(env.DATA_DIR, 'hub.db')).not.toBe(resolve(process.cwd(), 'data', 'hub.db'));
  });

  it('keeps package vitest entrypoints behind the isolated runner', () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts.test).toMatch(/^tsx scripts\/dev\/run-vitest-isolated\.ts run --root \./);
    expect(pkg.scripts['test:watch']).toMatch(/^tsx scripts\/dev\/run-vitest-isolated\.ts --root \./);

    for (const scriptName of [
      'test:schema:unit',
      'test:schema:parity',
      'test:schema:upgrade',
      'test:schema:runtime',
    ]) {
      expect(pkg.scripts[scriptName]).toMatch(/^tsx scripts\/dev\/run-vitest-isolated\.ts run --root \./);
    }
  });

  it('wires the worker setup into the vitest config', () => {
    const vitestConfig = readFileSync(resolve(process.cwd(), 'vitest.config.ts'), 'utf8');
    expect(vitestConfig).toContain('scripts/dev/vitest-worker-setup.ts');
  });

  it('replaces inherited database targets through the actual worker setup', async () => {
    const setupModule = await import('./vitest-worker-setup.js') as Record<string, unknown>;
    const configureWorkerEnvironment = setupModule.configureVitestWorkerEnvironment;
    expect(configureWorkerEnvironment).toBeTypeOf('function');
    if (typeof configureWorkerEnvironment !== 'function') {
      throw new Error('Expected configureVitestWorkerEnvironment to be exported');
    }

    const root = mkdtempSync(resolve(tmpdir(), 'metapi-vitest-setup-test-'));
    const env: NodeJS.ProcessEnv = {
      METAPI_VITEST_DATA_ROOT: root,
      VITEST_POOL_ID: '7',
      DATA_DIR: './data',
      DB_URL: './data/hub.db',
      DB_TYPE: 'postgres',
      NODE_ENV: 'development',
    };

    try {
      const dataDir = configureWorkerEnvironment(env) as string;

      expect(env.DATA_DIR).toBe(dataDir);
      expect(env.DB_URL).toBeUndefined();
      expect(env.DB_TYPE).toBe('sqlite');
      expect(env.NODE_ENV).toBe('test');
      expect(dataDir).toContain(resolve(root, 'worker-7-'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allocates a fresh data directory when vitest reuses a pool slot', async () => {
    const setupModule = await import('./vitest-worker-setup.js') as Record<string, unknown>;
    const configureWorkerEnvironment = setupModule.configureVitestWorkerEnvironment;
    expect(configureWorkerEnvironment).toBeTypeOf('function');
    if (typeof configureWorkerEnvironment !== 'function') {
      throw new Error('Expected configureVitestWorkerEnvironment to be exported');
    }

    const root = mkdtempSync(resolve(tmpdir(), 'metapi-vitest-reuse-test-'));
    const env: NodeJS.ProcessEnv = {
      METAPI_VITEST_DATA_ROOT: root,
      VITEST_POOL_ID: '3',
    };

    try {
      const firstDataDir = configureWorkerEnvironment(env) as string;
      const secondDataDir = configureWorkerEnvironment(env) as string;

      expect(secondDataDir).not.toBe(firstDataDir);
      expect(env.DATA_DIR).toBe(secondDataDir);
      expect(firstDataDir).toContain(resolve(root, 'worker-3-'));
      expect(secondDataDir).toContain(resolve(root, 'worker-3-'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('recursively removes a runner-owned data directory after child close', async () => {
    const child = new EventEmitter();
    const dataDir = mkdtempSync(resolve(tmpdir(), 'metapi-vitest-runner-owned-'));
    writeFileSync(resolve(dataDir, 'owned.db'), 'test');
    const runPromise = getWaitForIsolatedVitestChild()(child, {
      dataDir,
      ownsDataDir: true,
    });

    child.emit('close', 0);

    await expect(runPromise).resolves.toBe(0);
    expect(existsSync(dataDir)).toBe(false);
  });

  it('settles and cleans a runner-owned directory only once across error and close', async () => {
    const child = new EventEmitter();
    const dataDir = mkdtempSync(resolve(tmpdir(), 'metapi-vitest-runner-error-'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    writeFileSync(resolve(dataDir, 'owned.db'), 'test');
    const runPromise = getWaitForIsolatedVitestChild()(child, {
      dataDir,
      ownsDataDir: true,
    });

    try {
      child.emit('error', new Error('spawn failed'));

      await expect(runPromise).resolves.toBe(1);
      expect(existsSync(dataDir)).toBe(false);

      mkdirSync(dataDir, { recursive: true });
      writeFileSync(resolve(dataDir, 'after-error.txt'), 'preserve');
      child.emit('close', 1);

      expect(existsSync(dataDir)).toBe(true);
    } finally {
      consoleError.mockRestore();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it.each(['close', 'error'] as const)(
    'never removes a caller-owned data directory after child %s',
    async (eventName) => {
      const child = new EventEmitter();
      const dataDir = mkdtempSync(resolve(tmpdir(), 'metapi-vitest-caller-owned-'));
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const runPromise = getWaitForIsolatedVitestChild()(child, {
        dataDir,
        ownsDataDir: false,
      });

      try {
        writeFileSync(resolve(dataDir, 'caller.db'), 'test');
        if (eventName === 'error') {
          child.emit('error', new Error('spawn failed'));
        } else {
          child.emit('close', 0);
        }

        await expect(runPromise).resolves.toBe(eventName === 'close' ? 0 : 1);
        expect(existsSync(dataDir)).toBe(true);
      } finally {
        consoleError.mockRestore();
        rmSync(dataDir, { recursive: true, force: true });
      }
    },
  );
});
