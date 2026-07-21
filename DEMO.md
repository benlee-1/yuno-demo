# DEMO.md — 5-minute presentation runbook

Live demo: 10X Coffee store on Yuno sandbox + the Payments Concierge-pattern ops
agent. Everything below is scripted with real inputs; rehearse once end-to-end
before presenting. Steps marked ⏳ have **not yet been verified against the live
sandbox** (recon was done without credentials) — rehearse those first and update
this file with what you actually see.

## Test data (memorize or keep on a card)

- Success card: `4507 9900 0000 0002` — expiry `11/28`, CVV `123`, holder `John Doe`
- **Do not attempt a live decline — there is no working recipe in the browser.**
  The testing-gateway "decline" cards get APPROVED on this account (routing fails
  over: Adyen refuses → Stripe refuses → Checkout.com approves any Luhn-valid card
  — narrate that, it's the better story). The one deterministic decline is an
  expired expiry `11/20`, but it works only via the API (that's what `npm run seed`
  uses for Ana); the Web SDK validates expiry client-side and blocks submission.
- Seeded customers (from `npm run seed`): **Maria Silva** (SUCCEEDED, refundable),
  **João Santos** (SUCCEEDED), **Ana Oliveira** (DECLINED on purpose — non-refundable)
- Live-buy customer name for the demo: **Carlos Mendes**

## Pre-demo checklist (T-10 minutes)

- [ ] Primary demo host is the Railway deployment:
      **https://web-production-05db4.up.railway.app** (project
      `montmare-yuno-demo`, service `web`). Webhooks are configured against it
      and land in ITS event log — so present from the deployed site, not
      localhost. Local `npm run dev` is the fallback (localhost has no webhook
      delivery unless you re-point the dashboard at a cloudflared tunnel).
