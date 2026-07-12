import { claudeExecutor } from '../../proxy-core/executors/claudeExecutor.js';
import { defaultExecutor } from '../../proxy-core/executors/defaultExecutor.js';
import type { RuntimeDispatchInput, RuntimeResponse } from '../../proxy-core/executors/types.js';

export async function dispatchRuntimeRequest(
  input: RuntimeDispatchInput,
): Promise<RuntimeResponse> {
  const executor = input.request.runtime?.executor || 'default';
  if (executor === 'claude') {
    return claudeExecutor.dispatch(input);
  }
  return defaultExecutor.dispatch(input);
}
