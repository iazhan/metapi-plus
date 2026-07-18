import { describe, expect, it } from 'vitest';
import { runRouteProjectionExclusive } from './routeProjectionCoordinator.js';

describe('route projection coordinator', () => {
  it('serializes projection mutations in arrival order', async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = runRouteProjectionExclusive(async () => {
      events.push('first:start');
      await firstGate;
      events.push('first:end');
    });
    const second = runRouteProjectionExclusive(async () => {
      events.push('second:start');
      events.push('second:end');
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(['first:start']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual([
      'first:start',
      'first:end',
      'second:start',
      'second:end',
    ]);
  });

  it('allows a coordinated workflow to call another coordinated projection operation', async () => {
    const events: string[] = [];

    await runRouteProjectionExclusive(async () => {
      events.push('outer:start');
      await runRouteProjectionExclusive(async () => {
        events.push('inner');
      });
      events.push('outer:end');
    });

    expect(events).toEqual(['outer:start', 'inner', 'outer:end']);
  });

  it('continues processing after a failed projection mutation', async () => {
    await expect(runRouteProjectionExclusive(async () => {
      throw new Error('projection failed');
    })).rejects.toThrow('projection failed');

    await expect(runRouteProjectionExclusive(async () => 'recovered')).resolves.toBe('recovered');
  });

  it('requeues detached work after its originating exclusive task has finished', async () => {
    const events: string[] = [];
    let releaseDetached!: () => void;
    const detachedGate = new Promise<void>((resolve) => {
      releaseDetached = resolve;
    });
    let detachedFinishedResolve!: () => void;
    let detachedFinishedReject!: (error: unknown) => void;
    const detachedFinished = new Promise<void>((resolve, reject) => {
      detachedFinishedResolve = resolve;
      detachedFinishedReject = reject;
    });

    await runRouteProjectionExclusive(async () => {
      events.push('origin');
      void detachedGate
        .then(() => runRouteProjectionExclusive(async () => {
          events.push('detached');
        }))
        .then(detachedFinishedResolve, detachedFinishedReject);
    });

    let releaseBlocker!: () => void;
    const blockerGate = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    let blockerStartedResolve!: () => void;
    const blockerStarted = new Promise<void>((resolve) => {
      blockerStartedResolve = resolve;
    });
    const blocker = runRouteProjectionExclusive(async () => {
      events.push('blocker:start');
      blockerStartedResolve();
      await blockerGate;
      events.push('blocker:end');
    });
    await blockerStarted;

    releaseDetached();
    await Promise.resolve();
    await Promise.resolve();
    try {
      expect(events).toEqual(['origin', 'blocker:start']);
    } finally {
      releaseBlocker();
      await Promise.all([blocker, detachedFinished]);
    }
    expect(events).toEqual(['origin', 'blocker:start', 'blocker:end', 'detached']);
  });
});
