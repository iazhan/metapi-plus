import { describe, expect, it, vi } from 'vitest';

import {
  RuntimeMaintenanceConflictError,
  runRuntimeMaintenance,
} from './runtimeMaintenanceOwner.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('runtimeMaintenanceOwner', () => {
  it('rejects a concurrent restore/reset instead of joining the active operation', async () => {
    const gate = deferred();
    const stop = vi.fn(async () => undefined);
    const start = vi.fn(() => undefined);
    const first = runRuntimeMaintenance('restore', async () => {
      await gate.promise;
      return 'restored';
    }, { stop, start });

    await expect(runRuntimeMaintenance('factory-reset', async () => 'reset', { stop, start }))
      .rejects.toBeInstanceOf(RuntimeMaintenanceConflictError);
    expect(stop).toHaveBeenCalledTimes(1);

    gate.resolve();
    await expect(first).resolves.toBe('restored');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('reconciles the committed runtime after a post-commit failure before restarting', async () => {
    const steps: string[] = [];
    await expect(runRuntimeMaintenance('restore', async ({ markCommitted }) => {
      markCommitted();
      steps.push('hydrate');
      throw new Error('hydrate failed');
    }, {
      stop: async () => { steps.push('stop'); },
      start: () => { steps.push('start'); },
      restorePriorRuntime: async () => { steps.push('restore-runtime'); },
      reconcileCommittedRuntime: async () => { steps.push('reconcile-committed'); },
    })).rejects.toThrow('hydrate failed');

    expect(steps).toEqual(['stop', 'hydrate', 'reconcile-committed', 'start']);
  });

  it('keeps scheduling suspended when committed runtime reconciliation fails', async () => {
    const start = vi.fn(() => undefined);
    await expect(runRuntimeMaintenance('restore', async ({ markCommitted }) => {
      markCommitted();
      throw new Error('hydrate failed');
    }, {
      stop: async () => undefined,
      start,
      restorePriorRuntime: async () => undefined,
      reconcileCommittedRuntime: async () => { throw new Error('reconcile committed failed'); },
    })).rejects.toThrow('reconcile committed failed');

    expect(start).not.toHaveBeenCalled();
  });

  it('calls the scheduler start hook only once when that hook throws', async () => {
    const start = vi.fn(() => {
      throw new Error('scheduler start failed');
    });

    await expect(runRuntimeMaintenance('restore', async () => 'restored', {
      stop: async () => undefined,
      start,
    })).rejects.toThrow('scheduler start failed');

    expect(start).toHaveBeenCalledTimes(1);
  });

  it('waits for an asynchronous scheduler start failure', async () => {
    const start = vi.fn(async () => {
      await Promise.resolve();
      throw new Error('async scheduler start failed');
    });

    await expect(runRuntimeMaintenance('factory-reset', async () => 'reset', {
      stop: async () => undefined,
      start,
    })).rejects.toThrow('async scheduler start failed');

    expect(start).toHaveBeenCalledTimes(1);
  });

  it('keeps work and committed recovery exclusive while stopping and starting outside the lock', async () => {
    const steps: string[] = [];

    await expect(runRuntimeMaintenance('restore', async ({ markCommitted }) => {
      steps.push('work');
      markCommitted();
      throw new Error('work failed');
    }, {
      stop: async () => { steps.push('stop'); },
      start: () => { steps.push('start'); },
      reconcileCommittedRuntime: async () => { steps.push('reconcile-committed'); },
      runExclusive: async (task) => {
        steps.push('exclusive:start');
        try {
          return await task();
        } finally {
          steps.push('exclusive:end');
        }
      },
    })).rejects.toThrow('work failed');

    expect(steps).toEqual([
      'stop',
      'exclusive:start',
      'work',
      'reconcile-committed',
      'exclusive:end',
      'start',
    ]);
  });
});
