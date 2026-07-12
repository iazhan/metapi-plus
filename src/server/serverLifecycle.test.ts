import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { config } from './config.js';
import {
  createGracefulShutdown,
  initializeRuntimeBeforeCompatibility,
  registerGracefulShutdownSignals,
  registerGracefulShutdownIpc,
} from './serverLifecycle.js';

describe('server lifecycle', () => {
  it('hydrates persisted settings before compatibility work and preserves disabled rate refresh', async () => {
    config.accountGroupRateRefreshEnabled = true;
    const steps: string[] = [];

    const result = await initializeRuntimeBeforeCompatibility({
      hydrateRuntimeSettings: async () => {
        steps.push('hydrate');
        config.accountGroupRateRefreshEnabled = false;
      },
      runCompatibilityWork: async () => {
        steps.push('compatibility');
        throw new Error('compatibility failed');
      },
    });

    expect(steps).toEqual(['hydrate', 'compatibility']);
    expect(config.accountGroupRateRefreshEnabled).toBe(false);
    expect(result.settingsHydrated).toBe(true);
    expect(result.compatibilityError).toEqual(new Error('compatibility failed'));
  });

  it('fails account rate refresh closed when persisted settings hydration fails', async () => {
    config.accountGroupRateRefreshEnabled = true;

    const result = await initializeRuntimeBeforeCompatibility({
      hydrateRuntimeSettings: async () => { throw new Error('hydrate failed'); },
      runCompatibilityWork: async () => undefined,
    });

    expect(config.accountGroupRateRefreshEnabled).toBe(false);
    expect(result.settingsHydrated).toBe(false);
    expect(result.hydrationError).toEqual(new Error('hydrate failed'));
  });

  it('closes Fastify once, drains close hooks, and closes the database last', async () => {
    const steps: string[] = [];
    let releaseApp!: () => void;
    const appClosed = new Promise<void>((resolve) => { releaseApp = resolve; });
    const shutdown = createGracefulShutdown({
      closeApp: async () => {
        steps.push('app-close-start');
        await appClosed;
        steps.push('app-close-done');
      },
      closeDatabase: async () => { steps.push('db-close'); },
    });

    const first = shutdown();
    const second = shutdown();
    await Promise.resolve();
    expect(steps).toEqual(['app-close-start']);
    releaseApp();
    await Promise.all([first, second]);

    expect(steps).toEqual(['app-close-start', 'app-close-done', 'db-close']);
  });

  it.each(['SIGTERM', 'SIGINT'] as const)('maps %s to the same idempotent shutdown', async (signal) => {
    const emitter = new EventEmitter();
    const shutdown = vi.fn(async () => undefined);
    const remove = registerGracefulShutdownSignals({
      processTarget: emitter,
      shutdown,
      onError: vi.fn(),
    });

    emitter.emit(signal);
    emitter.emit(signal);
    await Promise.resolve();

    expect(shutdown).toHaveBeenCalledTimes(1);
    remove();
  });

  it('maps the desktop IPC shutdown command to the same idempotent shutdown', async () => {
    const emitter = new EventEmitter() as EventEmitter & {
      connected: boolean;
      disconnect: ReturnType<typeof vi.fn>;
    };
    emitter.connected = true;
    emitter.disconnect = vi.fn();
    let releaseShutdown!: () => void;
    const shutdown = vi.fn(() => new Promise<void>((resolve) => { releaseShutdown = resolve; }));
    const remove = registerGracefulShutdownIpc({
      processTarget: emitter,
      shutdown,
      onError: vi.fn(),
    });

    emitter.emit('message', { type: 'other' });
    emitter.emit('message', { type: 'metapi:shutdown' });
    emitter.emit('message', { type: 'metapi:shutdown' });
    await Promise.resolve();

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(emitter.disconnect).not.toHaveBeenCalled();
    releaseShutdown();
    await Promise.resolve();
    await Promise.resolve();
    expect(emitter.disconnect).toHaveBeenCalledTimes(1);
    remove();
  });

  it('disconnects desktop IPC after shutdown rejects', async () => {
    const emitter = new EventEmitter() as EventEmitter & {
      connected: boolean;
      disconnect: ReturnType<typeof vi.fn>;
    };
    emitter.connected = true;
    emitter.disconnect = vi.fn();
    const shutdownError = new Error('shutdown failed');
    const onError = vi.fn();
    const remove = registerGracefulShutdownIpc({
      processTarget: emitter,
      shutdown: vi.fn(async () => { throw shutdownError; }),
      onError,
    });

    emitter.emit('message', { type: 'metapi:shutdown' });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(shutdownError));
    expect(emitter.disconnect).toHaveBeenCalledTimes(1);
    remove();
  });
});