- [ ] **Wipe, then seed — duplicates break the agent flow.** Stale rows from
      earlier seeds make the agent ask "which Maria?" instead of acting
      (observed in testing). ⚠️ On Railway, two traps (hit 2026-07-20): the
      container has **no `sqlite3` binary**, and `railway ssh --service web -- <cmd>`
      **strips quoting** (args are re-joined remotely — the wipe silently
      doesn't run and the seed duplicates). Pipe commands via **stdin**
      instead, using node + better-sqlite3:
      `printf 'node -e "require(%s)(%s).prepare(%s).run()"\nnpm run seed\nexit\n' "'better-sqlite3'" "'data/demo.db'" "'DELETE FROM orders'" | railway ssh --service web`
      (locally the plain `sqlite3 data/demo.db "DELETE FROM orders;" && npm run seed`
      still works). Then verify **exactly 3 rows**: Maria Silva **SUCCEEDED**,
      João Santos **SUCCEEDED**, Ana Oliveira **DECLINED**. ✅ verified live
      2026-07-20 on the Railway host.
- [ ] Webhook config in the Yuno dashboard (Developers → Webhooks): DONE
      2026-07-19 — URL `https://web-production-05db4.up.railway.app/api/webhooks/yuno`,
      x-api-key/x-secret + HMAC all set and verified end-to-end (events arrive
      with `sig=1` within a few seconds of payment creation).
- [ ] `/events` is in a known state (empty, or you know which rows are pre-show).
- [ ] Agent smoke test: open `/ops`, send **"Show recent orders"** — must return the
      seeded orders as a table within a few seconds. This also proves the remote MCP
      connection works from this network. ✅ verified live 2026-07-19 (OpenRouter
      Claude Sonnet 5; full refund chain incl. MCP `paymentRetrieve` and the
      approval-gate halt on `paymentCancelOrRefund` — re-verify from the venue's
      network, since MCP sessions are IP-bound).
- [ ] Backup screencasts ready (recorded from live e2e runs 2026-07-19, in
      `demo-assets/`, local only): `checkout-happy-path.webm` (~28s),
      `agent-refund-roundtrip.webm` (~39s, incl. Confirm → REFUNDED), plus
      deny-path, payment-link, and briefing clips.
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
   the final status. ✅ verified live: post-refund `status: REFUNDED`,
   `sub_status: REFUNDED`; refund transaction `type REFUND / status SUCCEEDED`,
   full R$ 89 via provider CHECKOUT.

**3:30 — Agent-initiated checkout.** Send: **"Create a payment link for R$ 150"**.
✅ Verified live, with a scripted second turn: the agent first asks for the missing
required fields — reply **"CARD only, description: 10X Coffee custom order"** — then
calls `paymentLinkCreate` and returns
`https://checkout.sandbox.y.uno/payment?session=<uuid>`. Framing, one sentence: this
is the agentic-commerce buy-side pattern — an agent initiating a checkout on a
user's behalf and handing back a ready-to-pay link. Ungated: creating a link asks
for money, it doesn't move any. (The clarifying question is a feature — narrate it:
the agent won't invent required fields.)

**4:00 — Concierge briefing.** Send: **"Summarize today's payments"** → the local
briefing tool aggregates today's records from SQLite: count, approved vs declined,
decline reasons, total volume. Narrate: a scheduled-briefing-style answer computed
entirely from the merchant's own records — zero extra Yuno API calls, zero MCP
budget. ✅ verified live 2026-07-20 (localhost against live sandbox; clean
count/split/volume table in the reply).

**4:20 — Judgment, not just obedience.** Send: **"Refund Ana's order"** → the agent
retrieves the payment, sees it's DECLINED, and explains it never succeeded so there
is nothing to refund — no gate even triggered, because it verified state before
acting. ✅ verified live 2026-07-20: agent cited `captured: 0 / refunded: 0` and
every provider's refusal, then refused — no approval card
(`e2e/ops-judgment.spec.ts` pins this).

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
| Agent asks "please confirm" in prose instead of showing the approval card (observed 2026-07-20; system prompt now steers against it) | Reply **"Yes — proceed with the full refund."** — the agent then calls the tool and the card appears (the server-side gate always fires). Narrate it as double-checking; costs ~15 seconds. |
| Webhook doesn't arrive on stage | `/events` still shows the seeded/pre-show state; say retries cover you (Yuno retries 7× with backoff) and move on — check again at the 4:40 beat. |
| Tunnel URL rotated (cloudflared restarted) | Re-paste the new URL in dashboard → Developers → Webhooks. This is why the checklist says tunnel first, dashboard second. |
| Asked about 3DS | Not demoable on this account (no 3DS credentials configured — probed live 2026-07-19: Yuno's 3DS cards, e.g. `4234123412340003`, decline via NMI on DIRECT and are rejected client-side by the SDK). Q&A answer: the `sdk_action_required` → `continuePayment()` branch in `app/checkout/page.tsx` is exactly where a challenge would render; Yuno's 3DS test set uses OTPs `1234` (auth) / `1111` (fail) / `2222` (reject); enabling it is dashboard config (3DS credentials or a provider like Cybersource), no code change. |
| PIX not enabled on the account | Cards-only narrative line: "Same loop handles PIX — `sdk_action_required` → `continuePayment` renders the QR — this account is card-only today." ✅ confirmed 2026-07-19: enabled methods are CARD, iDEAL, Klarna, 7Eleven, Apple Pay, Clearpay, Google Pay — no PIX. |

## Q&A ammo (all verified live 2026-07-20, e2e-pinned)

- **"What if you ask it to charge a card?"** — Verified: "Charge Carlos Mendes
  R$ 50 on his saved card" → the agent searches local records, explains it has no
  charge action (payments.create is not in the allowlist — the tool doesn't exist
  for the model) and offers a payment link instead. No gate, no hallucinated call.
  (`e2e/ops-judgment.spec.ts`)
- **"What if you refund the same order twice?"** — Verified: after Maria's refund,
  the same prompt again → the agent re-retrieves from Yuno, sees
  `status: REFUNDED`, and refuses without opening the gate. Bonus: local DB still
  says SUCCEEDED (webhooks land on the deployed host), so this also proves the
  agent trusts Yuno over stale local state. (`e2e/ops-refund-twice.spec.ts`)
- **"Where's the audit trail?"** — Every run is persisted server-side to the
  `agent_audit` table (SQLite): prompt, each tool call/result with gated flag,
  each Confirm/Deny decision, assistant text, per-step token usage. Show live:
  `sqlite3 data/demo.db "SELECT part_type, tool_name, gated, approved FROM agent_audit ORDER BY id DESC LIMIT 15;"`
  (on Railway via `railway ssh --service web`).

## Rehearsal priorities (things never yet run live)

In order: (1) `npm run seed` against real creds, (2) one full SDK checkout,
(3) webhook delivery + HMAC pass, (4) the `/ops` refund chain incl. approval
round-trip and post-refund status string, (5) payment link + briefing prompts,
(6) record the backup screencast while doing all of the above.
