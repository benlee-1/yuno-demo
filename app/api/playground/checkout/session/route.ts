import { NextResponse } from "next/server";
import {
  createCustomer,
  createCheckoutSession,
  YunoApiError,
} from "@/lib/yuno";
import { createOrder } from "@/lib/db";
import {
  CHECKOUT_SCENARIOS,
  requireWorkspaceFeature,
  workspaceCredentials,
  type CheckoutScenario,
} from "@/lib/workspaces";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

// Sandbox guardrail: keep configurable amounts inside a sane band.
const MAX_AMOUNT = 100_000;

function randomAlphanum(len: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string;
      scenario?: string;
      country?: string;
      currency?: string;
      amount?: number;
      name?: string;
      email?: string;
    };

    const gate = requireWorkspaceFeature(body.token, "checkout");
    if (!gate.ok) {
      return NextResponse.json(
        { error: gate.error },
        { status: gate.status, headers: NO_STORE },
      );
    }
    const { workspace } = gate;

    const scenario = (body.scenario ?? "purchase") as CheckoutScenario;
    if (!CHECKOUT_SCENARIOS.includes(scenario)) {
      return NextResponse.json(
        { error: `scenario must be one of: ${CHECKOUT_SCENARIOS.join(", ")}` },
        { status: 400, headers: NO_STORE },
      );
    }

    const country = (body.country ?? workspace.default_country).toUpperCase();
    const currency = (body.currency ?? workspace.default_currency).toUpperCase();
    if (!/^[A-Z]{2}$/.test(country) || !/^[A-Z]{3}$/.test(currency)) {
      return NextResponse.json(
        { error: "country must be 2 letters, currency 3 letters" },
        { status: 400, headers: NO_STORE },
      );
    }
    // Decimal MAJOR units (BRL 89.00 -> 89), never cents.
    const amount = Math.round((Number(body.amount) || 10) * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
      return NextResponse.json(
        { error: `amount must be between 0.01 and ${MAX_AMOUNT} (major units)` },
        { status: 400, headers: NO_STORE },
      );
    }

    const name = (body.name || "Playground Tester").trim().slice(0, 80);
    const rawEmail = body.email?.trim();
    const email =
      rawEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)
        ? rawEmail
        : undefined;
    const [firstName, ...rest] = name.split(/\s+/);
    const lastName = rest.join(" ") || "Tester";

    const creds = workspaceCredentials(workspace);
    const merchantOrderId = `pg-${workspace.id}-${randomAlphanum(6)}`;
    const product = `Playground — ${scenario}`;

    const customer = await createCustomer(
      {
        merchant_customer_id: `pg-${randomAlphanum(10)}`,
        first_name: firstName,
        last_name: lastName,
        email,
        country,
      },
      creds,
    );

    const session = await createCheckoutSession(
      {
        merchant_order_id: merchantOrderId,
        payment_description: product,
        country,
        amount: { currency, value: amount },
        customer_id: customer.id,
        account_id: creds.accountId,
      },
      creds,
    );

    createOrder({
      merchant_order_id: merchantOrderId,
      customer_name: name,
      customer_id: customer.id,
      product,
      amount,
      currency,
      status: "CREATED",
      checkout_session: session.checkout_session,
      workspace_id: workspace.id,
      scenario,
      country,
    });

    return NextResponse.json(
      {
        checkoutSession: session.checkout_session,
        merchantOrderId,
        // The PUBLIC key only — by design browser-safe; the private key
        // never leaves the server.
        publicApiKey: workspace.public_api_key,
        country,
        currency,
        amount,
        scenario,
      },
      { headers: NO_STORE },
    );
  } catch (err) {
    if (err instanceof YunoApiError) {
      console.error(
        `[playground/session] Yuno API error ${err.status}:`,
        JSON.stringify(err.body),
      );
      return NextResponse.json(
        { error: `Yuno API error (${err.status})`, details: err.body },
        { status: 502, headers: NO_STORE },
      );
    }
    console.error("[playground/session] unexpected error:", err);
    return NextResponse.json(
      { error: "Failed to create checkout session" },
      { status: 500, headers: NO_STORE },
    );
  }
}
