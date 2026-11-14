import { createGoogle } from '@ai-sdk/google';
import { isStepCount, ToolLoopAgent, type ToolSet } from 'ai';
import type { AppConfig } from './config.js';
import type { ToolCallTracker } from './tools.js';

export interface StepTokenUsage {
  step: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface AgentRunResult {
  text: string;
  stepsCount: number;
  toolCallCounts: Record<string, number>;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  stepUsages: StepTokenUsage[];
}

export const SYSTEM_INSTRUCTIONS = [
  'Read CONVENTIONS.md and CLAUDE.md first.',
  'Copy the nearest existing example.',
  'Smallest possible change.',
  'Never hand-edit generated files, run typegen via runCheck.',
  'Run checks yourself before finishing.',
  'End with a brief summary of files changed and why.',
].join('\n');

export const SYSTEM_INSTRUCTIONS_BLIND = [
  'Read CONVENTIONS.md and CLAUDE.md first.',
  'Copy the nearest existing example.',
  'Smallest possible change.',
  'Never hand-edit generated files, run typegen via runCheck.',
  'End with a brief summary of files changed and why.',
].join('\n');

async function runWithRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;
      const anyErr = err as {
        status?: number;
        statusCode?: number;
        cause?: { status?: number };
        data?: { error?: { code?: number } };
        message?: string;
      };

      const status =
        anyErr?.status ??
        anyErr?.statusCode ??
        anyErr?.cause?.status ??
        anyErr?.data?.error?.code;
      const message = String(anyErr?.message ?? '');

      const isTransient =
        status === 429 ||
        status === 503 ||
        message.includes('429') ||
        message.includes('503') ||
        message.includes('RESOURCE_EXHAUSTED') ||
        message.includes('UNAVAILABLE') ||
        message.includes('rate limit') ||
        message.includes('quota') ||
        message.includes('Quota exceeded') ||
        message.includes('high demand');

      if (isTransient && attempt < maxAttempts) {
        let delayMs = Math.pow(2, attempt) * 1000 + Math.random() * 500;
        const retryMatch = message.match(/retry in\s+([0-9.]+)\s*s/i);
        if (retryMatch && retryMatch[1]) {
          const sec = parseFloat(retryMatch[1]);
          if (!isNaN(sec)) {
            delayMs = Math.max(delayMs, Math.ceil(sec * 1000) + 2000);
          }
        } else if (
          status === 429 ||
          message.includes('429') ||
          message.includes('RESOURCE_EXHAUSTED') ||
          message.includes('quota') ||
          message.includes('Quota')
        ) {
          delayMs = Math.max(delayMs, 60_000 + Math.random() * 2000);
        }

        console.warn(
          `[agent] Transient API error (${status ?? 'rate limit'}). Waiting ${Math.round(delayMs / 1000)}s before retrying (attempt ${attempt}/${maxAttempts})...`,
        );
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

export async function runAgent(
  userPrompt: string,
  tools: ToolSet,
  config: AppConfig,
  tracker: ToolCallTracker,
  signal?: AbortSignal,
  instructions: string = SYSTEM_INSTRUCTIONS,
): Promise<AgentRunResult> {
  const google = createGoogle({
    apiKey: config.googleApiKey,
  });

  const stepUsages: StepTokenUsage[] = [];

  const result = await runWithRetry(async () => {
    stepUsages.length = 0;
    const agent = new ToolLoopAgent({
      model: google(config.geminiModel),
      instructions,
      tools,
      stopWhen: isStepCount(config.maxAgentSteps),
      onStepFinish: async (step) => {
        const stepNum = (step.stepNumber ?? 0) + 1;
        const inputTokens = step.usage?.inputTokens ?? 0;
        const outputTokens = step.usage?.outputTokens ?? 0;
        const totalTokens = step.usage?.totalTokens ?? 0;
        console.log(
          `[agent:step] Step ${stepNum}: inputTokens=${inputTokens}, outputTokens=${outputTokens}`,
        );
        stepUsages.push({
          step: stepNum,
          inputTokens,
          outputTokens,
          totalTokens,
        });

        // Pace requests when context is large to stay safely within the 250k TPM free tier limit
        if (inputTokens > 15_000) {
          const pauseMs = inputTokens > 22_000 ? 5_000 : 3_000;
          await new Promise((r) => setTimeout(r, pauseMs));
        }
      },
    });

    return agent.generate({
      prompt: userPrompt,
      abortSignal: signal,
    });
  }, 3);

  if (stepUsages.length === 0 && result.steps && result.steps.length > 0) {
    for (const [idx, step] of result.steps.entries()) {
      const stepNum =
        step.stepNumber !== undefined ? step.stepNumber + 1 : idx + 1;
      const inputTokens = step.usage?.inputTokens ?? 0;
      const outputTokens = step.usage?.outputTokens ?? 0;
      const totalTokens = step.usage?.totalTokens ?? 0;
      stepUsages.push({
        step: stepNum,
        inputTokens,
        outputTokens,
        totalTokens,
      });
    }
  }

  const usage = {
    promptTokens: result.usage?.inputTokens ?? 0,
    completionTokens: result.usage?.outputTokens ?? 0,
    totalTokens: result.usage?.totalTokens ?? 0,
  };

  return {
    text: result.text,
    stepsCount: result.steps?.length ?? 0,
    toolCallCounts: { ...tracker.counts },
    usage,
    stepUsages,
  };
}
