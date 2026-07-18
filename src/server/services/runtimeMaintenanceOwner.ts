export class RuntimeMaintenanceConflictError extends Error {
  readonly code = 'RUNTIME_MAINTENANCE_CONFLICT';

  constructor(readonly activeOperation: RuntimeMaintenanceOperation) {
    super(`runtime maintenance already in progress: ${activeOperation}`);
    this.name = 'RuntimeMaintenanceConflictError';
  }
}

export type RuntimeMaintenanceOperation = 'restore' | 'factory-reset';

type RuntimeMaintenanceContext = {
  markCommitted: () => void;
};

type RuntimeMaintenanceDependencies = {
  stop: () => Promise<void>;
  start: () => unknown;
  restorePriorRuntime?: () => Promise<void>;
  reconcileCommittedRuntime?: () => Promise<void>;
  runExclusive?: <T>(task: () => Promise<T>) => Promise<T>;
};

let activeOperation: RuntimeMaintenanceOperation | null = null;

export async function runRuntimeMaintenance<T>(
  operation: RuntimeMaintenanceOperation,
  work: (context: RuntimeMaintenanceContext) => Promise<T>,
  deps: RuntimeMaintenanceDependencies,
): Promise<T> {
  if (activeOperation) {
    throw new RuntimeMaintenanceConflictError(activeOperation);
  }

  activeOperation = operation;
  let stopped = false;
  try {
    await deps.stop();
    stopped = true;
    let committed = false;
    let restartAllowed = false;
    const executeWork = async (): Promise<T> => {
      try {
        const result = await work({ markCommitted: () => { committed = true; } });
        restartAllowed = true;
        return result;
      } catch (operationError) {
        const recoverRuntime = committed
          ? deps.reconcileCommittedRuntime
          : deps.restorePriorRuntime;
        if (recoverRuntime) {
          try {
            await recoverRuntime();
          } catch (restoreError) {
            throw new Error(
              `failed to reconcile runtime after ${committed ? 'committed' : 'uncommitted'} ${operation}: ${(restoreError as Error).message}`,
              { cause: new AggregateError([operationError, restoreError]) },
            );
          }
        }
        if (committed && !recoverRuntime) throw operationError;
        restartAllowed = true;
        throw operationError;
      }
    };

    const operationPromise = deps.runExclusive
      ? deps.runExclusive(executeWork)
      : executeWork();
    const outcome = await operationPromise.then(
      (value) => ({ success: true as const, value }),
      (error: unknown) => ({ success: false as const, error }),
    );
    if (restartAllowed) await deps.start();
    if (!outcome.success) throw outcome.error;
    return outcome.value;
  } finally {
    if (!stopped) {
      // A failed exclusive stop leaves scheduler ownership unknown; do not start it.
    }
    activeOperation = null;
  }
}
