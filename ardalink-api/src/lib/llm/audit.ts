/**
 * LLM call audit trail.
 *
 * Every call records provider, model, task, tokens, latency, cache hit,
 * and any fallback chain. Default: in-memory ring buffer (24h,
 * 1000 entries). In production, this should be persisted to a
 * dedicated `llm_calls` table for compliance and cost analysis.
 *
 * Schema (when persisted):
 *   CREATE TABLE llm_calls (
 *     id BIGSERIAL PRIMARY KEY,
 *     tenant_id TEXT,
 *     task TEXT NOT NULL,
 *     provider TEXT NOT NULL,
 *     model TEXT NOT NULL,
 *     input_tokens INT,
 *     output_tokens INT,
 *     total_tokens INT,
 *     latency_ms INT,
 *     cached BOOLEAN,
 *     fallback_from TEXT,
 *     error TEXT,
 *     created_at TIMESTAMPTZ DEFAULT now()
 *   );
 */

import { logger } from '../logger.js';
import type { LlmResponse, LlmTask } from './types.js';

const MAX_ENTRIES = 1000;

export interface LlmCallRecord {
  timestamp: number;
  tenantId?: string;
  task: LlmTask;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  latencyMs: number;
  cached: boolean;
  fallbackFrom?: string;
  error?: string;
}

const ring: LlmCallRecord[] = [];

export function recordCall(record: LlmCallRecord): void {
  ring.push(record);
  if (ring.length > MAX_ENTRIES) {
    ring.shift();
  }
  logger.info(
    {
      llm: {
        task: record.task,
        provider: record.provider,
        model: record.model,
        tokens: record.totalTokens,
        latencyMs: record.latencyMs,
        cached: record.cached,
        fallbackFrom: record.fallbackFrom,
        error: record.error,
      },
    },
    'llm call',
  );
}

export function recordSuccess(
  task: LlmTask,
  response: LlmResponse,
  tenantId?: string,
  fallbackFrom?: string,
): void {
  recordCall({
    timestamp: Date.now(),
    tenantId,
    task,
    provider: response.provider,
    model: response.model,
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    totalTokens: response.usage.totalTokens,
    latencyMs: response.latencyMs,
    cached: response.cached,
    fallbackFrom,
  });
}

export function recordError(
  task: LlmTask,
  provider: string,
  error: unknown,
  tenantId?: string,
): void {
  recordCall({
    timestamp: Date.now(),
    tenantId,
    task,
    provider,
    model: '(error)',
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    latencyMs: 0,
    cached: false,
    error: error instanceof Error ? error.message : String(error),
  });
}

export function recentCalls(): readonly LlmCallRecord[] {
  return ring.slice();
}
