# DEMO.md — 5-minute presentation runbook

Live demo: Montmare Store on Yuno sandbox + the Payments Concierge-pattern ops
agent. Everything below is scripted with real inputs; rehearse once end-to-end
before presenting. Steps marked ⏳ have **not yet been verified against the live
sandbox** (recon was done without credentials) — rehearse those first and update
this file with what you actually see.

## Test data (memorize or keep on a card)

- Success card: `4507 9900 0000 0002` — expiry `11/28`, CVV `123`, holder `John Doe`
- Decline recipe: **same card number with expiry `11/20` (expired)** — verified live.
  The testing-gateway "decline" cards do NOT decline on this account: routing fails
  over across real provider sandboxes (Adyen/Stripe refuse, then Checkout.com
  approves any Luhn-valid card — itself a nice failover story to narrate). An
  expired card declines at every provider, so it is the deterministic path.
- Seeded customers (from `npm run seed`): **Maria Silva** (SUCCEEDED, refundable),
  **João Santos** (SUCCEEDED), **Ana Oliveira** (DECLINED on purpose — non-refundable)
- Live-buy customer name for the demo: **Carlos Mendes**

## Pre-demo checklist (T-10 minutes)

- [ ] `.env.local` filled: all Yuno sandbox keys + `OPENROUTER_API_KEY` (or
      `ANTHROPIC_API_KEY`) +
      `YUNO_WEBHOOK_SECRET`. `npm run dev` running, http://localhost:3000 loads.
- [ ] `npm run seed` — the summary table must show Maria Silva **SUCCEEDED**,
      João Santos **SUCCEEDED**, Ana Oliveira **DECLINED** (any `API_ERROR_*` row
      means creds or sandbox trouble — fix before going on). Re-running adds new
      rows; that's fine, the agent uses the newest. ✅ verified live 2026-07-19.
- [ ] Webhook URL configured in the Yuno dashboard (Developers → Webhooks →
      `<origin>/api/webhooks/yuno`, HMAC enabled, secret matches
      `YUNO_WEBHOOK_SECRET`). If presenting from localhost:
      `cloudflared tunnel --url http://localhost:3000` — **the free tunnel URL
      changes on every run**, so start the tunnel first, then re-paste the new URL
      into the dashboard. ⏳ delivery latency unverified — note what you observe.
- [ ] `/events` is in a known state (empty, or you know which rows are pre-show).
- [ ] Agent smoke test: open `/ops`, send **"Show recent orders"** — must return the
      seeded orders as a table within a few seconds. This also proves the remote MCP
      connection works from this network. ✅ verified live 2026-07-19 (OpenRouter
      Claude Sonnet 5; full refund chain incl. MCP `paymentRetrieve` and the
      approval-gate halt on `paymentCancelOrRefund` — re-verify from the venue's
      network, since MCP sessions are IP-bound).
- [ ] Backup screencast ready and tested: `<PATH-TO-SCREENCAST.mp4 — record during
      first successful rehearsal>`.
- [ ] Have `lib/agent/permissions.ts` open in an editor tab — you'll show it during
      the refund beat.

## Minute-by-minute arc

**0:00 — Buy a coffee.** Storefront → buy as **Carlos Mendes**, success card
`4507 9900 0000 0002` (11/28, 123, holder Carlos Mendes). The form also requires
**document type CPF + a valid test CPF: `529.982.247-25`** and an email — have
them ready to type. Result page shows **"Payment approved" / SUCCEEDED** badge.
Narrate: session created server-side, card form is Yuno's SDK secure element (PAN
never touches our code), one-time token → our backend → `/v1/payments`.
✅ verified live via Playwright e2e 2026-07-19 (`npm run e2e` is the pre-demo
smoke test for this exact flow).

**1:00 — Webhook, live.** Switch to `/events` — the `payment.purchase` row should
appear within moments (page polls every 3s). Point at `signature_valid = 1`: HMAC
verified over the raw body, timing-safe compare, deduped on idempotency key. ⏳

**1:30 — The decline story (narrated, not clicked).** There is **no reliable
decline through the browser checkout** on this account — verified live: the SDK
client-side-validates expiry (expired dates never leave the form, inline
"Invalid year."), and the testing-gateway "decline" cards get APPROVED by
failover routing (we watched Adyen refuse → Stripe refuse → Checkout.com
approve the same card). So tell that as the routing story — it's a better
Yuno pitch than a decline anyway — and point at **Ana Oliveira's seeded
DECLINED order** (visible in the next beat via the agent, or on `/events`):
declines exist in the data via the DIRECT-workflow seed (expired card at the
API level, refused by every provider).

