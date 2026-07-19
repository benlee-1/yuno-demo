import "server-only";
import {
  createYunoAgentToolkit,
  type YunoAgentToolkit,
} from "@yuno-payments/agent-toolkit/ai-sdk";
import { PERMISSIONS } from "@/lib/agent/permissions";

export class AgentConfigError extends Error {
  constructor(missing: string[]) {
    super(
      `Missing environment variables: ${missing.join(", ")} — fill .env.local to enable the Ops Agent.`,
    );
    this.name = "AgentConfigError";
  }
}

/** Throws AgentConfigError listing every missing env var (lazy, request-time). */
export function assertAgentEnv(): void {
  const required = [
    "YUNO_ACCOUNT_CODE",
    "YUNO_PUBLIC_API_KEY",
    "YUNO_PRIVATE_SECRET_KEY",
  ];
  const missing = required.filter((name) => !process.env[name]);
  // LLM provider: OpenRouter preferred, direct Anthropic as fallback.
  if (!process.env.OPENROUTER_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    missing.push("OPENROUTER_API_KEY (recommended) or ANTHROPIC_API_KEY");
  }
  if (missing.length > 0) throw new AgentConfigError(missing);
}

/**
 * Build the Yuno agent toolkit with the explicit permission policy from
 * `lib/agent/permissions.ts`. Connects to Yuno's MCP backend at call
 * time; caller MUST `await toolkit.close()` when the request finishes.
 */
export async function buildYunoToolkit(): Promise<YunoAgentToolkit> {
  assertAgentEnv();
  return createYunoAgentToolkit({
    accountCode: process.env.YUNO_ACCOUNT_CODE!,
    publicApiKey: process.env.YUNO_PUBLIC_API_KEY!,
    privateSecretKey: process.env.YUNO_PRIVATE_SECRET_KEY!,
    actions: PERMISSIONS,
    context: { sandbox: true },
  });
}
