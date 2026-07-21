# Demo inputs — exact things to type, in order

Cheat sheet only. The full talk track and contingencies live in `DEMO.md`.

---

## 0. Before you start (T-10)

Wipe + reseed (from repo root, local machine):

```
printf 'node -e "require(%s)(%s).prepare(%s).run()"\nnpm run seed\nexit\n' "'better-sqlite3'" "'data/demo.db'" "'DELETE FROM orders'" | railway ssh --service web
```

Expect exactly 3 rows in the seed summary: **Maria Silva SUCCEEDED, João
Santos SUCCEEDED, Ana Oliveira DECLINED**.

Demo host: **https://web-production-05db4.up.railway.app** (not localhost —
webhooks land there).

---

## 1. SUCCEEDED payment (live buy)

Store page → fill in:

| Field | Type this |
|---|---|
| Customer name | `Carlos Mendes` |
| Email | *(leave blank)* |

→ **BUY NOW** → in the Yuno card form:

| Field | Type this |
|---|---|
| Card number | `4507 9900 0000 0002` |
| Expiry | `11/28` |
| CVV | `123` |
| Cardholder | `Carlos Mendes` |
| Document type | `CPF` |
| CPF number | `529.982.247-25` |
| Email (card form) | `carlos@example.com` |

→ **Pay R$ 89,00** → result page shows **APPROVED / SUCCEEDED**.

## 2. Webhook, live

Open **Events** tab. The `payment.purchase` row appears within ~3 seconds
(page polls). Point at `sig ✓` — HMAC verified over the raw body.

## 3. DECLINED payment (narrated — do NOT attempt a live decline)

There is no clickable decline on this account: "decline" test cards get
**approved** by routing failover (Adyen refuses → Stripe refuses →
Checkout.com approves), and expired dates are blocked client-side by the SDK.
Tell the failover story, then show the decline that *does* exist in the data:
**Ana Oliveira's seeded order** — created API-side with an expired card
(`11/20`), refused by every provider. She shows up DECLINED in the next step.

## 4. Ops Agent (type these in sequence)

```
Show recent orders
```
Table with Maria + João (SUCCEEDED), Ana (DECLINED), and your Carlos buy.

```
Refund Maria's coffee order
```
Watch the tool chain: `searchOrders` → `paymentRetrieve*` → gated refund call
→ **run pauses on the approval card**. While paused, show
`lib/agent/permissions.ts` + the scopes sidebar. Then click **Confirm** →
executes → agent re-checks Yuno and reports **REFUNDED**.

- If it asks permission in prose instead of showing the card, reply:
  `Yes — proceed with the full refund.`
- Deny-path variant (if you want it): same prompt with **João**, click
  **Deny** → nothing executes.

```
Create a payment link for R$ 150
```
It asks for missing required fields. Reply:

```
CARD only, description: 10X Coffee custom order
```
→ returns a `checkout.sandbox.y.uno` link. Ungated — asks for money, doesn't
move it.

```
Summarize today's payments
```
Briefing from local SQLite only — zero Yuno/MCP calls.

```
Refund Ana's order
```
Agent retrieves the payment, sees DECLINED, refuses — **no approval card**.
Judgment, not obedience.

## 5. Q&A spares (only if asked)

```
Charge Carlos Mendes R$ 50 on his saved card
```
Refuses — no charge capability exists (`payments.create` not in allowlist).

```
Refund Maria's coffee order
```
(again, post-refund) Re-checks Yuno, sees REFUNDED, refuses — trusts Yuno
over the local DB.

Audit trail, on Railway:

```
printf 'node -e "const db=require(%s)(%s);console.log(JSON.stringify(db.prepare(%s).all(),null,1))"\nexit\n' "'better-sqlite3'" "'data/demo.db'" "'SELECT part_type,tool_name,gated,approved FROM agent_audit ORDER BY id DESC LIMIT 15'" | railway ssh --service web
```

---

**Remember:** the Maria refund and the live buy dirty the data — run the
step-0 wipe+reseed after any rehearsal and again right before showtime.
