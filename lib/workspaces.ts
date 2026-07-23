import "server-only";
import { NextResponse } from "next/server";
import {
  createCustomer,
  createCheckoutSession,
  YunoApiError,
  type YunoCredentials,
} from "@/lib/yuno";
import {
  decryptSecret,
  signWorkspaceToken,
  timingSafeEqualStr,
  verifyWorkspaceToken,
} from "@/lib/crypto";
import {
  countWorkspacePayments,
  getWorkspace,
  getWorkspaceOrderByPayment,
  type OrderRow,
  type WorkspaceRow,
} from "@/lib/db";
import { randomBytes } from "node:crypto";

/**
 * Playground workspaces: a company's SANDBOX credentials + config, created by
 * an admin, reached through an HMAC-signed expiring link (/w/<token>).
 *
 * Security invariants:
 * - Private keys exist in plaintext only inside a request that needs them
 *   (decrypted on demand, never returned by any API route, never logged).
 * - Admin routes fail CLOSED: no ADMIN_CODE env -> everything 503s.
 * - Sandbox only: yunoFetch pins workspace calls to api-sandbox.y.uno.
 */

export const WORKSPACE_FEATURES = [
  "checkout",
  "vault",
  "ops",
  "webhooks",
] as const;
export type WorkspaceFeature = (typeof WORKSPACE_FEATURES)[number];

export const FEATURE_LABELS: Record<WorkspaceFeature, string> = {
  checkout: "Checkout scenarios",
  vault: "Vault & subscriptions",
  ops: "Post-payment ops",
  webhooks: "Webhook inspector",
};

/**
 * Checkout scenarios. API-wise only `auth_only` changes the payment body
 * (capture: false); `decline` and `3ds` steer the tester to the right test
 * cards — the outcome depends on the workspace account's provider routing.
 */
export const CHECKOUT_SCENARIOS = [
  "purchase",
  "auth_only",
  "decline",
  "3ds",
] as const;
export type CheckoutScenario = (typeof CHECKOUT_SCENARIOS)[number];

// ---------------------------------------------------------------------------
// Admin gate
// ---------------------------------------------------------------------------

/** Sliding-window throttle for admin-code attempts (in-memory, per process). */
const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 20;
const WINDOW_MS = 10 * 60 * 1000;

export type AdminAuthResult = "ok" | "unauthorized" | "disabled" | "throttled";

/**
 * Checks the x-admin-code header against ADMIN_CODE. Fails closed when the
 * env var is unset. Throttles by client IP so the code can't be brute-forced.
 */
export function checkAdminAuth(req: Request): AdminAuthResult {
  const expected = process.env.ADMIN_CODE;
  if (!expected) return "disabled";

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const now = Date.now();
  const entry = attempts.get(ip);
  if (entry && entry.resetAt > now && entry.count >= MAX_ATTEMPTS) {
    return "throttled";
  }

  const given = req.headers.get("x-admin-code") ?? "";
  if (given && timingSafeEqualStr(given, expected)) {
    attempts.delete(ip);
    return "ok";
  }

  if (!entry || entry.resetAt <= now) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    entry.count += 1;
  }
  return "unauthorized";
}

/**
 * Route-handler guard: 503 disabled / 429 throttled / 401 wrong code.
 * Returns null when authorized.
 */
