/**
 * z.ai (Zhipu AI / GLM) provider.
 *
 * Endpoint: https://api.z.ai/api/paas/v4 (OpenAI-compatible)
 * Auth:    Bearer $ZAI_API_KEY
 * Default model: glm-4.5-flash (free, supports tools + JSON + streaming)
 *
 * If ZAI_API_KEY is unset, this client returns a MockClient instance
 * so the registry still works in dev. The provider surfaces in the
 * audit log as 'z'.
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

// Timeout is read by the registry, but we keep a local copy for
// the AbortController inside this client.
const TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS ?? '90000', 10);

const ZAI_ENDPOINT = 'https://api.z.ai/api/paas/v4';
const DEFAULT_MODEL = process.env.ZAI_DEFAULT_MODEL ?? 'glm-4.5-flash';

export class ZaiClient implements LlmClient {
  readonly name = 'z';
  readonly tasks: LlmTask[] = [
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

  /**
   * Returns a working client — ZaiClient if a key is configured, else
   * a MockClient tagged as 'z' so the audit trail shows which provider
   * was selected for the request.
   */
  static create(): LlmClient {
    const key = process.env.ZAI_API_KEY;
    if (!key) {
      logger.warn(
        'ZAI_API_KEY not set — ZaiClient falls back to MockClient (provider=z)',
      );
      return new MockClient('z', 'glm-4.5-flash');
    }
    return new ZaiClient(key);
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const start = Date.now();
    const body: Record<string, unknown> = {
      model: DEFAULT_MODEL,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      // Disable z.ai's default Thinking Mode — without this, the
      // model burns all of its output budget on internal reasoning
      // and the response takes 15-30s with empty content. With
      // thinking disabled, the model produces content in ~3s.
      thinking: { type: 'disabled' },
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
    if (req.jsonSchema) {
      body.response_format = { type: 'json_object' };
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    const upstream = AbortSignal.any([ac.signal, req.signal ?? new AbortController().signal]);

    try {
      const res = await fetch(`${ZAI_ENDPOINT}/chat/completions`, {
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
          `z.ai ${res.status}: ${text.slice(0, 200)}`,
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
    const response = await this.complete({ ...req, jsonSchema: schema });
    return schema.parse(JSON.parse(response.content));
  }

  async health(): Promise<LlmHealth> {
    const start = Date.now();
    try {
      const res = await fetch(`${ZAI_ENDPOINT}/models`, {
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
