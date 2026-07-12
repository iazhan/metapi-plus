export type AbortableSingleflightGeneration<T> = {
  controller: AbortController;
  promise: Promise<T>;
  settled: boolean;
  waiters: number;
};

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

export function awaitWithAbortSignal<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Coalesces work by key while keeping caller cancellation separate from the
 * shared operation. The last departing waiter abandons its generation
 * immediately, so a replacement generation never depends on late settlement.
 */
export function runAbortableSingleflight<K, T>(
  inFlight: Map<K, AbortableSingleflightGeneration<T>>,
  key: K,
  start: (signal: AbortSignal) => Promise<T>,
  waiterSignal?: AbortSignal,
): Promise<T> {
  waiterSignal?.throwIfAborted();

  let generation = inFlight.get(key);
  if (!generation) {
    const controller = new AbortController();
    let promise: Promise<T>;
    try {
      promise = Promise.resolve(start(controller.signal));
    } catch (error) {
      promise = Promise.reject(error);
    }
    generation = { controller, promise, settled: false, waiters: 0 };
    inFlight.set(key, generation);

    const createdGeneration = generation;
    const settle = () => {
      createdGeneration.settled = true;
      if (inFlight.get(key) === createdGeneration) {
        inFlight.delete(key);
      }
    };
    void promise.then(settle, settle);
  }

  generation.waiters += 1;
  const joinedGeneration = generation;
  return new Promise<T>((resolve, reject) => {
    let active = true;

    const leave = () => {
      if (!active) return;
      active = false;
      waiterSignal?.removeEventListener('abort', onAbort);
      joinedGeneration.waiters -= 1;
      if (joinedGeneration.waiters === 0 && !joinedGeneration.settled) {
        if (inFlight.get(key) === joinedGeneration) {
          inFlight.delete(key);
        }
        joinedGeneration.controller.abort(
          new DOMException('No active singleflight waiters', 'AbortError'),
        );
      }
    };
    const onAbort = () => {
      leave();
      reject(abortReason(waiterSignal!));
    };

    waiterSignal?.addEventListener('abort', onAbort, { once: true });
    if (waiterSignal?.aborted) {
      onAbort();
      return;
    }
    joinedGeneration.promise.then(
      (value) => {
        if (!active) return;
        leave();
        resolve(value);
      },
      (error) => {
        if (!active) return;
        leave();
        reject(error);
      },
    );
  });
}

export function abortAndClearSingleflights<K, T>(
  inFlight: Map<K, AbortableSingleflightGeneration<T>>,
): void {
  for (const generation of inFlight.values()) {
    generation.controller.abort(new DOMException('Singleflight reset', 'AbortError'));
  }
  inFlight.clear();
}
