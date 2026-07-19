# CONTEXT.md — Phase 0 recon findings (2026-07-18) + live-pass results (2026-07-19)

Findings from Yuno docs recon (llms.txt-indexed pages) + npm registry. Items marked ⏳ are unverified; ✅ marks what the 2026-07-19 live sandbox pass confirmed.

## Live-pass results (2026-07-19, credentials in .env.local)

- ✅ Customer + checkout session creation works with `customer_id` (UUID from POST /v1/customers) — the docs discrepancy is resolved in favor of the reference schema.
- ✅ Enabled methods on this account: CARD, iDEAL, Klarna, 7Eleven, Apple Pay, Clearpay, Google Pay. **No PIX** → cards-only demo.
- ✅ Seed script: DIRECT payments work; Maria/João SUCCEEDED, Ana DECLINED.
- ⚠️ **Routing discovery: testing-gateway "decline" cards do NOT decline here.** The account routes to real provider sandboxes with failover — observed ADYEN:Refused → STRIPE:card_declined → CHECKOUT:Authorized on card `...0028`, and NMI in the mix. Checkout.com's sandbox approves any Luhn-valid card at any amount we tried (incl. cent-ending triggers). **Deterministic decline recipe: expired expiry `11/20`** — refused by every provider (seed uses it for Ana).
- ✅ Agent verified live end-to-end via OpenRouter (`x-agent-model: openrouter/anthropic/claude-sonnet-5`): local `searchOrders` → MCP `paymentRetrieve` (remote MCP auth + IP binding fine from this machine) → `paymentCancelOrRefund` halted at `tool-approval-request` with no execution. ai@7 tool round-trip with the toolkit works.
- ✅ Browser SDK checkout round-trip verified via Playwright e2e (`npm run e2e`): mount → secure-iframe card fill → OTT → `/v1/payments` → result page "Payment approved"/SUCCEEDED. Two bugs found+fixed in the process: StrictMode remount deadlock after client-side navigation (`startedRef` reset in effect cleanup) and missing `customer_payer.id` on OTT payments (Yuno 400 `INVALID_CUSTOMER_FOR_TOKEN` without it — REQUIRED for SDK_CHECKOUT). Checkout form REQUIRES document type + valid CPF (test value 529.982.247-25) and email. Selector map for the SDK iframes lives in `e2e/checkout.spec.ts`.
- ⚠️ **No deterministic decline exists through the browser checkout**: SDK client-validates expiry (expired cards never submit — and `startPayment()` resolves silently when blocked, hence the `tokenizedRef` re-enable in checkout/page.tsx), and Luhn-valid "decline" cards are approved by failover routing. Declines are demo'd via Ana's seeded DIRECT-workflow order instead.
- Still ⏳: webhook delivery from Yuno (needs public URL + dashboard config), post-refund status string, 3DS card numbers, vaulted-token/subscription path.

## API fundamentals

- Sandbox base: `https://api-sandbox.y.uno`. Auth = TWO separate headers on every backend call: `public-api-key` + `private-secret-key` (not Bearer/Basic). Frontend SDK gets only the public key.
- **Amounts are decimal major units** (BRL 89.00 → `89`, "multiple of 0.0001"), NOT cents. The quickstart's `"value": "2500"` example contradicts the reference schema — trust the reference.
- `X-Idempotency-Key` header supported/required on POST /v1/payments, refunds, subscriptions. We always send a UUID.
- Docs discrepancy: create-checkout-session reference wants `customer_id` (UUID from POST /v1/customers); quickstart shows `customer_payer: {id: "arbitrary"}`. We implement per reference (create customer first — we need real customers for the agent demo anyway). ⏳ verify live.

## Payment loop

- Session: `POST /v1/checkout/sessions` {merchant_order_id, payment_description, country, account_id, amount{currency,value}, customer_id} → `checkout_session`.
- SDK (`@yuno-payments/sdk-web@7.11.0`): `Yuno.initialize(publicKey)` → `startCheckout({checkoutSession, elementSelector, countryCode, yunoCreatePayment(oneTimeToken), yunoPaymentResult, yunoError, ...})` → `mountCheckout()` → `startPayment()`. OTT → our backend → `POST /v1/payments` {account_id, merchant_order_id, description, country, amount, checkout:{session}, payment_method:{token}, workflow: "SDK_CHECKOUT"} → if `sdk_action_required: true` → `yuno.continuePayment({showPaymentStatus: true})` (3DS / APM / redirect branch).
- Enabled methods: `GET /v1/checkout/sessions/{s}/payment-methods`. ⏳ Confirm CARD (and whether PIX is enabled) on the Montmare account.
- PIX sandbox behavior is UNdocumented in the pages fetched. Working assumption: async APM → sdk_action_required → continuePayment renders QR. If PIX absent/flaky: demo cards-only (still BR/BRL). ⏳

## Test data (Yuno Testing Gateway — differs from generic 4111... numbers)

