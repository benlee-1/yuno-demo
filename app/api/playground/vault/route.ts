import { NextResponse } from "next/server";
import {
  createCustomer,
  createCheckoutSession,
  createPayment,
  extractTransactions,
  getPayment,
  YunoApiError,
} from "@/lib/yuno";
import {
  createOrder,
  getOrder,
  setOrderVaultedToken,
  updateOrderPayment,
} from "@/lib/db";
import {
  paymentCapReached,
  requireWorkspaceFeature,
  workspaceCredentials,
} from "@/lib/workspaces";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Vault & subscriptions, multiplexed on `op`:
 * - session: customer + checkout session for a card VERIFICATION.
 *   The session carries a nominal amount (1) so the SDK renders; the payment
 *   goes out with detail.card.verify=true — a $0 auth, no charge.
 * - verify:  OTT -> payment {verify:true, vault_on_success:true,
 *   stored_credentials {CARD_ON_FILE, FIRST}} (shapes confirmed in card-lite).
 * - token:   one poll tick for payment_method.vaulted_token (it can take up
 *   to ~80s to appear) — the client polls this.
 * - mit:     MIT renewal on the vaulted token, workflow DIRECT, auth-only
 *   {SUBSCRIPTION, USED} — capture happens in Post-payment ops. The vaulted
 *   token and customer id are read from OUR order + a live payment fetch,
 *   never from the client.
 */

// Verify payments MUST be exactly zero — Yuno 400s otherwise
// ("Invalid amount for verify payment. [amount must be zero]"), and the
// payment amount must match the session amount, so both are 0.
const VERIFY_AMOUNT = 0;
const MAX_MIT_AMOUNT = 100_000;

