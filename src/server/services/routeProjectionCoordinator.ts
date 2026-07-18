import { AsyncLocalStorage } from 'node:async_hooks';

type RouteProjectionContext = {
  active: boolean;
};

const routeProjectionContext = new AsyncLocalStorage<RouteProjectionContext>();
let routeProjectionTail: Promise<void> = Promise.resolve();

/**
 * Serializes route projection writes within this process while allowing nested workflows.
 * Multi-process deployments still require an external or database-level single-writer lock.
 */
export function runRouteProjectionExclusive<T>(task: () => Promise<T>): Promise<T> {
  if (routeProjectionContext.getStore()?.active) {
    return task();
  }

  const run = routeProjectionTail.then(() => {
    const context: RouteProjectionContext = { active: true };
    return routeProjectionContext.run(context, async () => {
      try {
        return await task();
      } finally {
        context.active = false;
      }
    });
  });
  routeProjectionTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
