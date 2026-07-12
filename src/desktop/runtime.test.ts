import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  buildDesktopServerEnv,
  createDesktopServerUrl,
  isFatalServerExit,
  resolveDesktopServerPort,
  resolveDesktopServerWorkingDir,
  restartManagedBackendAfterStop,
  stopManagedChildProcess,
  waitForServerReady,
} from './runtime.js';

describe('desktop runtime helpers', () => {
  it('builds desktop server env with external listen host and app directories', () => {
    const env = buildDesktopServerEnv({
      inheritedEnv: {
        AUTH_TOKEN: 'admin-token',
        PROXY_TOKEN: 'proxy-token',
      },
      userDataDir: '/tmp/metapi-data',
      logsDir: '/tmp/metapi-logs',
      port: 4312,
    });

    expect(env.HOST).toBe('0.0.0.0');
    expect(env.PORT).toBe('4312');
    expect(env.DATA_DIR).toBe('/tmp/metapi-data');
    expect(env.METAPI_LOG_DIR).toBe('/tmp/metapi-logs');
    expect(env.AUTH_TOKEN).toBe('admin-token');
    expect(env.PROXY_TOKEN).toBe('proxy-token');
  });

  it('creates the browser URL from the local desktop port', () => {
    expect(createDesktopServerUrl(4312)).toBe('http://127.0.0.1:4312');
  });

  it('defaults desktop backend port to 4000', () => {
    expect(resolveDesktopServerPort({})).toBe(4000);
  });

  it('honors explicit desktop backend port override', () => {
    expect(resolveDesktopServerPort({
      METAPI_DESKTOP_SERVER_PORT: '4312',
    })).toBe(4312);
  });

  it('uses resources path as backend cwd for packaged desktop builds', () => {
    expect(resolveDesktopServerWorkingDir({
      appPath: 'C:/Users/test/AppData/Local/Programs/Metapi/resources/app.asar',
      resourcesPath: 'C:/Users/test/AppData/Local/Programs/Metapi/resources',
      isPackaged: true,
    })).toBe('C:/Users/test/AppData/Local/Programs/Metapi/resources');

    expect(resolveDesktopServerWorkingDir({
      appPath: '/workspace/metapi',
      resourcesPath: '/tmp/electron/resources',
      isPackaged: false,
    })).toBe('/workspace/metapi');
  });

  it('waits until the health probe returns ok', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });

    await expect(waitForServerReady({
      url: 'http://127.0.0.1:4312/api/desktop/health',
      fetcher,
      timeoutMs: 250,
      intervalMs: 1,
    })).resolves.toBeUndefined();

    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('fails when the health probe never becomes ready', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: false });

    await expect(waitForServerReady({
      url: 'http://127.0.0.1:4312/api/desktop/health',
      fetcher,
      timeoutMs: 10,
      intervalMs: 1,
    })).rejects.toThrow('Timed out waiting for metapi desktop server');
  });

  it('treats non-zero non-signal exits as fatal', () => {
    expect(isFatalServerExit({ code: 1, signal: null })).toBe(true);
    expect(isFatalServerExit({ code: 0, signal: null })).toBe(false);
    expect(isFatalServerExit({ code: null, signal: 'SIGTERM' })).toBe(false);
  });

  it('waits for graceful child exit before using SIGKILL', async () => {
    const child = new EventEmitter() as EventEmitter & {
      connected: boolean;
      kill: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
    };
    child.connected = true;
    child.kill = vi.fn();
    child.send = vi.fn();

    const stopped = stopManagedChildProcess(child, { timeoutMs: 50 });
    expect(child.send).toHaveBeenCalledWith(
      { type: 'metapi:shutdown' },
      expect.any(Function),
    );
    expect(child.kill).not.toHaveBeenCalledWith('SIGTERM');
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
    child.emit('exit', 0, 'SIGTERM');

    await expect(stopped).resolves.toBeUndefined();
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
  });

  it('uses SIGKILL only after the graceful timeout', async () => {
    vi.useFakeTimers();
    const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
    child.kill = vi.fn();

    const stopped = stopManagedChildProcess(child, { timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(child.kill.mock.calls.map((call) => call[0])).toEqual(['SIGTERM', 'SIGKILL']);
    child.emit('exit', null, 'SIGKILL');
    await stopped;
    vi.useRealTimers();
  });

  it('falls back to SIGTERM when IPC send throws synchronously', async () => {
    const child = new EventEmitter() as EventEmitter & {
      connected: boolean;
      kill: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
    };
    child.connected = true;
    child.kill = vi.fn();
    child.send = vi.fn(() => { throw new Error('channel closed'); });

    const stopped = stopManagedChildProcess(child, { timeoutMs: 50 });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('exit', 0, 'SIGTERM');
    await expect(stopped).resolves.toBeUndefined();
  });

  it('falls back to SIGTERM when IPC send callback reports failure', async () => {
    const child = new EventEmitter() as EventEmitter & {
      connected: boolean;
      kill: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
    };
    child.connected = true;
    child.kill = vi.fn();
    child.send = vi.fn((_message, callback: (error: Error | null) => void) => {
      callback(new Error('channel closed'));
      return false;
    });

    const stopped = stopManagedChildProcess(child, { timeoutMs: 50 });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('exit', 0, 'SIGTERM');
    await expect(stopped).resolves.toBeUndefined();
  });

  it('does not start a replacement backend when quit begins during restart drain', async () => {
    let releaseStop!: () => void;
    let quitting = false;
    const start = vi.fn(async () => undefined);
    const restarting = restartManagedBackendAfterStop({
      stop: () => new Promise<void>((resolve) => { releaseStop = resolve; }),
      shouldRestart: () => !quitting,
      start,
    });

    quitting = true;
    releaseStop();

    await expect(restarting).resolves.toBe(false);
    expect(start).not.toHaveBeenCalled();
  });
});
