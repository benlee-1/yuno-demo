import "server-only";

/**
 * Yuno sandbox REST client (server-only).
 *
 * - Auth: every request carries the `public-api-key` + `private-secret-key`
 *   header pair. Keys are read lazily at request time (no env needed at build).
 * - NEVER log headers or key values.
 * - Amounts are DECIMAL major units (BRL 89.00 -> value: 89), NOT cents.
 * - BYO-credentials (playground workspaces): pass `creds` explicitly. Workspace
 *   calls are pinned to the sandbox base URL and never fall back to env keys —
 *   a partial creds object throws instead of mixing tenants.
 */

const BASE_URL = () => process.env.YUNO_API_URL ?? "https://api-sandbox.y.uno";
const SANDBOX_URL = "https://api-sandbox.y.uno";

/** Per-workspace credentials. All three fields required — no env fallback. */
export interface YunoCredentials {
  accountId: string;
  publicApiKey: string;
  privateSecretKey: string;
}

export class YunoConfigError extends Error {
  constructor() {
    super("Missing Yuno credentials — fill .env.local");
    this.name = "YunoConfigError";
  }
}

export class YunoApiError extends Error {
  status: number;
  body: unknown;
  constructor(path: string, status: number, body: unknown) {
    super(`Yuno API ${path} failed with status ${status}`);
    this.name = "YunoApiError";
    this.status = status;
    this.body = body;
  }
}

export function getAccountId(): string {
  const account = process.env.YUNO_ACCOUNT_CODE;
  if (!account) throw new YunoConfigError();
  return account;
}

type YunoFetchOptions = {
  method?: "GET" | "POST";
  body?: unknown;
  idempotencyKey?: string;
  /** Workspace credentials — omit for the built-in demo account (env). */
  creds?: YunoCredentials;
};

