import "server-only";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/**
 * SQLite store (better-sqlite3, synchronous native module).
 * Any route importing this must set `export const runtime = "nodejs"`.
 */

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "demo.db");

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      merchant_order_id TEXT PRIMARY KEY,
      customer_name TEXT,
      customer_id TEXT,
      product TEXT,
      amount REAL,
      currency TEXT,
      payment_id TEXT,
      status TEXT,
      checkout_session TEXT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotency_key TEXT UNIQUE,
      type TEXT,
      type_event TEXT,
      payment_id TEXT,
      merchant_order_id TEXT,
      status TEXT,
      raw TEXT,
      received_at TEXT
    );
    CREATE TABLE IF NOT EXISTS agent_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT,
      step_number INTEGER,
      part_type TEXT,
      tool_name TEXT,
      tool_call_id TEXT,
      gated INTEGER,
      approved INTEGER,
      payload TEXT,
      model TEXT,
      finish_reason TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      created_at TEXT
    );
  `);
  // Migration-safe additive column (Phase 2): older DBs may predate it.
  const eventCols = db
    .prepare(`PRAGMA table_info(events)`)
    .all() as Array<{ name: string }>;
  if (!eventCols.some((c) => c.name === "signature_valid")) {
    db.exec(`ALTER TABLE events ADD COLUMN signature_valid INTEGER`);
  }
  return db;
}

export interface OrderRow {
  merchant_order_id: string;
  customer_name: string | null;
  customer_id: string | null;
  product: string | null;
  amount: number | null;
  currency: string | null;
  payment_id: string | null;
  status: string | null;
  checkout_session: string | null;
  created_at: string | null;
}

export interface EventRow {
  id: number;
  idempotency_key: string | null;
  type: string | null;
  type_event: string | null;
  payment_id: string | null;
  merchant_order_id: string | null;
  status: string | null;
  raw: string | null;
  received_at: string | null;
  /** 1 = HMAC verified, 0 = HMAC failed, null = not checked (no secret/header). */
  signature_valid: number | null;
}

export function createOrder(order: {
  merchant_order_id: string;
  customer_name: string;
  customer_id: string;
  product: string;
  amount: number;
  currency: string;
  status: string;
  checkout_session: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO orders
        (merchant_order_id, customer_name, customer_id, product, amount, currency, payment_id, status, checkout_session, created_at)
       VALUES (@merchant_order_id, @customer_name, @customer_id, @product, @amount, @currency, NULL, @status, @checkout_session, @created_at)`,
    )
    .run({ ...order, created_at: new Date().toISOString() });
}

export function updateOrderPayment(
  merchant_order_id: string,
  { payment_id, status }: { payment_id: string; status: string },
): void {
  getDb()
    .prepare(
      `UPDATE orders SET payment_id = ?, status = ? WHERE merchant_order_id = ?`,
    )
    .run(payment_id, status, merchant_order_id);
}

export function getOrder(merchant_order_id: string): OrderRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM orders WHERE merchant_order_id = ?`)
    .get(merchant_order_id) as OrderRow | undefined;
}

export function listOrders(): OrderRow[] {
  return getDb()
    .prepare(`SELECT * FROM orders ORDER BY created_at DESC`)
    .all() as OrderRow[];
}

/** Case-insensitive search over customer_name / merchant_order_id (Ops Agent). */
export function searchOrders(query: string, limit = 20): OrderRow[] {
  const like = `%${query}%`;
  return getDb()
    .prepare(
      `SELECT * FROM orders
       WHERE customer_name LIKE ? COLLATE NOCASE
          OR merchant_order_id LIKE ? COLLATE NOCASE
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(like, like, limit) as OrderRow[];
}

