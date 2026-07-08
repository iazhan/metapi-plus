import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type CloseTestResources = () => Promise<void> | void;

export type TestDataDir = {
  path: string;
  cleanup: (closeResources?: CloseTestResources) => Promise<void>;
};

const REMOVE_RETRY_DELAYS_MS = [0, 25, 75, 150, 300] as const;

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

async function removeDirWithRetry(dataDir: string): Promise<void> {
  let lastError: unknown;

  for (const delayMs of REMOVE_RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    try {
      rmSync(dataDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      });
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

export function createTestDataDir(prefix: string): TestDataDir {
  const previousDataDir = process.env.DATA_DIR;
  const dataDir = mkdtempSync(join(tmpdir(), prefix));
  let cleanedUp = false;

  process.env.DATA_DIR = dataDir;

  return {
    path: dataDir,
    async cleanup(closeResources?: CloseTestResources) {
      if (cleanedUp) {
        return;
      }
      try {
        await closeResources?.();
      } finally {
        if (previousDataDir === undefined) {
          delete process.env.DATA_DIR;
        } else {
          process.env.DATA_DIR = previousDataDir;
        }
        await removeDirWithRetry(dataDir);
        cleanedUp = true;
      }
    },
  };
}
