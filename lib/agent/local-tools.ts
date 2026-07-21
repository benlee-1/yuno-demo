import "server-only";
import { tool } from "ai";
import { z } from "zod";
import {
  aggregateOrdersByStatusForDay,
  countRefundEventsForDay,
  listOrdersForDay,
  listRecentOrders,
  searchOrders,
} from "@/lib/db";

/** Today's date as `YYYY-MM-DD` in the server's local timezone. */
function todayLocalISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

type StatusBucket = "approved" | "declined" | "refunded" | "pending" | "other";

/** Map a stored order status onto a briefing bucket. */
function bucketOf(status: string | null): StatusBucket {
  const s = (status ?? "").toUpperCase();
  if (s === "SUCCEEDED" || s === "APPROVED") return "approved";
  if (s === "REFUNDED" || s === "CANCELLED" || s === "CANCELED")
    return "refunded";
  if (s === "PENDING" || s === "CREATED" || s === "IN_PROCESS")
    return "pending";
  if (/DECLINED|REJECTED|ERROR|FAILED/.test(s)) return "declined";
  return "other";
}

/**
 * Read-only local tools over the 10X Coffee SQLite order store.
 *
 * The Yuno toolkit only knows Yuno IDs — the mapping from "Maria's coffee
 * order" to a merchant_order_id / payment_id lives here.
 */
export const localTools = {
  searchOrders: tool({
    description:
      "Search 10X Coffee store orders in the local database. Case-insensitive substring match on customer name or merchant_order_id. Use this FIRST to resolve human references like a customer's name to a merchant_order_id and payment_id before calling any Yuno tool.",
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .describe(
          "Customer name or merchant_order_id fragment, e.g. 'Maria' or '10x-a1b2c3'",
        ),
    }),
    execute: async ({ query }) => searchOrders(query),
  }),

  listRecentOrders: tool({
    description:
      "List the newest 10X Coffee store orders from the local database (customer, product, amount, payment_id, status).",
    inputSchema: z.object({
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe("Maximum number of orders to return (default 10)"),
    }),
    execute: async ({ limit }) => listRecentOrders(limit),
  }),

  paymentsBriefing: tool({
    description:
      "Read-only daily payments briefing over the 10X Coffee store's local records: total orders, counts by status bucket (approved/declined/refunded/pending), decline breakdown by stored status, approved and refunded volume in BRL, refund webhook events, and the day's order list (capped at 20). Use when asked to summarize or brief on the day's payments.",
    inputSchema: z.object({
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
        .optional()
        .describe(
          "Calendar day to brief on, YYYY-MM-DD. Omit for today (server local date).",
        ),
    }),
    execute: async ({ date }) => {
      const day = date ?? todayLocalISO();
      const statusRows = aggregateOrdersByStatusForDay(day);

      const byStatus: Record<StatusBucket, number> = {
        approved: 0,
        declined: 0,
        refunded: 0,
        pending: 0,
        other: 0,
      };
      let totalOrders = 0;
      let approvedVolume = 0;
      let refundedVolume = 0;
      const declineBreakdown: Array<{ status: string | null; count: number }> =
        [];
      for (const row of statusRows) {
        totalOrders += row.count;
        const bucket = bucketOf(row.status);
        byStatus[bucket] += row.count;
        if (bucket === "approved") approvedVolume += row.volume;
        if (bucket === "refunded") refundedVolume += row.volume;
        if (bucket === "declined")
          declineBreakdown.push({ status: row.status, count: row.count });
      }

      return {
        date: day,
        source: "local demo-store records (SQLite orders + webhook events)",
        total_orders: totalOrders,
        by_status: byStatus,
        // Orders only store the payment status (sub_status is not persisted).
        decline_breakdown: declineBreakdown,
        approved_volume_brl: approvedVolume,
        refunded_volume_brl: refundedVolume,
        refund_events_received: countRefundEventsForDay(day),
        orders: listOrdersForDay(day, 20).map((o) => ({
          customer_name: o.customer_name,
          merchant_order_id: o.merchant_order_id,
          amount: o.amount,
          currency: o.currency,
          status: o.status,
        })),
      };
    },
  }),
};
