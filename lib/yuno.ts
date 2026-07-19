import "server-only";

/**
 * Yuno sandbox REST client (server-only).
 *
 * - Auth: every request carries the `public-api-key` + `private-secret-key`
 *   header pair. Keys are read lazily at request time (no env needed at build).
 * - NEVER log headers or key values.
 * - Amounts are DECIMAL major units (BRL 89.00 -> value: 89), NOT cents.
 */

const BASE_URL = () => process.env.YUNO_API_URL ?? "https://api-sandbox.y.uno";

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
};

export async function yunoFetch<T = unknown>(
  path: string,
  { method = "GET", body, idempotencyKey }: YunoFetchOptions = {},
): Promise<T> {
  const publicKey = process.env.YUNO_PUBLIC_API_KEY;
  const privateKey = process.env.YUNO_PRIVATE_SECRET_KEY;
  if (!publicKey || !privateKey) throw new YunoConfigError();

  const headers: Record<string, string> = {
    "public-api-key": publicKey,
    "private-secret-key": privateKey,
    "Content-Type": "application/json",
  };
  if (idempotencyKey) headers["X-Idempotency-Key"] = idempotencyKey;

  const res = await fetch(`${BASE_URL()}${path}`, {
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

export function createCustomer(args: {
  merchant_customer_id: string;
  first_name: string;
  last_name: string;
  email?: string;
  country: string;
}): Promise<YunoCustomer> {
  return yunoFetch<YunoCustomer>("/v1/customers", {
    method: "POST",
    body: args,
  });
}

export interface CheckoutSessionResponse {
  checkout_session: string;
  [key: string]: unknown;
}

export function createCheckoutSession(args: {
  merchant_order_id: string;
  payment_description: string;
  country: string;
  amount: { currency: string; value: number };
  customer_id: string;
  account_id: string;
}): Promise<CheckoutSessionResponse> {
  return yunoFetch<CheckoutSessionResponse>("/v1/checkout/sessions", {
    method: "POST",
    body: args,
  });
}

export function getSessionPaymentMethods(session: string): Promise<unknown> {
  return yunoFetch(`/v1/checkout/sessions/${session}/payment-methods`);
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
): Promise<YunoPayment> {
  return yunoFetch<YunoPayment>("/v1/payments", {
    method: "POST",
    body,
    idempotencyKey,
  });
}

export async function getPayment(id: string): Promise<YunoPayment> {
  const res = await yunoFetch<Record<string, unknown>>(`/v1/payments/${id}`);
  // Docs show the response wrapped as { payment: {...} } — tolerate both shapes.
  if (res && typeof res === "object" && "payment" in res && res.payment) {
    return res.payment as YunoPayment;
  }
  return res as unknown as YunoPayment;
}
