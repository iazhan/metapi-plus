type DesktopServerEnvInput = {
  inheritedEnv?: NodeJS.ProcessEnv;
  userDataDir: string;
  logsDir: string;
  port: number;
};

type WaitForServerReadyInput = {
  url: string;
  fetcher?: (input: string, init?: RequestInit) => Promise<{ ok: boolean }>;
  timeoutMs?: number;
  intervalMs?: number;
};

type ServerExitState = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

type DesktopServerWorkingDirInput = {
  appPath: string;
  resourcesPath: string;
  isPackaged: boolean;
};

type ManagedChildProcess = {
  connected?: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: 'exit', listener: () => void): unknown;
  off(event: 'exit', listener: () => void): unknown;
  send?(message: unknown, callback?: (error: Error | null) => void): boolean;
};

const DEFAULT_DESKTOP_SERVER_PORT = 4000;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_READY_INTERVAL_MS = 250;

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function buildDesktopServerEnv(input: DesktopServerEnvInput): NodeJS.ProcessEnv {
  const host = (input.inheritedEnv?.HOST || '0.0.0.0').trim() || '0.0.0.0';

  return {
    ...(input.inheritedEnv || {}),
    HOST: host,
    PORT: String(input.port),
    DATA_DIR: input.userDataDir,
    METAPI_DESKTOP: '1',
    METAPI_LOG_DIR: input.logsDir,
  };
}

export function createDesktopServerUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export function createDesktopHealthUrl(port: number): string {
  return `${createDesktopServerUrl(port)}/api/desktop/health`;
}

export function resolveDesktopServerPort(env?: NodeJS.ProcessEnv): number {
  const forcedPort = Number.parseInt(env?.METAPI_DESKTOP_SERVER_PORT || '', 10);
  if (Number.isFinite(forcedPort) && forcedPort > 0) return forcedPort;
  return DEFAULT_DESKTOP_SERVER_PORT;
}

export function resolveDesktopServerWorkingDir(input: DesktopServerWorkingDirInput): string {
  return input.isPackaged ? input.resourcesPath : input.appPath;
}

export async function waitForServerReady(input: WaitForServerReadyInput): Promise<void> {
  const fetcher = input.fetcher || ((url: string, init?: RequestInit) => fetch(url, init));
  const timeoutMs = input.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const intervalMs = input.intervalMs ?? DEFAULT_READY_INTERVAL_MS;
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const response = await fetcher(input.url, { method: 'GET' });
      if (response.ok) return;
    } catch {
      // Retry until timeout.
    }
    await delay(intervalMs);
  }

  throw new Error('Timed out waiting for metapi desktop server');
}

export function isFatalServerExit(exitState: ServerExitState): boolean {
  return exitState.code !== null && exitState.code !== 0 && !exitState.signal;
}

export function stopManagedChildProcess(
  child: ManagedChildProcess,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;

  return new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      child.off('exit', finish);
      resolve();
    };

    child.once('exit', finish);
    timeout = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);
    const fallbackToSignal = () => {
      child.kill('SIGTERM');
    };
    if (child.connected && typeof child.send === 'function') {
      try {
        child.send({ type: 'metapi:shutdown' }, (error) => {
          if (error) fallbackToSignal();
        });
      } catch {
        fallbackToSignal();
      }
    } else {
      fallbackToSignal();
    }
  });
}

export async function restartManagedBackendAfterStop(input: {
  stop: () => Promise<void>;
  shouldRestart: () => boolean;
  start: () => Promise<void>;
}): Promise<boolean> {
  await input.stop();
  if (!input.shouldRestart()) return false;
  await input.start();
  return true;
}
