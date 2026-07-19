import fs from "node:fs";
import path from "node:path";
import { anthropic } from "@ai-sdk/anthropic";
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  type UIMessage,
} from "ai";
import { localTools } from "@/lib/agent/local-tools";
import { buildToolApproval } from "@/lib/agent/permissions";
import { AgentConfigError, buildYunoToolkit } from "@/lib/agent/toolkit";

// better-sqlite3 (via local tools) is a native module; agent toolkit needs Node.
export const runtime = "nodejs";
export const maxDuration = 60;

function loadSystemPrompt(): string {
  return fs.readFileSync(
    path.join(process.cwd(), "lib", "agent", "system-prompt.md"),
    "utf8",
  );
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const messages = (body as { messages?: UIMessage[] })?.messages;
  if (!Array.isArray(messages)) {
    return Response.json(
      { error: "Request body must contain a `messages` array" },
      { status: 400 },
    );
  }

  let toolkit: Awaited<ReturnType<typeof buildYunoToolkit>> | null = null;
  const closeToolkit = async () => {
    try {
      await toolkit?.close();
    } catch {
      // already closed / connection gone — nothing to do
    } finally {
      toolkit = null;
    }
  };

  try {
    toolkit = await buildYunoToolkit();
    const tools = { ...toolkit.getTools(), ...localTools };

    const result = streamText({
      model: anthropic("claude-sonnet-5"),
      system: loadSystemPrompt(),
      messages: await convertToModelMessages(messages, {
        tools,
        ignoreIncompleteToolCalls: true,
      }),
      tools,
      // Server-enforced human-in-the-loop gate for destructive Yuno tools:
      // the loop pauses on these calls until the client returns an explicit
      // approval response (Confirm button in /ops).
      toolApproval: buildToolApproval(Object.keys(toolkit.getTools())),
      stopWhen: stepCountIs(10),
      onFinish: closeToolkit,
      onAbort: closeToolkit,
      onError: async ({ error }) => {
        console.error("[ops-agent] stream error:", error);
        await closeToolkit();
      },
    });

    return result.toUIMessageStreamResponse();
  } catch (error) {
    await closeToolkit();
    if (error instanceof AgentConfigError) {
      return Response.json({ error: error.message }, { status: 500 });
    }
    console.error("[ops-agent] request failed:", error);
    const message =
      error instanceof Error ? error.message : "Ops Agent request failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
