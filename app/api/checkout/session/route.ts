import { NextResponse } from "next/server";
import {
  createCustomer,
  createCheckoutSession,
  getAccountId,
  YunoApiError,
  YunoConfigError,
} from "@/lib/yuno";
import { createOrder } from "@/lib/db";

export const runtime = "nodejs";

const PRODUCT = "Montmare Reserva 250g";
const AMOUNT = { currency: "BRL", value: 89 }; // decimal major units, NOT cents
const COUNTRY = "BR";

function randomAlphanum(len: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "customer"
  );
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      name?: string;
      email?: string;
    };
    const name = (body.name || "Maria Silva").trim();
    const email = body.email?.trim() || undefined;

    const [firstName, ...rest] = name.split(/\s+/);
    const lastName = rest.join(" ") || "Demo";

    const merchantOrderId = `montmare-${randomAlphanum(6)}`;
    const accountId = getAccountId();

    const customer = await createCustomer({
      merchant_customer_id: `${slugify(name)}-${randomAlphanum(6)}`,
      first_name: firstName,
      last_name: lastName,
      email,
      country: COUNTRY,
    });

    const session = await createCheckoutSession({
      merchant_order_id: merchantOrderId,
      payment_description: PRODUCT,
      country: COUNTRY,
      amount: AMOUNT,
      customer_id: customer.id,
      account_id: accountId,
    });

    createOrder({
      merchant_order_id: merchantOrderId,
      customer_name: name,
      customer_id: customer.id,
      product: PRODUCT,
      amount: AMOUNT.value,
      currency: AMOUNT.currency,
      status: "CREATED",
      checkout_session: session.checkout_session,
    });

    return NextResponse.json({
      checkoutSession: session.checkout_session,
      merchantOrderId,
      amount: AMOUNT,
      country: COUNTRY,
    });
  } catch (err) {
    if (err instanceof YunoConfigError) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
    if (err instanceof YunoApiError) {
      console.error(
        `[checkout/session] Yuno API error ${err.status}:`,
        JSON.stringify(err.body),
      );
      return NextResponse.json(
        { error: `Yuno API error (${err.status})`, details: err.body },
        { status: 502 },
      );
    }
    console.error("[checkout/session] unexpected error:", err);
    return NextResponse.json(
      { error: "Failed to create checkout session" },
      { status: 500 },
    );
  }
}
