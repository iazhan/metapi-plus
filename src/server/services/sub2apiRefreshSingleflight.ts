import type { schema } from '../db/index.js';
import {
  abortAndClearSingleflights,
  type AbortableSingleflightGeneration,
  runAbortableSingleflight,
} from './abortableSingleflight.js';
import { refreshSub2ApiManagedSession } from './sub2apiManagedAuth.js';

type RefreshParams = {
  account: typeof schema.accounts.$inferSelect;
  site: typeof schema.sites.$inferSelect;
  currentAccessToken: string;
  currentExtraConfig: string | null;
  signal?: AbortSignal;
};

type RefreshResult = Awaited<ReturnType<typeof refreshSub2ApiManagedSession>>;

const refreshInFlight = new Map<number, AbortableSingleflightGeneration<RefreshResult>>();

export async function refreshSub2ApiManagedSessionSingleflight(params: RefreshParams) {
  return runAbortableSingleflight(
    refreshInFlight,
    params.account.id,
    (operationSignal) => refreshSub2ApiManagedSession({
      ...params,
      signal: operationSignal,
    }),
    params.signal,
  );
}

export function __resetSub2ApiManagedRefreshSingleflightForTests() {
  abortAndClearSingleflights(refreshInFlight);
}