**2:00 — The star: the ops agent.** Open `/ops`. Frame it in one line: *"This is the
Payments Concierge pattern — an agent that acts autonomously, but only within
configured permissions."* Send: **"Refund Maria's coffee order"**. Walk the audience
through the visible tool chain as the cards appear:

1. `searchOrders` — local read-only lookup: name → `merchant_order_id` / `payment_id`
2. `paymentRetrieveByMerchantOrderId` (or `paymentRetrieve`) — agent re-verifies
   status and amount with Yuno before acting
3. The refund call — `paymentCancelOrRefund` (the system prompt steers it there; it
   may pick `paymentRefund`; **both are gated**) — the run **pauses** on a
   confirmation card showing the payment id, amount, reason
4. While it waits: flip to `lib/agent/permissions.ts` on screen. Narrate the two
   mechanisms: explicit action allowlist (no `ALL_TOOLS_ENABLED`;
   `payments.create` deliberately absent — the agent can refund but never charge)
   and the server-enforced approval gate (execute cannot run until `approved: true`
   round-trips; unknown destructive tool names fail closed via regex). Point at the
   scopes sidebar in the UI — same allowlist, rendered.
5. Click **Confirm** → tool executes → agent re-retrieves the payment and reports
   the final status. ⏳ verify the exact post-refund status string (expected
   REFUNDED) in rehearsal and note it here.

**3:30 — Agent-initiated checkout.** Send: **"Create a payment link for R$ 150"** →
agent returns a `checkout_url` (checkout.sandbox.y.uno). Framing, one sentence: this
is the agentic-commerce buy-side pattern — an agent initiating a checkout on a
user's behalf and handing back a ready-to-pay link. Ungated: creating a link asks
for money, it doesn't move any. ⏳

**4:00 — Concierge briefing.** Send: **"Summarize today's payments"** → the local
briefing tool aggregates today's records from SQLite: count, approved vs declined,
decline reasons, total volume. Narrate: a scheduled-briefing-style answer computed
entirely from the merchant's own records — zero extra Yuno API calls, zero MCP
budget. ⏳

**4:20 — Judgment, not just obedience.** Send: **"Refund Ana's order"** → the agent
retrieves the payment, sees it's DECLINED, and explains it never succeeded so there
is nothing to refund — no gate even triggered, because it verified state before
acting. ⏳

**4:40 — Close the loop.** Back to `/events`: the `payment.refund` row from Maria's
refund has arrived. Close on the architecture one-liner: *"One Next.js app, one
SQLite file, Yuno's financial infrastructure platform underneath — and an agent
holding refund power that's scoped like a production credential: explicit
permissions, a server-enforced confirmation gate, and every tool call on screen."*

## Exact agent prompts (copy-paste)

```
Show recent orders
Refund Maria's coffee order
Create a payment link for R$ 150
Summarize today's payments
Refund Ana's order
```

## Contingency table

| Failure | Response |
|---|---|
| Sandbox down / API errors mid-demo | Switch to the backup screencast (path in checklist). Narrate over it — the talk track is identical. |
| Remote MCP rate limit (~15 req/min, sessions also 30-min idle-capped) | The refund flow alone is ~4–5 tool calls. Pace tool-heavy prompts; if the agent starts erroring on tool calls, talk through `permissions.ts` for 60 seconds and retry. Don't ad-lib extra multi-tool prompts. |
| Approval card never resolves / stream stalls | Refresh `/ops` and re-send — each request opens a fresh MCP session, so state loss is contained to the chat thread. |
| Webhook doesn't arrive on stage | `/events` still shows the seeded/pre-show state; say retries cover you (Yuno retries 7× with backoff) and move on — check again at the 4:40 beat. |
| Tunnel URL rotated (cloudflared restarted) | Re-paste the new URL in dashboard → Developers → Webhooks. This is why the checklist says tunnel first, dashboard second. |
| 3DS as an optional extra | Only if asked. 3DS uses a **separate card set** — numbers live in the Yuno "3DS configuration and testing" doc; challenge OTPs are `1234`/`1111`/`2222`/`3333`/`4444`. ⏳ pull exact card numbers after the first live run and record them here: `<3DS-CARDS-TBD>`. |
| PIX not enabled on the account | Cards-only narrative line: "Same loop handles PIX — `sdk_action_required` → `continuePayment` renders the QR — this account is card-only today." ✅ confirmed 2026-07-19: enabled methods are CARD, iDEAL, Klarna, 7Eleven, Apple Pay, Clearpay, Google Pay — no PIX. |

## Rehearsal priorities (things never yet run live)

In order: (1) `npm run seed` against real creds, (2) one full SDK checkout,
(3) webhook delivery + HMAC pass, (4) the `/ops` refund chain incl. approval
round-trip and post-refund status string, (5) payment link + briefing prompts,
(6) record the backup screencast while doing all of the above.
