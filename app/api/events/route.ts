import { NextResponse } from "next/server";
import { listEvents, listEventsSince, type EventRow } from "@/lib/db";

export const runtime = "nodejs";

function toSummary(row: EventRow) {
  let raw: unknown = null;
  try {
    raw = row.raw ? JSON.parse(row.raw) : null;
  } catch {
    raw = row.raw; // non-JSON payloads (parse_error rows) come back verbatim
  }
  return {
    id: row.id,
    type: row.type,
    type_event: row.type_event,
    payment_id: row.payment_id,
    merchant_order_id: row.merchant_order_id,
    status: row.status,
    signature_valid: row.signature_valid,
    received_at: row.received_at,
    raw,
  };
}

// Newest first, capped at 100. `?since=<id>` returns only rows with id > since
// for cheap polling from the /events page.
export async function GET(req: Request) {
  try {
    const sinceParam = new URL(req.url).searchParams.get("since");
    const since = sinceParam === null ? NaN : Number.parseInt(sinceParam, 10);
    const rows = Number.isFinite(since)
      ? listEventsSince(since, 100)
      : listEvents(100);
    return NextResponse.json({ events: rows.map(toSummary) });
  } catch (err) {
    console.error("[events] unexpected error:", err);
    return NextResponse.json(
      { error: "Failed to list events" },
      { status: 500 },
    );
  }
}