/** Newest orders first (Ops Agent). */
export function listRecentOrders(limit = 10): OrderRow[] {
  return getDb()
    .prepare(`SELECT * FROM orders ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as OrderRow[];
}

export interface OrderStatusAgg {
  status: string | null;
  count: number;
  /** Sum of order amounts (decimal major units, e.g. BRL). */
  volume: number;
}

/**
 * Read-only aggregate for the paymentsBriefing tool: order count + volume
 * grouped by status for one calendar day. `day` is a `YYYY-MM-DD` string;
 * created_at is stored as ISO text, so the filter is a prefix match.
 */
export function aggregateOrdersByStatusForDay(day: string): OrderStatusAgg[] {
  return getDb()
    .prepare(
      `SELECT status, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS volume
       FROM orders WHERE created_at LIKE ?
       GROUP BY status ORDER BY count DESC`,
    )
    .all(`${day}%`) as OrderStatusAgg[];
}

/** Orders created on one calendar day (`YYYY-MM-DD`), newest first. */
export function listOrdersForDay(day: string, limit = 20): OrderRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM orders WHERE created_at LIKE ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(`${day}%`, limit) as OrderRow[];
}

/** Count of refund webhook events received on one calendar day. */
export function countRefundEventsForDay(day: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS count FROM events
       WHERE received_at LIKE ? AND type_event LIKE '%refund%'`,
    )
    .get(`${day}%`) as { count: number };
  return row.count;
}

export function insertEvent(event: {
  idempotency_key: string | null;
  type: string | null;
  type_event: string | null;
  payment_id: string | null;
  merchant_order_id: string | null;
  status: string | null;
  raw: string;
  signature_valid?: number | null;
}): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO events
        (idempotency_key, type, type_event, payment_id, merchant_order_id, status, raw, received_at, signature_valid)
       VALUES (@idempotency_key, @type, @type_event, @payment_id, @merchant_order_id, @status, @raw, @received_at, @signature_valid)`,
    )
    .run({
      signature_valid: null,
      ...event,
      received_at: new Date().toISOString(),
    });
}

export interface AgentAuditRow {
  id: number;
  /** One UUID per /api/chat request — groups the steps of a single agent run. */
  run_id: string;
  step_number: number | null;
  /** user-message | assistant-text | tool-call | tool-result | tool-error | approval-request | approval-response */
  part_type: string;
  tool_name: string | null;
  tool_call_id: string | null;
  /** 1 = tool is on the confirmation gate (isDestructiveTool). */
  gated: number | null;
  /** approval-response only: 1 = Confirm, 0 = Deny. */
  approved: number | null;
  payload: string | null;
  model: string | null;
  finish_reason: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: string;
}

export type AgentAuditInsert = Omit<AgentAuditRow, "id" | "created_at">;

export function insertAgentAudit(rows: AgentAuditInsert[]): void {
  if (rows.length === 0) return;
  const stmt = getDb().prepare(
    `INSERT INTO agent_audit
      (run_id, step_number, part_type, tool_name, tool_call_id, gated, approved, payload, model, finish_reason, input_tokens, output_tokens, created_at)
     VALUES (@run_id, @step_number, @part_type, @tool_name, @tool_call_id, @gated, @approved, @payload, @model, @finish_reason, @input_tokens, @output_tokens, @created_at)`,
  );
  const created_at = new Date().toISOString();
  const insertAll = getDb().transaction((batch: AgentAuditInsert[]) => {
    for (const row of batch) stmt.run({ ...row, created_at });
  });
  insertAll(rows);
}

/** Dedupe check: the full chat history is resent on every request. */
export function hasAgentAuditRow(
  part_type: string,
  tool_call_id: string,
): boolean {
  return (
    getDb()
      .prepare(
        `SELECT 1 FROM agent_audit WHERE part_type = ? AND tool_call_id = ? LIMIT 1`,
      )
      .get(part_type, tool_call_id) !== undefined
  );
}

export function listAgentAudit(limit = 200): AgentAuditRow[] {
  return getDb()
    .prepare(`SELECT * FROM agent_audit ORDER BY id DESC LIMIT ?`)
    .all(limit) as AgentAuditRow[];
}

export function listEvents(limit = 100): EventRow[] {
  return getDb()
    .prepare(`SELECT * FROM events ORDER BY id DESC LIMIT ?`)
    .all(limit) as EventRow[];
}

export function listEventsSince(sinceId: number, limit = 100): EventRow[] {
  return getDb()
    .prepare(`SELECT * FROM events WHERE id > ? ORDER BY id DESC LIMIT ?`)
    .all(sinceId, limit) as EventRow[];
}
