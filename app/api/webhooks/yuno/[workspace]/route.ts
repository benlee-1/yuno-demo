import { NextResponse } from "next/server";
import crypto from "node:crypto";
import {
  getOrder,
  getWorkspace,
  insertEvent,
  updateOrderPayment,
} from "@/lib/db";

export const runtime = "nodejs";

/**
 * Per-workspace Yuno webhook receiver — the URL the merchant pastes into
 * their dashboard (Developers → Webhooks) is /api/webhooks/yuno/<workspaceId>.
 *
 * Same payload handling as the demo receiver (raw body first, HMAC over exact
 * bytes, dedupe on data.idempotency_key, never 500s — Yuno retries 7x), with
 * two differences:
 *  - STRICTER auth: when the workspace has a webhook secret, a valid
 *    x-hmac-signature is REQUIRED — a missing header fails (the demo route
 *    treats each env-configured check as optional-when-header-absent).
 *  - Events are tagged with the workspace id; order-state updates only touch
 *    orders of the SAME workspace.
 */

function verifySignature(
  rawBody: string,
  header: string,
  secret: string,
): boolean {
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");
  const a = Buffer.from(header, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ workspace: string }> },
) {
  try {
    const { workspace: workspaceId } = await params;
    const ws = getWorkspace(workspaceId);
    if (!ws) {
      return NextResponse.json(
        { error: "Unknown webhook endpoint" },
        { status: 404 },
      );
    }
    // Revoked/expired workspaces still record deliveries — payments made
    // while active can produce webhooks later; the feed is tenant-private.

    const rawBody = await req.text();

    let signatureValid: number | null = null;
    if (ws.webhook_secret) {
      const header = req.headers.get("x-hmac-signature");
      signatureValid =
        header && verifySignature(rawBody, header, ws.webhook_secret) ? 1 : 0;
    }

    let payload: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(rawBody);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      payload = null;
    }

    if (!payload) {
      insertEvent({
        idempotency_key: null,
        type: "invalid",
        type_event: "parse_error",
        payment_id: null,
        merchant_order_id: null,
        status: null,
        raw: rawBody,
        signature_valid: signatureValid,
        workspace_id: ws.id,
      });
      console.warn(`[webhook:${ws.id}] non-JSON payload recorded`);
      return NextResponse.json({ received: true, parse_error: true });
    }

    const data = (
      payload.data && typeof payload.data === "object" ? payload.data : {}
    ) as Record<string, unknown>;
    const entity = ((typeof data.payment === "object" && data.payment) ||
      (typeof data.subscription === "object" && data.subscription) ||
      data) as Record<string, unknown>;

    const event = {
      idempotency_key:
        asString(entity.idempotency_key) ?? asString(data.idempotency_key),
      type: asString(payload.type),
      type_event: asString(payload.type_event),
      payment_id: asString(entity.id),
      merchant_order_id: asString(entity.merchant_order_id),
      status: asString(entity.status) ?? asString(entity.sub_status),
      raw: rawBody,
      signature_valid: signatureValid,
      workspace_id: ws.id,
    };
    insertEvent(event);
    console.log(
      `[webhook:${ws.id}] ${event.type ?? "?"}.${event.type_event ?? "?"} order=${event.merchant_order_id ?? "-"} sig=${signatureValid ?? "unchecked"}`,
    );

    // Only act on verified (or unchecked) payloads, and only inside this tenant.
    if (signatureValid !== 0 && event.merchant_order_id && event.payment_id) {
      const order = getOrder(event.merchant_order_id);
      if (order && order.workspace_id === ws.id) {
        updateOrderPayment(event.merchant_order_id, {
          payment_id: event.payment_id,
          status: event.status ?? order.status ?? "UNKNOWN",
        });
      }
    }

    if (signatureValid === 0) {
      return NextResponse.json(
        { received: false, error: "invalid signature" },
        { status: 401 },
      );
    }
    return NextResponse.json({ received: true });
  } catch (err) {
    // Never 500 — Yuno retries on non-200 and we don't want 7 replays.
    console.error("[webhook:workspace] unexpected error:", err);
    return NextResponse.json({ received: true, error: "logged" });
  }
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    hint: "Per-workspace Yuno webhook endpoint. Configure this URL in the Yuno dashboard (Developers → Webhooks); notifications arrive via POST.",
  });
}
