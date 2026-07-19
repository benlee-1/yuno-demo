import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { getOrder, insertEvent, updateOrderPayment } from "@/lib/db";

export const runtime = "nodejs";

/**
 * Yuno webhook receiver.
 *
 * Body: { type, type_event, account_id, version: "2", retry, data }.
 * De-dupe key: data.idempotency_key (insertEvent is INSERT OR IGNORE).
 * Signature (optional, dashboard HMAC checkbox): header `x-hmac-signature`
 * = base64(HMAC-SHA256(RAW body, YUNO_WEBHOOK_SECRET)) — verify on the RAW
 * body BEFORE JSON.parse.
 *
 * Yuno retries up to 7x on non-200, so this handler never 500s: malformed
 * payloads are logged as parse_error rows and acknowledged with 200.
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
  // timingSafeEqual throws on unequal lengths — guard first.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export async function POST(req: Request) {
  try {
    // Raw body FIRST — the HMAC covers the exact bytes on the wire.
    const rawBody = await req.text();

    // 1 = verified, 0 = HMAC mismatch, null = not checked (sandbox pragmatism
    // when no secret is configured or the header is absent).
    const secret = process.env.YUNO_WEBHOOK_SECRET;
    const signatureHeader = req.headers.get("x-hmac-signature");
    let signatureValid: number | null = null;
    if (secret && signatureHeader) {
      signatureValid = verifySignature(rawBody, signatureHeader, secret)
        ? 1
        : 0;
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
      // Malformed body: record it, ack with 200 so Yuno doesn't retry 7x.
      insertEvent({
        idempotency_key: null,
        type: "invalid",
        type_event: "parse_error",
        payment_id: null,
        merchant_order_id: null,
        status: null,
        raw: rawBody,
        signature_valid: signatureValid,
      });
      console.warn("[webhook] non-JSON payload recorded as parse_error");
      return NextResponse.json({ received: true, parse_error: true });
    }

    const data = (
      payload.data && typeof payload.data === "object" ? payload.data : {}
    ) as Record<string, unknown>;

    const event = {
      idempotency_key: asString(data.idempotency_key),
      type: asString(payload.type),
      type_event: asString(payload.type_event),
      payment_id: asString(data.id),
      merchant_order_id: asString(data.merchant_order_id),
      status: asString(data.status) ?? asString(data.sub_status),
      raw: rawBody,
      signature_valid: signatureValid,
    };
    insertEvent(event);
    console.log(
      `[webhook] ${event.type ?? "?"}.${event.type_event ?? "?"} order=${event.merchant_order_id ?? "-"} sig=${signatureValid ?? "unchecked"}`,
    );

    // Only act on payloads that didn't fail verification.
    if (signatureValid !== 0 && event.merchant_order_id && event.payment_id) {
      const order = getOrder(event.merchant_order_id);
      if (order) {
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
    console.error("[webhook] unexpected error:", err);
    return NextResponse.json({ received: true, error: "logged" });
  }
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    hint: "Yuno webhook endpoint. Configure this URL in the Yuno dashboard (Developers → Webhooks); notifications arrive via POST.",
  });
}
