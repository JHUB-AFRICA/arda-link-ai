/**
 * Daily token budget guard.
 *
 * Tracks per-task token consumption in memory. The api runs in a
 * single process so this is fine. For multi-process deploys, swap
 * the backing store for Redis (key: `llm:budget:<task>:<UTC-date>`).
 *
 * Budget: LLM_DAILY_TOKEN_BUDGET env var, default 100_000.
 */

import { logger } from '../logger.js';
import type { LlmTask, LlmUsage } from './types.js';

const DEFAULT_BUDGET = 100_000;

export class CostGuard {
  private consumedByTask: Map<LlmTask, number> = new Map();
  private readonly budget: number;

  constructor() {
    const env = process.env.LLM_DAILY_TOKEN_BUDGET;
    this.budget = env ? parseInt(env, 10) : DEFAULT_BUDGET;
    if (Number.isFinite(this.budget) && this.budget > 0) {
      logger.info(
        { dailyBudget: this.budget },
        'LLM daily token budget set',
      );
    }
  }

  consumed(task: LlmTask): number {
    return this.consumedByTask.get(task) ?? 0;
  }

  remaining(task: LlmTask): number {
    return Math.max(0, this.budget - this.consumed(task));
  }

  exceeded(task: LlmTask): boolean {
    return this.consumed(task) >= this.budget;
  }

  consume(task: LlmTask, usage: LlmUsage): void {
    const prev = this.consumed(task);
    this.consumedByTask.set(task, prev + usage.totalTokens);
  }

  summary(): Record<LlmTask, { consumed: number; remaining: number }> {
    const out = {} as Record<LlmTask, { consumed: number; remaining: number }>;
    const tasks: LlmTask[] = [
      'multilingual',
      'voice_script',
      'summarize',
      'reasoning',
      'code',
      'extract',
      'default',
    ];
    for (const t of tasks) {
      out[t] = { consumed: this.consumed(t), remaining: this.remaining(t) };
    }
    return out;
  }
}

export const costGuard = new CostGuard();