function randomAlphanum(len: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

type VaultBody = {
  token?: string;
  op?: string;
  name?: string;
  email?: string;
  oneTimeToken?: string;
  merchantOrderId?: string;
  amount?: number;
};

/** Order lookup that enforces tenant + scenario. */
function ownedVerifyOrder(workspaceId: string, merchantOrderId: unknown) {
  if (typeof merchantOrderId !== "string" || !merchantOrderId) return undefined;
  const order = getOrder(merchantOrderId);
  if (!order || order.workspace_id !== workspaceId) return undefined;
  return order;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as VaultBody;

    const gate = requireWorkspaceFeature(body.token, "vault");
    if (!gate.ok) {
      return NextResponse.json(
        { error: gate.error },
        { status: gate.status, headers: NO_STORE },
      );
    }
    const { workspace } = gate;
    const creds = workspaceCredentials(workspace);
    const country = workspace.default_country;
    const currency = workspace.default_currency;

    if (body.op === "session") {
      const name = (body.name || "Vault Tester").trim().slice(0, 80);
      const [firstName, ...rest] = name.split(/\s+/);
      const merchantOrderId = `pg-${workspace.id}-vf-${randomAlphanum(6)}`;

      const customer = await createCustomer(
        {
          merchant_customer_id: `pg-vault-${randomAlphanum(10)}`,
          first_name: firstName,
          last_name: rest.join(" ") || "Tester",
          email:
            body.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())
              ? body.email.trim()
              : undefined,
          country,
        },
        creds,
      );
      const session = await createCheckoutSession(
        {
          merchant_order_id: merchantOrderId,
          payment_description: "Playground — verify & vault",
          country,
          amount: { currency, value: VERIFY_AMOUNT },
          customer_id: customer.id,
          account_id: creds.accountId,
        },
        creds,
      );
      createOrder({
        merchant_order_id: merchantOrderId,
        customer_name: name,
        customer_id: customer.id,
        product: "Playground — verify & vault",
        amount: 0, // what the tester is charged — verification, not a sale
        currency,
        status: "CREATED",
        checkout_session: session.checkout_session,
        workspace_id: workspace.id,
        scenario: "verify",
        country,
      });
      return NextResponse.json(
        {
          checkoutSession: session.checkout_session,
          merchantOrderId,
          publicApiKey: workspace.public_api_key,
          country,
          currency,
        },
        { headers: NO_STORE },
      );
    }

    if (body.op === "verify") {
      const order = ownedVerifyOrder(workspace.id, body.merchantOrderId);
      if (!order || !order.checkout_session) {
        return NextResponse.json(
          { error: "Order not found" },
          { status: 404, headers: NO_STORE },
        );
      }
      if (!body.oneTimeToken) {
        return NextResponse.json(
          { error: "oneTimeToken is required" },
          { status: 400, headers: NO_STORE },
        );
      }
      if (paymentCapReached(workspace.id)) {
        return NextResponse.json(
          { error: "This workspace reached its payment cap." },
          { status: 429, headers: NO_STORE },
        );
      }

      const payment = await createPayment(
        {
          account_id: creds.accountId,
          merchant_order_id: order.merchant_order_id,
          description: "Playground — verify & vault",
          country: order.country ?? country,
          amount: { currency: order.currency ?? currency, value: VERIFY_AMOUNT },
          checkout: { session: order.checkout_session },
          customer_payer: order.customer_id ? { id: order.customer_id } : undefined,
          payment_method: {
            token: body.oneTimeToken,
            vault_on_success: true,
            detail: {
              card: {
                verify: true,
                stored_credentials: { reason: "CARD_ON_FILE", usage: "FIRST" },
              },
            },
          },
          workflow: "SDK_CHECKOUT",
        },
        crypto.randomUUID(),
        creds,
      );
      updateOrderPayment(order.merchant_order_id, {
        payment_id: payment.id,
        status: payment.status,
      });
      const pm = payment.payment_method as
        | { vaulted_token?: string }
        | undefined;
      if (pm?.vaulted_token) {
        // The create RESPONSE often has the token before the GET read model
        // does (~80s lag) — persist it now so MIT never races the lag.
        setOrderVaultedToken(order.merchant_order_id, pm.vaulted_token);
      }
      return NextResponse.json(
        {
          id: payment.id,
          status: payment.status,
          sub_status: payment.sub_status ?? null,
          sdk_action_required: Boolean(
            payment.checkout?.sdk_action_required ?? payment.sdk_action_required,
          ),
          vaultedToken: pm?.vaulted_token ?? null,
        },
        { headers: NO_STORE },
      );
    }

    if (body.op === "token") {
      const order = ownedVerifyOrder(workspace.id, body.merchantOrderId);
      if (!order || !order.payment_id) {
        return NextResponse.json(
          { error: "Order not found" },
          { status: 404, headers: NO_STORE },
        );
      }
      const payment = await getPayment(order.payment_id, creds);
      const pm = payment.payment_method as
        | { vaulted_token?: string }
        | undefined;
      if (pm?.vaulted_token) {
        setOrderVaultedToken(order.merchant_order_id, pm.vaulted_token);
      }
      return NextResponse.json(
        {
          status: payment.status,
          sub_status: payment.sub_status ?? null,
          vaultedToken: pm?.vaulted_token ?? order.vaulted_token ?? null,
        },
        { headers: NO_STORE },
      );
    }

    if (body.op === "mit") {
      const order = ownedVerifyOrder(workspace.id, body.merchantOrderId);
      if (!order || !order.payment_id || !order.customer_id) {
        return NextResponse.json(
          { error: "Order not found" },
          { status: 404, headers: NO_STORE },
        );
      }
      const amount = Math.round((Number(body.amount) || 0) * 100) / 100;
      if (!(amount > 0) || amount > MAX_MIT_AMOUNT) {
        return NextResponse.json(
          { error: `amount must be between 0.01 and ${MAX_MIT_AMOUNT}` },
          { status: 400, headers: NO_STORE },
        );
      }
      if (paymentCapReached(workspace.id)) {
        return NextResponse.json(
          { error: "This workspace reached its payment cap." },
          { status: 429, headers: NO_STORE },
        );
      }

      // Vaulted token from OUR stored order (persisted off the verify
      // response) or a live re-fetch — never from the client.
      let vaultedToken = order.vaulted_token;
      if (!vaultedToken) {
        const verification = await getPayment(order.payment_id, creds);
        const pm = verification.payment_method as
          | { vaulted_token?: string }
          | undefined;
        vaultedToken = pm?.vaulted_token ?? null;
        if (vaultedToken) {
          setOrderVaultedToken(order.merchant_order_id, vaultedToken);
        }
      }
      if (!vaultedToken) {
        return NextResponse.json(
          { error: "No vaulted token on this verification yet — wait for it." },
          { status: 409, headers: NO_STORE },
        );
      }

      const mitOrderId = `pg-${workspace.id}-mit-${randomAlphanum(6)}`;
      const payment = await createPayment(
        {
          account_id: creds.accountId,
          merchant_order_id: mitOrderId,
          description: "Playground — MIT renewal",
          country: order.country ?? country,
          amount: { currency: order.currency ?? currency, value: amount },
          customer_payer: { id: order.customer_id },
          payment_method: {
            type: "CARD",
            vaulted_token: vaultedToken,
            detail: {
              card: {
                capture: false,
                stored_credentials: { reason: "SUBSCRIPTION", usage: "USED" },
              },
            },
          },
          workflow: "DIRECT",
        },
        crypto.randomUUID(),
        creds,
      );
      createOrder({
        merchant_order_id: mitOrderId,
        customer_name: order.customer_name ?? "Vault Tester",
        customer_id: order.customer_id,
        product: "Playground — MIT renewal",
        amount,
        currency: order.currency ?? currency,
        status: "CREATED",
        checkout_session: "",
        workspace_id: workspace.id,
        scenario: "mit",
        country: order.country ?? country,
      });
      updateOrderPayment(mitOrderId, {
        payment_id: payment.id,
        status: payment.status,
      });
      return NextResponse.json(
        {
          id: payment.id,
          merchantOrderId: mitOrderId,
          status: payment.status,
          sub_status: payment.sub_status ?? null,
          transactionId: extractTransactions(payment)[0]?.id ?? null,
        },
        { headers: NO_STORE },
      );
    }

    return NextResponse.json(
      { error: "op must be one of: session, verify, token, mit" },
      { status: 400, headers: NO_STORE },
    );
  } catch (err) {
    if (err instanceof YunoApiError) {
      console.error(
        `[playground/vault] Yuno API error ${err.status}:`,
        JSON.stringify(err.body),
      );
      return NextResponse.json(
        { error: `Yuno API error (${err.status})`, details: err.body },
        { status: 502, headers: NO_STORE },
      );
    }
    console.error("[playground/vault] unexpected error:", err);
    return NextResponse.json(
      { error: "Operation failed" },
      { status: 500, headers: NO_STORE },
    );
  }
}
