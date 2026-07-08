import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDataDir } from './testDataDir.js';

describe('testDataDir fixture', () => {
  const originalDataDir = process.env.DATA_DIR;

  afterEach(() => {
    if (originalDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = originalDataDir;
    }
  });

  it('restores DATA_DIR and closes resources before deleting the temp directory', async () => {
    process.env.DATA_DIR = 'original-data-dir';
    const dataDir = createTestDataDir('metapi-test-fixture-');
    const closeEvents: string[] = [];

    try {
      expect(process.env.DATA_DIR).toBe(dataDir.path);
      expect(existsSync(dataDir.path)).toBe(true);

      await dataDir.cleanup(() => {
        closeEvents.push(existsSync(dataDir.path) ? 'closed-before-remove' : 'closed-after-remove');
      });

      expect(closeEvents).toEqual(['closed-before-remove']);
      expect(process.env.DATA_DIR).toBe('original-data-dir');
      expect(existsSync(dataDir.path)).toBe(false);
    } finally {
      await dataDir.cleanup();
    }
  });

  it('allows cleanup to be retried when directory removal fails', async () => {
    vi.resetModules();

    let failRemoval = true;
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');

      return {
        ...actual,
        rmSync: vi.fn((path: Parameters<typeof actual.rmSync>[0], options?: Parameters<typeof actual.rmSync>[1]) => {
          if (failRemoval) {
            throw new Error('remove failed');
          }
          return actual.rmSync(path, options);
        }),
      };
    });

    const { createTestDataDir: createMockedTestDataDir } = await import('./testDataDir.js');
    const dataDir = createMockedTestDataDir('metapi-test-fixture-retry-');

    try {
      await expect(dataDir.cleanup()).rejects.toThrow('remove failed');
      expect(existsSync(dataDir.path)).toBe(true);

      failRemoval = false;
      await expect(dataDir.cleanup()).resolves.toBeUndefined();
      expect(existsSync(dataDir.path)).toBe(false);
    } finally {
      failRemoval = false;
      await dataDir.cleanup().catch(() => undefined);
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });
});
