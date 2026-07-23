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
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      company_name TEXT,
      account_id TEXT,
      public_api_key TEXT,
      private_secret_key_enc TEXT,
      webhook_secret TEXT,
      default_country TEXT,
      default_currency TEXT,
      features TEXT,
      label TEXT,
      created_at TEXT,
      expires_at TEXT,
      revoked INTEGER DEFAULT 0
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
  if (!eventCols.some((c) => c.name === "workspace_id")) {
    db.exec(`ALTER TABLE events ADD COLUMN workspace_id TEXT`);
  }
  const orderCols = db
    .prepare(`PRAGMA table_info(orders)`)
    .all() as Array<{ name: string }>;
  if (!orderCols.some((c) => c.name === "workspace_id")) {
    db.exec(`ALTER TABLE orders ADD COLUMN workspace_id TEXT`);
  }
  if (!orderCols.some((c) => c.name === "scenario")) {
    db.exec(`ALTER TABLE orders ADD COLUMN scenario TEXT`);
  }
  if (!orderCols.some((c) => c.name === "country")) {
    db.exec(`ALTER TABLE orders ADD COLUMN country TEXT`);
  }
  if (!orderCols.some((c) => c.name === "vaulted_token")) {
    db.exec(`ALTER TABLE orders ADD COLUMN vaulted_token TEXT`);
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
  /** Playground workspace that owns this order; null = built-in demo store. */
  workspace_id: string | null;
  /** Playground scenario slug (purchase | auth_only | decline | 3ds); null = demo store. */
  scenario: string | null;
  /** 2-letter country the session was created for; null = demo store (BR). */
  country: string | null;
  /**
   * Card token vaulted by a verify payment. Persisted the moment any Yuno
   * response reveals it — the GET read model can lag ~80s behind (playground
   * MIT renewals read this instead of re-fetching).
   */
  vaulted_token: string | null;
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
  /** Playground workspace the event belongs to; null = built-in demo store. */
  workspace_id: string | null;
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
  workspace_id?: string | null;
  scenario?: string | null;
  country?: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO orders
        (merchant_order_id, customer_name, customer_id, product, amount, currency, payment_id, status, checkout_session, created_at, workspace_id, scenario, country)
       VALUES (@merchant_order_id, @customer_name, @customer_id, @product, @amount, @currency, NULL, @status, @checkout_session, @created_at, @workspace_id, @scenario, @country)`,
    )
    .run({
      workspace_id: null,
      scenario: null,
      country: null,
      ...order,
      created_at: new Date().toISOString(),
    });
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

/**
 * Case-insensitive search over customer_name / merchant_order_id (Ops Agent).
 * Demo-store rows only — playground workspace orders are a different tenant
 * and must not leak into the coffee-store agent's world.
 */
export function searchOrders(query: string, limit = 20): OrderRow[] {
  const like = `%${query}%`;
  return getDb()
    .prepare(
      `SELECT * FROM orders
       WHERE workspace_id IS NULL
         AND (customer_name LIKE ? COLLATE NOCASE
          OR merchant_order_id LIKE ? COLLATE NOCASE)
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(like, like, limit) as OrderRow[];
}

/** Newest demo-store orders first (Ops Agent). */
export function listRecentOrders(limit = 10): OrderRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM orders WHERE workspace_id IS NULL
       ORDER BY created_at DESC LIMIT ?`,
    )
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
       FROM orders WHERE workspace_id IS NULL AND created_at LIKE ?
       GROUP BY status ORDER BY count DESC`,
    )
    .all(`${day}%`) as OrderStatusAgg[];
}

