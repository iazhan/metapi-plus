import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BackgroundTask } from '../services/backgroundTaskService.js';
import { waitForBackgroundTaskToReachTerminalState } from './backgroundTaskTestUtils.js';

function buildTask(status: BackgroundTask['status']): BackgroundTask {
  const now = new Date().toISOString();
  return {
    id: 'task-id',
    type: 'test',
    title: 'test task',
    status,
    message: 'test task',
    error: null,
    result: null,
    dedupeKey: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    expiresAtMs: Date.now() + 60_000,
    logs: [],
  };
}

describe('waitForBackgroundTaskToReachTerminalState', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps polling long enough for slower background tasks under full-suite load', async () => {
    vi.useFakeTimers();

    let task = buildTask('running');
    setTimeout(() => {
      task = buildTask('succeeded');
    }, 6_000);

    const waitPromise = waitForBackgroundTaskToReachTerminalState(() => task, task.id);

    await vi.advanceTimersByTimeAsync(6_000);

    await expect(waitPromise).resolves.toMatchObject({ status: 'succeeded' });
  });
});
