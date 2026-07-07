/**
 * Azure AI Foundry / Azure OpenAI provider.
 *
 * Speaks the classic Azure OpenAI chat-completions URL shape:
 *
 *   POST {AZURE_OPENAI_ENDPOINT}/openai/deployments/{deployment}
 *        /chat/completions?api-version={AZURE_OPENAI_CHAT_API_VERSION}
 *
 * with the `api-key: <AZURE_OPENAI_API_KEY>` header. Works for both
 * classic Azure OpenAI resources (*.openai.azure.com) and AI Foundry
 * project resources (*.services.ai.azure.com) — the classic URL path
 * is served on both host shapes.
 *
 * If AZURE_OPENAI_API_KEY is unset, this client returns a MockClient
 * tagged 'azure' so the registry still works in dev.
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

function resourceBase(): string {
  const raw = process.env.AZURE_OPENAI_ENDPOINT ?? '';
  return raw.replace(/\/$/, '');
}

function chatUrl(): string {
  const base = resourceBase();
  const deployment =
    process.env.AZURE_OPENAI_CHAT_DEPLOYMENT ?? 'gpt-5-mini';
  const apiVersion =
    process.env.AZURE_OPENAI_CHAT_API_VERSION ?? '2024-10-21';
  return `${base}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
}

export class AzureOpenAIClient implements LlmClient {
  readonly name = 'azure';
  readonly tasks: LlmTask[] = [
    'multilingual',
    'voice_script',
    'summarize',
    'extract',
    'reasoning',
    'code',
    'default',
  ];
  private readonly apiKey: string;

  constructor(apiKey: string | undefined) {
    this.apiKey = apiKey ?? '';
  }

  static create(): LlmClient {
    const key = process.env.AZURE_OPENAI_API_KEY;
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    if (!key || !endpoint) {
      logger.warn(
        'AZURE_OPENAI_API_KEY or AZURE_OPENAI_ENDPOINT not set — AzureOpenAIClient falls back to MockClient (provider=azure)',
      );
      return new MockClient(
        'azure',
        process.env.AZURE_OPENAI_CHAT_DEPLOYMENT ?? 'gpt-5-mini',
      );
    }
    return new AzureOpenAIClient(key);
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const start = Date.now();
    const deployment =
      process.env.AZURE_OPENAI_CHAT_DEPLOYMENT ?? 'gpt-5-mini';
    // GPT-5 family requires `max_completion_tokens` (older gpt-4o still
    // accepts `max_tokens`). Detect by deployment name — set env override
    // AZURE_OPENAI_USE_MAX_COMPLETION_TOKENS=1 to force it on other names.
    const isGpt5 =
      /gpt-5/i.test(deployment) ||
      process.env.AZURE_OPENAI_USE_MAX_COMPLETION_TOKENS === '1';
    const body: Record<string, unknown> = {
      messages: req.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    };
    // GPT-5 rejects `temperature` outside of 1.0 — skip it entirely for
    // that family and let the model default apply. gpt-4o accepts it.
    if (req.temperature !== undefined && !isGpt5) {
      body.temperature = req.temperature;
    }
    if (req.maxTokens !== undefined) {
      if (isGpt5) body.max_completion_tokens = req.maxTokens;
      else body.max_tokens = req.maxTokens;
    }
    // Without this, GPT-5 spends its whole completion budget on hidden
    // reasoning tokens and returns empty content. Minimal effort is what
    // ArdaLink's copy tasks (voice_script, extract, summarize) actually
    // want — they're template + JSON, not chain-of-thought.
    if (isGpt5) {
      body.reasoning_effort =
        process.env.AZURE_OPENAI_REASONING_EFFORT ?? 'minimal';
    }
    if (req.tools) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: {
            type: 'object',
            properties: Object.fromEntries(
              t.parameters.map((p) => [
                p.name,
                { type: p.type, description: p.description },
              ]),
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
    const upstream = AbortSignal.any([
      ac.signal,
      req.signal ?? new AbortController().signal,
    ]);

    try {
      const res = await fetch(chatUrl(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': this.apiKey,
        },
        body: JSON.stringify(body),
        signal: upstream,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new LlmError(
          `azure ${res.status}: ${text.slice(0, 200)}`,
          this.name,
          res.status,
        );
      }
      const data = (await res.json()) as {
        choices: { message: { content: string } }[];
        usage?: {
          prompt_tokens: number;
          completion_tokens: number;
          total_tokens: number;
        };
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
        model: deployment,
        latencyMs: Date.now() - start,
        cached: false,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async completeJson<T>(
    req: LlmRequest,
    schema: import('zod').ZodType<T>,
  ): Promise<T> {
    const response = await this.complete({ ...req, jsonSchema: schema });
    return schema.parse(JSON.parse(response.content));
  }

  async health(): Promise<LlmHealth> {
    const start = Date.now();
    try {
      // Cheapest health probe: a 1-token completion. Azure OpenAI doesn't
      // expose /models on Foundry endpoints, and even where it does the
      // shape varies across resource types.
      const deployment =
        process.env.AZURE_OPENAI_CHAT_DEPLOYMENT ?? 'gpt-5-mini';
      const isGpt5 =
        /gpt-5/i.test(deployment) ||
        process.env.AZURE_OPENAI_USE_MAX_COMPLETION_TOKENS === '1';
      const probeBody: Record<string, unknown> = {
        messages: [{ role: 'user', content: 'ping' }],
      };
      if (isGpt5) {
        probeBody.max_completion_tokens = 16;
        probeBody.reasoning_effort = 'minimal';
      } else {
        probeBody.max_tokens = 1;
      }
      const res = await fetch(chatUrl(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': this.apiKey,
        },
        body: JSON.stringify(probeBody),
        signal: AbortSignal.timeout(8000),
      });
      return {
        ok: res.ok,
        latencyMs: Date.now() - start,
        error: res.ok ? undefined : `HTTP ${res.status}`,
      };
    } catch (e) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
}