/** Demo-store orders created on one calendar day (`YYYY-MM-DD`), newest first. */
export function listOrdersForDay(day: string, limit = 20): OrderRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM orders WHERE workspace_id IS NULL AND created_at LIKE ?
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
  workspace_id?: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO events
        (idempotency_key, type, type_event, payment_id, merchant_order_id, status, raw, received_at, signature_valid, workspace_id)
       VALUES (@idempotency_key, @type, @type_event, @payment_id, @merchant_order_id, @status, @raw, @received_at, @signature_valid, @workspace_id)`,
    )
    .run({
      signature_valid: null,
      workspace_id: null,
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

// ---------------------------------------------------------------------------
// Playground workspaces (BYO sandbox credentials)
// ---------------------------------------------------------------------------

export interface WorkspaceRow {
  id: string;
  company_name: string;
  account_id: string;
  /** Public API key — safe for the browser SDK, still never logged. */
  public_api_key: string;
  /** AES-256-GCM blob (lib/crypto.ts). NEVER return this from an API route. */
  private_secret_key_enc: string;
  webhook_secret: string | null;
  default_country: string;
  default_currency: string;
  /** JSON array of feature slugs, e.g. ["checkout","vault","ops","webhooks"]. */
  features: string;
  label: string | null;
  created_at: string;
  expires_at: string;
  revoked: number;
}

export function createWorkspace(
  ws: Omit<WorkspaceRow, "created_at" | "revoked">,
): void {
  getDb()
    .prepare(
      `INSERT INTO workspaces
        (id, company_name, account_id, public_api_key, private_secret_key_enc,
         webhook_secret, default_country, default_currency, features, label,
         created_at, expires_at, revoked)
       VALUES (@id, @company_name, @account_id, @public_api_key, @private_secret_key_enc,
         @webhook_secret, @default_country, @default_currency, @features, @label,
         @created_at, @expires_at, 0)`,
    )
    .run({ ...ws, created_at: new Date().toISOString() });
}

export function getWorkspace(id: string): WorkspaceRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM workspaces WHERE id = ?`)
    .get(id) as WorkspaceRow | undefined;
}

export function listWorkspaces(): WorkspaceRow[] {
  return getDb()
    .prepare(`SELECT * FROM workspaces ORDER BY created_at DESC`)
    .all() as WorkspaceRow[];
}

/** Orders belonging to one playground workspace, newest first. */
export function listWorkspaceOrders(
  workspace_id: string,
  limit = 50,
): OrderRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM orders WHERE workspace_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(workspace_id, limit) as OrderRow[];
}

export function setOrderVaultedToken(
  merchant_order_id: string,
  vaulted_token: string,
): void {
  getDb()
    .prepare(`UPDATE orders SET vaulted_token = ? WHERE merchant_order_id = ?`)
    .run(vaulted_token, merchant_order_id);
}

/** Tenant-scoped lookup: the order that owns a payment id, or undefined. */
export function getWorkspaceOrderByPayment(
  workspace_id: string,
  payment_id: string,
): OrderRow | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM orders WHERE workspace_id = ? AND payment_id = ? LIMIT 1`,
    )
    .get(workspace_id, payment_id) as OrderRow | undefined;
}

/** Anti-card-testing cap input: payments actually attempted in a workspace. */
export function countWorkspacePayments(workspace_id: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS count FROM orders
       WHERE workspace_id = ? AND payment_id IS NOT NULL`,
    )
    .get(workspace_id) as { count: number };
  return row.count;
}

export function setWorkspaceRevoked(id: string, revoked: boolean): boolean {
  const res = getDb()
    .prepare(`UPDATE workspaces SET revoked = ? WHERE id = ?`)
    .run(revoked ? 1 : 0, id);
  return res.changes > 0;
}

/** Demo-store feed — playground workspace events are a different tenant. */
export function listEvents(limit = 100): EventRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM events WHERE workspace_id IS NULL
       ORDER BY id DESC LIMIT ?`,
    )
    .all(limit) as EventRow[];
}

export function listEventsSince(sinceId: number, limit = 100): EventRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM events WHERE workspace_id IS NULL AND id > ?
       ORDER BY id DESC LIMIT ?`,
    )
    .all(sinceId, limit) as EventRow[];
}

/** One workspace's webhook feed, newest first; sinceId=0 returns the latest page. */
export function listWorkspaceEvents(
  workspace_id: string,
  sinceId = 0,
  limit = 100,
): EventRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM events WHERE workspace_id = ? AND id > ?
       ORDER BY id DESC LIMIT ?`,
    )
    .all(workspace_id, sinceId, limit) as EventRow[];
}