export function adminGate(req: Request): NextResponse | null {
  const auth = checkAdminAuth(req);
  if (auth === "ok") return null;
  const map = {
    disabled: {
      status: 503,
      error: "Admin is disabled — set ADMIN_CODE on the server.",
    },
    throttled: { status: 429, error: "Too many attempts — try again later." },
    unauthorized: { status: 401, error: "Invalid admin code." },
  } as const;
  const { status, error } = map[auth];
  return NextResponse.json(
    { error },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

// ---------------------------------------------------------------------------
// Credential validation (live, against the Yuno sandbox)
// ---------------------------------------------------------------------------

export type CredentialValidation =
  | { ok: true }
  | {
      ok: false;
      /** Which call failed: keys (customer) vs account id (session). */
      step: "customer" | "checkout_session";
      status: number | null;
      message: string;
    };

function randomSuffix(): string {
  return randomBytes(4).toString("hex");
}

/**
 * Proves the credentials work end-to-end: customer create exercises the key
 * pair, checkout-session create exercises the account id. Both are harmless
 * sandbox writes (same objects every real checkout run creates).
 * Never include credential values in the returned message.
 */
export async function validateSandboxCredentials(
  creds: YunoCredentials,
  { country, currency }: { country: string; currency: string },
): Promise<CredentialValidation> {
  const suffix = randomSuffix();
  let customerId: string;
  try {
    const customer = await createCustomer(
      {
        merchant_customer_id: `playground-validation-${suffix}`,
        first_name: "Playground",
        last_name: "Validation",
        country,
      },
      creds,
    );
    customerId = customer.id;
  } catch (err) {
    return {
      ok: false,
      step: "customer",
      status: err instanceof YunoApiError ? err.status : null,
      message:
        err instanceof YunoApiError && err.status === 401
          ? "Yuno rejected the API key pair (401). Check the sandbox public/private keys."
          : "Customer creation failed — keys may be invalid or not sandbox keys.",
    };
  }

  try {
    await createCheckoutSession(
      {
        merchant_order_id: `playground-validation-${suffix}`,
        payment_description: "Playground credential validation",
        country,
        amount: { currency, value: 1 },
        customer_id: customerId,
        account_id: creds.accountId,
      },
      creds,
    );
  } catch (err) {
    return {
      ok: false,
      step: "checkout_session",
      status: err instanceof YunoApiError ? err.status : null,
      message:
        "Keys are valid but the checkout session failed — check the account id (and that country/currency are enabled for this account).",
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Token <-> workspace resolution
// ---------------------------------------------------------------------------

export function workspaceLinkToken(ws: WorkspaceRow): string {
  return signWorkspaceToken({
    w: ws.id,
    exp: Math.floor(new Date(ws.expires_at).getTime() / 1000),
  });
}

export function parseFeatures(ws: WorkspaceRow): WorkspaceFeature[] {
  try {
    const parsed = JSON.parse(ws.features);
    if (Array.isArray(parsed)) {
      return parsed.filter((f): f is WorkspaceFeature =>
        (WORKSPACE_FEATURES as readonly string[]).includes(f),
      );
    }
  } catch {
    // fall through
  }
  return [...WORKSPACE_FEATURES];
}

export type ResolvedWorkspace =
  | { ok: true; workspace: WorkspaceRow; features: WorkspaceFeature[] }
  | { ok: false; reason: "invalid" | "expired" | "revoked" };

/** Verifies a signed link token and loads a live (unexpired, unrevoked) workspace. */
export function resolveWorkspaceByToken(token: string): ResolvedWorkspace {
  const payload = verifyWorkspaceToken(token);
  if (!payload) return { ok: false, reason: "invalid" };
  const ws = getWorkspace(payload.w);
  if (!ws) return { ok: false, reason: "invalid" };
  if (ws.revoked) return { ok: false, reason: "revoked" };
  if (new Date(ws.expires_at).getTime() < Date.now()) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, workspace: ws, features: parseFeatures(ws) };
}

export type FeatureGateResult =
  | { ok: true; workspace: WorkspaceRow; features: WorkspaceFeature[] }
  | { ok: false; status: number; error: string };

/**
 * Playground-route guard: resolves the signed token from a request body and
 * requires the given feature to be enabled for the workspace.
 */
export function requireWorkspaceFeature(
  token: unknown,
  feature: WorkspaceFeature,
): FeatureGateResult {
  if (typeof token !== "string" || !token) {
    return { ok: false, status: 401, error: "Missing workspace token" };
  }
  const resolved = resolveWorkspaceByToken(token);
  if (!resolved.ok) {
    const messages = {
      invalid: "This workspace link is not valid.",
      expired: "This workspace link has expired.",
      revoked: "This workspace has been closed.",
    } as const;
    return { ok: false, status: 401, error: messages[resolved.reason] };
  }
  if (!resolved.features.includes(feature)) {
    return {
      ok: false,
      status: 403,
      error: `The "${FEATURE_LABELS[feature]}" feature is not enabled for this workspace.`,
    };
  }
  return resolved;
}

/** Lifetime attempted-payments cap (anti card-testing). */
export function paymentCapReached(workspaceId: string): boolean {
  const cap = Number(process.env.PLAYGROUND_MAX_PAYMENTS) || 200;
  return countWorkspacePayments(workspaceId) >= cap;
}

/**
 * Tenant isolation for ops actions: the payment id must belong to an order
 * created inside this workspace. Returns the order or a 404-shaped error.
 */
export function requireOwnedPayment(
  workspace: WorkspaceRow,
  paymentId: unknown,
): { ok: true; order: OrderRow } | { ok: false; status: number; error: string } {
  if (typeof paymentId !== "string" || !paymentId) {
    return { ok: false, status: 400, error: "paymentId is required" };
  }
  const order = getWorkspaceOrderByPayment(workspace.id, paymentId);
  if (!order) {
    return { ok: false, status: 404, error: "Payment not found" };
  }
  return { ok: true, order };
}

/**
 * Decrypts the workspace's private key for one request. Call inside the route
 * that needs it and let the result go out of scope — never store or return it.
 */
export function workspaceCredentials(ws: WorkspaceRow): YunoCredentials {
  return {
    accountId: ws.account_id,
    publicApiKey: ws.public_api_key,
    privateSecretKey: decryptSecret(ws.private_secret_key_enc),
  };
}
