import type { RuntimeDispatchInput, RuntimeExecutor } from './types.js';
import { performFetch } from './types.js';

export const defaultExecutor: RuntimeExecutor = {
  async dispatch(input: RuntimeDispatchInput) {
    return performFetch(input, input.request);
  },
};
