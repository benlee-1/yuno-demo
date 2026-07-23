import { NextResponse } from "next/server";
import { listWorkspaceEvents } from "@/lib/db";
import { requireWorkspaceFeature } from "@/lib/workspaces";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Webhook inspector feed: the workspace's endpoint path + its events
 * (newest-100, `sinceId` for incremental polling). Token-gated — the raw
 * webhook payloads are tenant-private.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    token?: string;
    sinceId?: number;
  };

  const gate = requireWorkspaceFeature(body.token, "webhooks");
  if (!gate.ok) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.status, headers: NO_STORE },
    );
  }
  const { workspace } = gate;

  const events = listWorkspaceEvents(
    workspace.id,
    Number(body.sinceId) || 0,
  ).map((e) => {
    let raw: unknown = e.raw;
    try {
      raw = e.raw ? JSON.parse(e.raw) : null;
    } catch {
      // keep the raw string for parse_error rows
    }
    return {
      id: e.id,
      type: e.type,
      type_event: e.type_event,
      payment_id: e.payment_id,
      merchant_order_id: e.merchant_order_id,
      status: e.status,
      signature_valid: e.signature_valid,
      received_at: e.received_at,
      raw,
    };
  });

  return NextResponse.json(
    {
      endpointPath: `/api/webhooks/yuno/${workspace.id}`,
      hmacConfigured: Boolean(workspace.webhook_secret),
      events,
    },
    { headers: NO_STORE },
  );
}