export async function yunoFetch<T = unknown>(
  path: string,
  { method = "GET", body, idempotencyKey, creds }: YunoFetchOptions = {},
): Promise<T> {
  const publicKey = creds ? creds.publicApiKey : process.env.YUNO_PUBLIC_API_KEY;
  const privateKey = creds
    ? creds.privateSecretKey
    : process.env.YUNO_PRIVATE_SECRET_KEY;
  if (!publicKey || !privateKey) throw new YunoConfigError();

  const headers: Record<string, string> = {
    "public-api-key": publicKey,
    "private-secret-key": privateKey,
    "Content-Type": "application/json",
  };
  if (idempotencyKey) headers["X-Idempotency-Key"] = idempotencyKey;

  // Workspace calls are sandbox-only regardless of YUNO_API_URL.
  const res = await fetch(`${creds ? SANDBOX_URL : BASE_URL()}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });

  // Log path/status only — never headers or keys.
  console.log(`[yuno] ${method} ${path} -> ${res.status}`);

  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }

  if (!res.ok) {
    throw new YunoApiError(path, res.status, json);
  }
  return json as T;
}

// ---------------------------------------------------------------------------
// Typed wrappers
// ---------------------------------------------------------------------------

export interface YunoCustomer {
  id: string;
  merchant_customer_id: string;
  [key: string]: unknown;
}

export function createCustomer(
  args: {
    merchant_customer_id: string;
    first_name: string;
    last_name: string;
    email?: string;
    country: string;
  },
  creds?: YunoCredentials,
): Promise<YunoCustomer> {
  return yunoFetch<YunoCustomer>("/v1/customers", {
    method: "POST",
    body: args,
    creds,
  });
}

export interface CheckoutSessionResponse {
  checkout_session: string;
  [key: string]: unknown;
}

export function createCheckoutSession(
  args: {
    merchant_order_id: string;
    payment_description: string;
    country: string;
    amount: { currency: string; value: number };
    customer_id: string;
    account_id: string;
  },
  creds?: YunoCredentials,
): Promise<CheckoutSessionResponse> {
  return yunoFetch<CheckoutSessionResponse>("/v1/checkout/sessions", {
    method: "POST",
    body: args,
    creds,
  });
}

export function getSessionPaymentMethods(
  session: string,
  creds?: YunoCredentials,
): Promise<unknown> {
  return yunoFetch(`/v1/checkout/sessions/${session}/payment-methods`, {
    creds,
  });
}

export interface YunoPayment {
  id: string;
  status: string;
  sub_status?: string;
  merchant_order_id?: string;
  checkout?: { sdk_action_required?: boolean; [key: string]: unknown };
  sdk_action_required?: boolean;
  [key: string]: unknown;
}

export function createPayment(
  body: Record<string, unknown>,
  idempotencyKey: string,
  creds?: YunoCredentials,
): Promise<YunoPayment> {
  return yunoFetch<YunoPayment>("/v1/payments", {
    method: "POST",
    body,
    idempotencyKey,
    creds,
  });
}

export interface YunoTransaction {
  id: string;
  type?: string;
  status?: string;
  [key: string]: unknown;
}

/**
 * Transactions arrive as an array, a single object, or under `transaction`
 * depending on workflow — normalize to an array (confirmed in card-lite).
 */
export function extractTransactions(payment: YunoPayment): YunoTransaction[] {
  const t = payment.transactions ?? payment.transaction;
  if (Array.isArray(t)) return t as YunoTransaction[];
  if (t && typeof t === "object") return [t as YunoTransaction];
  return [];
}

/**
 * Capture an authorized transaction. Per Yuno OpenAPI: merchant_reference,
 * reason and amount are ALL required; partial captures are provider-dependent.
 */
export function capturePayment(
  paymentId: string,
  transactionId: string,
  amount: { currency: string; value: number },
  idempotencyKey: string,
  creds?: YunoCredentials,
): Promise<YunoPayment> {
  return yunoFetch<YunoPayment>(
    `/v1/payments/${encodeURIComponent(paymentId)}/transactions/${encodeURIComponent(transactionId)}/capture`,
    {
      method: "POST",
      body: {
        merchant_reference: `pg-cap-${idempotencyKey.slice(0, 8)}`,
        reason: "PRODUCT_CONFIRMED",
        amount,
      },
      idempotencyKey,
      creds,
    },
  );
}

/** Refund a transaction — amount present = partial, omitted = full. */
export function refundPayment(
  paymentId: string,
  transactionId: string,
  amount: { currency: string; value: number } | undefined,
  idempotencyKey: string,
  creds?: YunoCredentials,
): Promise<YunoPayment> {
  return yunoFetch<YunoPayment>(
    `/v1/payments/${encodeURIComponent(paymentId)}/transactions/${encodeURIComponent(transactionId)}/refund`,
    {
      method: "POST",
      body: {
        merchant_reference: `pg-ref-${idempotencyKey.slice(0, 8)}`,
        reason: "REQUESTED_BY_CUSTOMER",
        description: "Playground refund",
        ...(amount ? { amount } : {}),
      },
      idempotencyKey,
      creds,
    },
  );
}

/** Void/cancel: cancels if NOT captured, refunds if captured. */
export function cancelOrRefundPayment(
  paymentId: string,
  transactionId: string,
  idempotencyKey: string,
  creds?: YunoCredentials,
): Promise<YunoPayment> {
  return yunoFetch<YunoPayment>(
    `/v1/payments/${encodeURIComponent(paymentId)}/transactions/${encodeURIComponent(transactionId)}/cancel-or-refund`,
    {
      method: "POST",
      body: {
        merchant_reference: `pg-void-${idempotencyKey.slice(0, 8)}`,
        reason: "REQUESTED_BY_CUSTOMER",
        description: "Playground void/cancel",
      },
      idempotencyKey,
      creds,
    },
  );
}

export async function getPayment(
  id: string,
  creds?: YunoCredentials,
): Promise<YunoPayment> {
  const res = await yunoFetch<Record<string, unknown>>(`/v1/payments/${id}`, {
    creds,
  });
  // Docs show the response wrapped as { payment: {...} } — tolerate both shapes.
  if (res && typeof res === "object" && "payment" in res && res.payment) {
    return res.payment as YunoPayment;
  }
  return res as unknown as YunoPayment;
}
