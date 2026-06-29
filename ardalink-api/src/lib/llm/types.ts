/**
 * Provider-agnostic LLM contract for ArdaLink.
 *
 * No business logic in the api or web repos may import from a specific
 * provider (z.ai, minimax, etc.). All calls go through `getLlm(task)`,
 * which the registry routes to the configured provider with a fallback.
 *
 * Adding a third provider is one new file under
 * `ardalink-api/src/lib/llm/providers/<name>.ts` plus one line in
 * `registry.ts`. No route, no schema, no prompt template changes.
 */

import type { z } from 'zod';

export type LlmMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LlmMessage {
  role: LlmMessageRole;
  content: string;
  toolCallId?: string;
}

export interface LlmToolParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object';
  description: string;
  required?: boolean;
}

export interface LlmTool {
  name: string;
  description: string;
  parameters: LlmToolParameter[];
}

export interface LlmRequest {
  messages: LlmMessage[];
  temperature?: number;        // 0.0 - 1.0
  maxTokens?: number;         // hard cap per call
  jsonSchema?: z.ZodTypeAny;  // if set, response is parsed + validated
  tools?: LlmTool[];          // function calling
  signal?: AbortSignal;       // for timeout
  bypassCache?: boolean;      // ?regenerate=1
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface LlmResponse {
  content: string;
  usage: LlmUsage;
  provider: string;           // 'z' | 'minimax' | 'mock'
  model: string;              // e.g. 'z/glm-4.5-flash', 'minimax/MiniMax-M3'
  latencyMs: number;
  cached: boolean;
}

/**
 * Tasks the LLM is asked to perform. Provider routing is keyed off
 * this enum. Adding a new task = one line in `registry.ts` routing
 * table.
 *
 *   multilingual  — free-form chat, /api/chat + /api/talk-chat
 *                   (Swahili / English code-switching)
 *   voice_script  — pre-call opening script for the Realtime voice
 *                   bridge (bilingual pastoralist copy + JSON)
 *   summarize     — tenant intelligence brief
 *   extract       — post-call BCS / offtake / mortality extraction,
 *                   plus short action-tag classification
 *   reasoning     — multi-step / tool use
 *   code          — function-calling synthesis
 *   default       — safe fallback for new code
 */
export type LlmTask =
  | 'multilingual'
  | 'voice_script'
  | 'summarize'
  | 'extract'
  | 'reasoning'
  | 'code'
  | 'default';

export interface LlmHealth {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export interface LlmClient {
  readonly name: string;
  readonly tasks: LlmTask[];
  complete(req: LlmRequest): Promise<LlmResponse>;
  completeJson<T>(req: LlmRequest, schema: import('zod').ZodType<T>): Promise<T>;
  health(): Promise<LlmHealth>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export class LlmBudgetError extends Error {
  constructor(
    message: string,
    public readonly task: LlmTask,
  ) {
    super(message);
    this.name = 'LlmBudgetError';
  }
}
