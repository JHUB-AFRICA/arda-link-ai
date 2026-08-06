/**
 * MockClient — used when no API key is configured.
 *
 * Returns realistic-shaped responses so the dashboard renders and
 * `make verify` passes in dev. Every response is prefixed `[MOCK]`
 * so the audit trail makes it obvious we're not hitting a real LLM.
 *
 * In production, this should never be the active client. The
 * `make verify` smoke test asserts no real LLM is reachable from
 * dev by checking that all calls return `provider: 'mock'`.
 */

import type {
  LlmClient,
  LlmHealth,
  LlmRequest,
  LlmResponse,
  LlmTask,
} from '../types.js';

export class MockClient implements LlmClient {
  readonly name: string;
  readonly tasks: LlmTask[];
  private readonly model: string;

  constructor(name: string, model: string) {
    this.name = name;
    this.model = model;
    this.tasks = [
      'multilingual',
      'voice_script',
      'summarize',
      'reasoning',
      'code',
      'extract',
      'default',
    ];
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const start = Date.now();
    // Surface the last user message so the mock echoes the data the
    // dashboard will render. Useful for visual smoke tests.
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
    const echoed = lastUser?.content.slice(0, 200) ?? '(no user message)';
    // Only wrap as JSON when the caller actually asked for a schema —
    // matches every real provider's response_format contract (see
    // zai.ts/minimax.ts/azure.ts: they only force JSON when
    // req.jsonSchema is set). A plain multilingual/chat request (no
    // schema) must get plain text back, same as it would from a real
    // provider — this used to always JSON-wrap regardless of task,
    // which meant a bare `{"summary":"[MOCK ...` object was sent
    // verbatim as a WhatsApp reply the one time the real z.ai→minimax
    // fallback chain bottomed out to mock in a live conversation.
    const content = req.jsonSchema
      ? JSON.stringify({
          summary: `[MOCK ${this.name}/${this.model}] Brief: ${echoed.slice(0, 80)}...`,
          actions: [
            'Mock action 1: send a herd check',
            'Mock action 2: recruit a NE-quadrant correspondent',
            'Mock action 3: defer the satellite refresh',
          ],
        })
      : `[MOCK ${this.name}/${this.model}] ${echoed.slice(0, 200)}`;
    return {
      content,
      usage: {
        inputTokens: req.messages.reduce((acc, m) => acc + m.content.length / 4, 0) | 0,
        outputTokens: content.length / 4 | 0,
        totalTokens: 0,
      },
      provider: this.name,
      model: this.model,
      latencyMs: Date.now() - start + 1, // +1 so the dashboard can show it took some time
      cached: false,
      isMock: true,
    };
  }

  async completeJson<T>(req: LlmRequest, schema: import('zod').ZodType<T>): Promise<T> {
    const response = await this.complete({ ...req, jsonSchema: schema });
    return schema.parse(JSON.parse(response.content));
  }

  async health(): Promise<LlmHealth> {
    return { ok: true, latencyMs: 0 };
  }
}