Expiry `11/28`, CVV `123`, holder `John Doe`:
| Card | Outcome |
|---|---|
| 4507990000000002 | SUCCEEDED |
| 4507990000000010 | INSUFFICIENT_FUNDS |
| 4507990000000028 | DECLINED_BY_BANK |
| 4507990000000036 | DO_NOT_HONOR |

3DS: separate card set (see docs.y.uno 3ds-configuration-and-testing); challenge OTPs `1234`/`1111`/`2222`/`3333`/`4444`. ⏳ pull exact 3DS numbers + verify in sandbox.

## Webhooks

- Configured in dashboard (Developers → Webhooks): URL + event selection; HMAC optional via checkbox (secret → env `YUNO_WEBHOOK_SECRET`).
- Delivery: must return 200 fast; 7 attempts total (5min → 96h backoff). De-dupe on `data.idempotency_key`; `retry` field = attempt count.
- Body: `{type, type_event, account_id, version: "2", retry, data}`; events `payment.purchase`, `payment.refund`, `payment.chargeback`, `subscription.*`, etc.
- Signature: header `x-hmac-signature` = base64(HMAC-SHA256(raw body, dashboard secret)); timing-safe compare on RAW body before JSON.parse. Header only present when HMAC enabled.

## Ops endpoints (agent surface)

- Refund/cancel: `POST /payments/{id}/cancel-or-refund` auto-decides (not captured → cancel; captured → refund). Only `reason` required (`REQUESTED_BY_CUSTOMER`|`DUPLICATE`|`FRAUDULENT`|`REVERSE`); omit amount = full refund. 201 → transaction object.
- `GET /payments?merchant_order_id=...` returns an ARRAY; `GET /payments/{id}` returns `{payment: {...}}`.
- Statuses: refundable = SUCCEEDED/captured; cancelable = authorized-not-captured. Full enum in payment-status doc.
- Customers: only `merchant_customer_id` required; 201 → UUID `id`.
- Payment links: `POST /payment-links` {account_id, country, amount, payment_method_types[]} → `checkout_url` (checkout.sandbox.y.uno).
- **Subscriptions require `vaulted_token`** (enrolled card) — cannot create from nothing. Demo treats subscription-create as stretch; card_save during checkout may vault a token. ⏳

## Agent toolkit / MCP

- `@yuno-payments/agent-toolkit@0.1.2` (pinned; pre-1.0, ESM-only, only 4 versions ever published). Import `@yuno-payments/agent-toolkit/ai-sdk`.
- `createYunoAgentToolkit({accountCode, publicApiKey, privateSecretKey, actions})` → `toolkit.getTools()` (AI SDK v5-style tool map) → `await toolkit.close()`. Action filter = nested `{category: {action: true}}`; `ALL_TOOLS_ENABLED` exists — we deliberately do NOT use it (least privilege).
- Peer `ai >=5.0.0` (dev-built v6; we run v7 — ⏳ watch tool-call round-trip). `@ai-sdk/anthropic@4.0.16` + zod 4 compatible with everything. Anthropic swap from docs' `openai("gpt-4o")` is caller-side only.
- Remote MCP `https://mcp.prod.y.uno/mcp` (headers public-api-key/private-secret-key/account-code): **sessions IP-bound, 15 req/min, 30-min idle cap**.
- **CORRECTION (found in installed package source, Phase 3): the toolkit IS an MCP client wrapper** — `createYunoAgentToolkit` connects to `mcp.prod.y.uno` at creation, lists tools, and every tool call is a remote MCP call. So IP-binding + 15 req/min apply to our agent too. Implications: (a) we create+close the toolkit per chat request (fresh session each time → IP binding is per-session, less fragile than feared, but a stable-egress deploy host still preferred); (b) demo pacing should stay under ~15 tool calls/min; (c) `context: {sandbox: true}` is passed (sends `x-sandbox: true`). ⏳ live connectivity test still pending creds.
- Confirmation gate: implemented with AI SDK v7 native `toolApproval` (server-enforced: core only runs `execute` after an `approved: true` response round-trips; denial → `output-denied` part). Destructive list + fail-closed regex (`refund|cancel|pause|unenroll|delete`) so unknown destructive tools get gated by default.
- `docs.y.uno/setup-mcp` is a *different* MCP (docs search for IDEs) — don't confuse.
- Provider swap (2026-07): ops-agent model now resolved per request in `lib/agent/model.ts` — OpenRouter via `@openrouter/ai-sdk-provider@3.0.0` when `OPENROUTER_API_KEY` set (default `anthropic/claude-sonnet-5`, verified newest Sonnet on the public OpenRouter model list), direct `@ai-sdk/anthropic` (`claude-sonnet-5`) as fallback; `AGENT_MODEL` overrides either.

## Deploy decision

Vercel serverless breaks SQLite (webhook write-lambda ≠ /events read-lambda). Decision: deploy `next start` on a persistent host (Railway/Fly). Demo-day fallback: local + cloudflared tunnel for the webhook URL.
