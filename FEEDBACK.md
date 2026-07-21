# Integration feedback for Yuno

Plain-language notes from building this demo (storefront + checkout + webhooks
+ AI payment-ops agent). Everything here actually happened to us — nothing is
hypothetical. Ordered by who it matters to most.

---

## The agent toolkit & MCP (the AI stuff)

### 1. The toolkit secretly phones home — and doesn't tell you

Yuno's agent toolkit looks like a normal code library, but it's actually a
thin client: every tool call travels to Yuno's remote AI server (the MCP
server) and runs there. We only learned this by reading the package's source
code.

Why it matters: that remote server has real operational limits — sessions are
tied to your IP address, roughly 15 requests per minute, and idle sessions
die after 30 minutes. If you don't know that, you'll design your app wrong.
We had to restructure ours (open a fresh connection per chat request, close
it after) once we figured it out.

**Ask:** put "this is a remote client, here are the limits" at the top of the
README.

### 2. No built-in "are you sure?" for dangerous actions

The toolkit hands an AI the power to refund money, but ships with no
confirmation step. We had to build our own approval gate (the Confirm/Deny
card in our demo) from scratch.

Why it matters: every serious integrator will need this, and everyone will
build it slightly differently, with different holes.

**Ask:** ship the tools with a "this one moves money" label and an optional
built-in approval hook.

### 3. Full access is the default (verified in the source)

If you don't pass a permissions config, the toolkit gives the agent **every
tool** — including refunds, cancellations, and subscription kills. We checked
the code: no config means no filtering. And the README's first quickstart
example passes no config, so the first agent anyone copy-pastes together has
full money-moving power without ever seeing the word "permissions."
(`ALL_TOOLS_ENABLED` is just the explicit spelling of what silence already
does.)

Payments tooling normally works the other way — you request scopes
explicitly, like API key scopes. Copy-paste code becomes production code, so
the quickstart is the real default.

**Ask:** default deny (no config = no tools, or an error), a scoped
permissions block in the quickstart, and a "moves money" label on the
dangerous tools.

### 4. The tools only fetch by ID — say so up front

There's no "search payments by customer name" tool, only "fetch payment by
ID." That's a fair design (the merchant knows who Maria is; Yuno doesn't) —
but nobody tells you. We figured out on our own that you need your own
database next to the toolkit so the agent can turn "Maria's order" into a
payment ID.

**Ask:** one docs paragraph: "your agent needs a merchant-side lookup; here's
the pattern."

---

## The docs

### 5. The amounts example teaches people to overcharge 100×

The quickstart shows `"value": "2500"` — which reads as cents (like Stripe).
Yuno actually uses plain currency units: R$ 89 is `89`, not `8900`. The
reference docs get it right; the quickstart contradicts them.

**Ask:** fix the quickstart example. This is the single most dangerous line in
the docs.

### 6. Quickstart and reference disagree on how to start a checkout

The quickstart says you can pass any made-up customer ID; the reference says
you must create a real customer first and use its UUID. The reference is
right (we tested). Bonus trap: card payments fail with a cryptic
`INVALID_CUSTOMER_FOR_TOKEN` error unless you also pass the customer ID a
second time inside the payment call — we found that by trial and error.

### 7. Old function names still float around the SDK docs

The browser SDK renamed its callbacks (`yunoCreatePayment` → `createPayment`,
etc.). Docs and examples still mix old and new. The only fully reliable
reference ended up being the TypeScript type definitions inside the package.

### 8. Webhook payloads don't quite match the docs

Real deliveries nest the payment under `data.payment`; the docs show it flat.
And the dashboard's three webhook auth fields (api key / secret / HMAC
checkbox) don't say which HTTP header each one becomes — we mapped them by
experiment.

---

## The sandbox

### 9. The "decline" test cards don't decline (biggest sandbox surprise)

The documented decline cards get **approved** on our account. Reason: the
account routes through several real provider sandboxes with failover — we
watched the same card get refused by Adyen, refused by Stripe, then approved
by Checkout.com (whose sandbox approves any valid-looking card). There is
currently **no way to demo a decline through the browser checkout at all** —
expired dates are blocked by the form itself before submission.

**Ask:** one test card that declines at *every* provider, or a clear docs
note that test-card outcomes depend on your account's routing setup.

### 10. The 3DS test cards fail before you get to 3DS

The special 3DS test cards are rejected by the card form itself ("Invalid
card number") — so you can't even get far enough to find out 3DS isn't
enabled on your account. Two walls, no signpost.

---

## What's genuinely good

- **`cancel-or-refund` is the perfect agent tool** — it decides by itself
  whether to cancel (not yet captured) or refund (captured). One verb, no
  footguns.
- **Leaving out the amount = full refund** — a great safe default; the agent
  can't fat-finger a partial amount.
- **Idempotency keys everywhere** made retries and webhook dedupe easy.
- **Webhook delivery was fast and reliable** — signed, retried 7×, arriving
  within seconds in our tests.

The honest summary: **the API itself is well designed — the docs and the AI
tooling just haven't caught up to it yet.**
