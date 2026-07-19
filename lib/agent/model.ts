import "server-only";
import { anthropic } from "@ai-sdk/anthropic";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import { AgentConfigError } from "@/lib/agent/toolkit";

// Newest Claude Sonnet on OpenRouter as of 2026-07 (verified against the public
// model list at https://openrouter.ai/api/v1/models). Override via AGENT_MODEL.
const DEFAULT_OPENROUTER_MODEL = "anthropic/claude-sonnet-5";

// Default when calling Anthropic directly. Override via AGENT_MODEL.
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5";

export interface ResolvedModel {
  model: LanguageModel;
  providerLabel: "openrouter" | "anthropic";
  modelId: string;
}

/**
 * Pick the LLM provider at request time (lazy, like the rest of the env):
 * OPENROUTER_API_KEY wins, ANTHROPIC_API_KEY is the fallback. Never logs keys.
 */
export function resolveModel(): ResolvedModel {
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (openrouterKey) {
    const modelId = process.env.AGENT_MODEL || DEFAULT_OPENROUTER_MODEL;
    const openrouter = createOpenRouter({ apiKey: openrouterKey });
    return {
      model: openrouter.chat(modelId),
      providerLabel: "openrouter",
      modelId,
    };
  }

  if (process.env.ANTHROPIC_API_KEY) {
    const modelId = process.env.AGENT_MODEL || DEFAULT_ANTHROPIC_MODEL;
    return { model: anthropic(modelId), providerLabel: "anthropic", modelId };
  }

  throw new AgentConfigError([
    "OPENROUTER_API_KEY (recommended) or ANTHROPIC_API_KEY",
  ]);
}
