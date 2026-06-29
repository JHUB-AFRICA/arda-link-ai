/**
 * minimax (M3) provider.
 *
 * Endpoint: https://api.minimax.io/v1 (OpenAI-compatible) — note
 * that the OpenAPI schema for /v1/chat/completions on M3 does NOT
 * include a `response_format` parameter; structured JSON is done by
 * prompting + tolerant parsing. Function calling is fully supported
 * via the standard `tools` array.
 *
 * Auth:    Bearer $MINIMAX_API_KEY
 * Default model: MiniMax-M3
 *
 * If MINIMAX_API_KEY is unset, returns a MockClient tagged 'minimax'.
 */

import { logger } from '../../logger.js';
import { MockClient } from './mock.js';
import type {
  LlmClient,
  LlmHealth,
  LlmRequest,
  LlmResponse,
  LlmTask,
} from '../types.js';
import { LlmError } from '../types.js';

const TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS ?? '90000', 10);

const MINIMAX_ENDPOINT = 'https://api.minimax.io/v1';
const DEFAULT_MODEL = process.env.MINIMAX_DEFAULT_MODEL ?? 'MiniMax-M3';

export class MinimaxClient implements LlmClient {
  readonly name = 'minimax';
  readonly tasks: LlmTask[] = [
    'reasoning',
    'code',
    'multilingual',
    'voice_script',
    'summarize',
    'extract',
    'default',
  ];
  private readonly apiKey: string;

  constructor(apiKey: string | undefined) {
    this.apiKey = apiKey ?? '';
  }

  static create(): LlmClient {
    const key = process.env.MINIMAX_API_KEY;
    if (!key) {
      logger.warn(
        'MINIMAX_API_KEY not set — MinimaxClient falls back to MockClient',
      );
      return new MockClient('minimax', 'MiniMax-M3');
    }
    return new MinimaxClient(key);
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const start = Date.now();
    const body: Record<string, unknown> = {
      model: DEFAULT_MODEL,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      stream: false,
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.tools) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: {
            type: 'object',
            properties: Object.fromEntries(
              t.parameters.map((p) => [p.name, { type: p.type, description: p.description }]),
            ),
            required: t.parameters.filter((p) => p.required).map((p) => p.name),
          },
        },
      }));
      body.tool_choice = 'auto';
    }
    // NOTE: response_format is intentionally NOT set on the minimax
    // M3 endpoint — the OpenAPI schema doesn't include it. Structured
    // output is achieved via prompting ("Output JSON only") + tolerant
    // parsing in the registry's completeJson().

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    const upstream = AbortSignal.any([ac.signal, req.signal ?? new AbortController().signal]);

    try {
      const res = await fetch(`${MINIMAX_ENDPOINT}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: upstream,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new LlmError(
          `minimax ${res.status}: ${text.slice(0, 200)}`,
          this.name,
          res.status,
        );
      }
      const data = (await res.json()) as {
        choices: { message: { content: string } }[];
        usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      };
      const content = data.choices?.[0]?.message?.content ?? '';
      const usage = {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
      };
      return {
        content,
        usage,
        provider: this.name,
        model: DEFAULT_MODEL,
        latencyMs: Date.now() - start,
        cached: false,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async completeJson<T>(req: LlmRequest, schema: import('zod').ZodType<T>): Promise<T> {
    // Since M3 lacks response_format, instruct the model to emit JSON
    // and parse with a tolerant wrapper.
    const reinforced: LlmRequest = {
      ...req,
      messages: [
        ...req.messages,
        {
          role: 'user',
          content:
            'Respond with JSON only. No prose, no markdown. The JSON must validate against the schema described above.',
        },
      ],
    };
    const response = await this.complete(reinforced);
    return schema.parse(JSON.parse(response.content));
  }

  async health(): Promise<LlmHealth> {
    const start = Date.now();
    try {
      const res = await fetch(`${MINIMAX_ENDPOINT}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      return { ok: res.ok, latencyMs: Date.now() - start };
    } catch (e) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
}
