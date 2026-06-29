/**
 * Public surface of the LLM layer.
 *
 * Routes and feature code should import from this file only.
 * No `import { ZaiClient } from '../llm/providers/zai.js'`.
 */

export {
  complete,
  completeJson,
  getLlmClient,
  clearCache,
  routingTable,
  providersHealth,
} from './registry.js';
export { costGuard } from './cost.js';
export { recentCalls, recordSuccess, recordError } from './audit.js';
export type {
  LlmClient,
  LlmRequest,
  LlmResponse,
  LlmMessage,
  LlmTool,
  LlmToolParameter,
  LlmTask,
  LlmUsage,
  LlmHealth,
  LlmError,
  LlmBudgetError,
} from './types.js';
export { MockClient } from './providers/mock.js';
export { ZaiClient } from './providers/zai.js';
export { MinimaxClient } from './providers/minimax.js';
