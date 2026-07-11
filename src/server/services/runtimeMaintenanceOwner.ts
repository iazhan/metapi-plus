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
    try {
      const result = await work({ markCommitted: () => { committed = true; } });
      deps.start();
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
      deps.start();
      throw operationError;
    }
  } finally {
    if (!stopped) {
      // A failed exclusive stop leaves scheduler ownership unknown; do not start it.
    }
    activeOperation = null;
  }
}
