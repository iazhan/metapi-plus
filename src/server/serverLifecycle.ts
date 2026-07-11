import { config } from './config.js';

type StartupInitializationDependencies = {
  hydrateRuntimeSettings: () => Promise<unknown>;
  runCompatibilityWork: () => Promise<void>;
};

type SignalTarget = {
  on(event: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
  off(event: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
};

type IpcTarget = {
  connected?: boolean;
  disconnect?: () => void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  off(event: 'message', listener: (message: unknown) => void): unknown;
};

export async function initializeRuntimeBeforeCompatibility(
  deps: StartupInitializationDependencies,
): Promise<{
  settingsHydrated: boolean;
  hydrationError?: unknown;
  compatibilityError?: unknown;
}> {
  let settingsHydrated = false;
  let hydrationError: unknown;
  let compatibilityError: unknown;

  try {
    await deps.hydrateRuntimeSettings();
    settingsHydrated = true;
  } catch (error) {
    hydrationError = error;
    config.accountGroupRateRefreshEnabled = false;
  }

  try {
    await deps.runCompatibilityWork();
  } catch (error) {
    compatibilityError = error;
  }

  return {
    settingsHydrated,
    ...(hydrationError === undefined ? {} : { hydrationError }),
    ...(compatibilityError === undefined ? {} : { compatibilityError }),
  };
}

export function createGracefulShutdown(deps: {
  closeApp: () => Promise<void>;
  closeDatabase: () => Promise<void>;
}): () => Promise<void> {
  let shutdownPromise: Promise<void> | null = null;

  return () => {
    shutdownPromise ??= (async () => {
      let appCloseError: unknown;
      try {
        await deps.closeApp();
      } catch (error) {
        appCloseError = error;
      }

      await deps.closeDatabase();
      if (appCloseError !== undefined) throw appCloseError;
    })();
    return shutdownPromise;
  };
}

export function registerGracefulShutdownSignals(input: {
  processTarget: SignalTarget;
  shutdown: () => Promise<void>;
  onError: (error: unknown) => void;
}): () => void {
  let requested = false;
  const onSignal = () => {
    if (requested) return;
    requested = true;
    void input.shutdown().catch(input.onError);
  };

  input.processTarget.on('SIGTERM', onSignal);
  input.processTarget.on('SIGINT', onSignal);

  return () => {
    input.processTarget.off('SIGTERM', onSignal);
    input.processTarget.off('SIGINT', onSignal);
  };
}

export function registerGracefulShutdownIpc(input: {
  processTarget: IpcTarget;
  shutdown: () => Promise<void>;
  onError: (error: unknown) => void;
}): () => void {
  let requested = false;
  const onMessage = (message: unknown) => {
    if (
      requested
      || !message
      || typeof message !== 'object'
      || (message as { type?: unknown }).type !== 'metapi:shutdown'
    ) {
      return;
    }
    requested = true;
    void input.shutdown()
      .catch(input.onError)
      .finally(() => {
        if (input.processTarget.connected && input.processTarget.disconnect) {
          input.processTarget.disconnect();
        }
      });
  };

  input.processTarget.on('message', onMessage);
  return () => input.processTarget.off('message', onMessage);
}
