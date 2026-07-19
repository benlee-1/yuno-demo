/**
 * Demo seed script — creates named customers with COMPLETED sandbox payments
 * so the Ops Agent has data even in a fresh demo environment.
 *
 * Run: `npm run seed` (tsx --conditions=react-server, so the `server-only`
 * marker imports in lib/ resolve to their empty variant outside Next.js).
 *
 * Flow per customer: POST /v1/customers -> POST /v1/payments (workflow DIRECT,
 * raw Yuno test card, no checkout session) -> local orders row for
 * searchOrders(). One customer intentionally uses the DECLINED test card so
 * the demo has a non-refundable example. Sandbox only — never real cards.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  createCustomer,
  createPayment,
  getAccountId,
  YunoApiError,
} from "../lib/yuno";
import { createOrder, getOrder, updateOrderPayment } from "../lib/db";

// ---------------------------------------------------------------------------
// Env loading (.env.local) — tsx does not auto-load Next.js env files.
// ---------------------------------------------------------------------------

function loadEnvLocal(): void {
  const envPath = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function assertCredentials(): void {
  const required = [
    "YUNO_ACCOUNT_CODE",
    "YUNO_PUBLIC_API_KEY",
    "YUNO_PRIVATE_SECRET_KEY",
  ];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    console.error(
      [
        "Cannot seed: missing Yuno sandbox credentials.",
        `  Missing env vars: ${missing.join(", ")}`,
        "  Copy .env.local.example to .env.local and fill in your SANDBOX keys",
        "  (Yuno dashboard -> Developers -> API keys), then re-run `npm run seed`.",
      ].join("\n"),
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Seed data — Yuno Testing Gateway cards (expiry 11/28, CVV 123).
// CPFs are valid-format test values (checksum-correct, not real people).
// ---------------------------------------------------------------------------

const PRODUCT = "Montmare Reserva 250g";
const AMOUNT = { currency: "BRL", value: 89 };

interface SeedCustomer {
  firstName: string;
  lastName: string;
  email: string;
  cpf: string;
  cardNumber: string;
  /** Two-digit expiry year; default 28. 20 (expired) is the only reliable
   * decline on this account: routing fails over across provider sandboxes
   * (Adyen/Stripe decline the gateway's "decline" cards but Checkout.com
   * approves any Luhn-valid card), while an expired card declines everywhere. */
  expirationYear?: number;
  expectedOutcome: string;
}

const SEED_CUSTOMERS: SeedCustomer[] = [
  {
    firstName: "Maria",
    lastName: "Silva",
    email: "maria.silva@example.com",
    cpf: "34244419888",
    cardNumber: "4507990000000002",
    expectedOutcome: "SUCCEEDED",
  },
  {
    firstName: "João",
    lastName: "Santos",
    email: "joao.santos@example.com",
    cpf: "52998224725",
    cardNumber: "4507990000000002",
    expectedOutcome: "SUCCEEDED",
  },
  {
    firstName: "Ana",
    lastName: "Oliveira",
    email: "ana.oliveira@example.com",
    cpf: "16899535009",
    cardNumber: "4507990000000002",
    expirationYear: 20, // expired on purpose — deterministic decline (see type doc)
    expectedOutcome: "DECLINED (intentional — non-refundable demo example)",
  },
];

function randomAlphanum(length: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < length; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

/** Card networks want plain ASCII holder names (João -> JOAO). */
function asciiUpper(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

interface SeedResult {
  customer: string;
  merchant_order_id: string;
  payment_id: string;
  status: string;
  expected: string;
}

async function seedOne(seed: SeedCustomer): Promise<SeedResult> {
  const fullName = `${seed.firstName} ${seed.lastName}`;
  const merchantOrderId = `montmare-${randomAlphanum(6)}`;
  const result: SeedResult = {
    customer: fullName,
    merchant_order_id: merchantOrderId,
    payment_id: "-",
    status: "NOT_CREATED",
    expected: seed.expectedOutcome,
  };

  // 1. Yuno customer (unique merchant_customer_id per run — sandbox rejects reuse).
  const customer = await createCustomer({
    merchant_customer_id: `seed-${seed.email}-${randomAlphanum(6)}`,
    first_name: seed.firstName,
    last_name: seed.lastName,
    email: seed.email,
    country: "BR",
  });

  // 2. Local order row (status updated after the payment call).
  if (!getOrder(merchantOrderId)) {
    createOrder({
      merchant_order_id: merchantOrderId,
      customer_name: fullName,
      customer_id: customer.id,
      product: PRODUCT,
      amount: AMOUNT.value,
      currency: AMOUNT.currency,
      status: "PENDING",
      checkout_session: "", // DIRECT workflow — no checkout session involved.
    });
  }

  // 3. DIRECT card payment — raw test card, no SDK/session (create-payment ref:
  //    payment_method.detail.card.card_data{number, expiration_month,
  //    expiration_year, security_code, holder_name}).
  try {
    const payment = await createPayment(
      {
        account_id: getAccountId(),
        merchant_order_id: merchantOrderId,
        description: PRODUCT,
        country: "BR",
        amount: AMOUNT,
        workflow: "DIRECT",
        customer_payer: {
          id: customer.id,
          first_name: seed.firstName,
          last_name: seed.lastName,
          email: seed.email,
          document: {
            document_type: "CPF",
            document_number: seed.cpf,
          },
        },
        payment_method: {
          type: "CARD",
          detail: {
            card: {
              capture: true,
              card_data: {
                number: seed.cardNumber,
                expiration_month: 11,
                expiration_year: seed.expirationYear ?? 28,
                security_code: "123",
                holder_name: asciiUpper(fullName),
              },
            },
          },
        },
      },
      randomUUID(),
    );

    result.payment_id = payment.id;
    result.status = payment.status;
    updateOrderPayment(merchantOrderId, {
      payment_id: payment.id,
      status: payment.status,
    });
  } catch (error) {
    if (error instanceof YunoApiError) {
      result.status = `API_ERROR_${error.status}`;
      console.error(
        `Payment failed for ${fullName} (${merchantOrderId}) — HTTP ${error.status}:`,
      );
      console.error(JSON.stringify(error.body, null, 2));
      return result; // continue with the next customer
    }
    throw error;
  }

  return result;
}

async function main(): Promise<void> {
  loadEnvLocal();
  assertCredentials();

  console.log(`Seeding ${SEED_CUSTOMERS.length} demo orders (Yuno sandbox)...\n`);

  const results: SeedResult[] = [];
  for (const seed of SEED_CUSTOMERS) {
    try {
      results.push(await seedOne(seed));
    } catch (error) {
      const message =
        error instanceof YunoApiError
          ? `HTTP ${error.status}: ${JSON.stringify(error.body)}`
          : error instanceof Error
            ? error.message
            : String(error);
      console.error(
        `Seed failed for ${seed.firstName} ${seed.lastName}: ${message}`,
      );
      results.push({
        customer: `${seed.firstName} ${seed.lastName}`,
        merchant_order_id: "-",
        payment_id: "-",
        status: "SEED_FAILED",
        expected: seed.expectedOutcome,
      });
    }
  }

  console.log("\nSeed summary:");
  console.table(results);
  console.log(
    "Note: Ana Oliveira uses an expired card (11/20) on purpose so the",
  );
  console.log("demo includes a non-refundable DECLINED payment.");
}

main().catch((error) => {
  console.error("Seed aborted:", error instanceof Error ? error.message : error);
  process.exit(1);
});
