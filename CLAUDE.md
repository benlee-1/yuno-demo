@AGENTS.md

# 10X Coffee — Yuno Payments Demo

One-product demo storefront ("10X Blend" coffee, R$ 89,00 BRL, store branded
"10X Coffee" — dev-productivity humor; Railway project is still named
`montmare-yuno-demo`) that
generates **sandbox** transactions via Yuno's Seamless Web SDK, plus a
least-privilege payment-ops agent (`/ops`). Built for a live onboarding
presentation. Sandbox only — no real cards, ever.

## Commands

- `npm run build` — production build (must pass with no `.env.local` present)
- `npm run seed` — create 3 named sandbox orders (Maria/João SUCCEEDED, Ana
  DECLINED on purpose) so the agent has data; needs Yuno creds in `.env.local`

## Docs

- `CONTEXT.md` — Yuno docs recon findings (API facts, test cards, webhook shape,
  MCP constraints); ⏳ marks anything not yet verified against the live sandbox
- `README.md` — architecture + payment loop + agent design + setup
- `DEMO.md` — the 5-minute presentation runbook (scripted prompts, contingencies)

## Conventions & gotchas

- **Amounts are DECIMAL major units.** BRL 89.00 → `amount: { currency: "BRL", value: 89 }`.
  NOT minor units/cents (the Yuno quickstart's `2500` example is misleading).
- **Two-header auth.** Every Yuno API call sends both `public-api-key` and
  `private-secret-key` headers. All API calls go through `yunoFetch()` in
  `lib/yuno.ts` — never call the Yuno API directly elsewhere.
- **NEVER log or hardcode `YUNO_PRIVATE_SECRET_KEY`** (or any header values).
  `yunoFetch` logs only `method path -> status`.
- **Env is read lazily at request time** (missing creds throw `YunoConfigError`
  which routes turn into a 500 JSON error) so the build never requires
  `.env.local`.
- **DB access only via `lib/db.ts`.** better-sqlite3 is a synchronous native
  module — every route/page importing it must export `runtime = "nodejs"`.
  Schema is created on first open; `data/*.db` is gitignored.
- **Web SDK (client):** `import { loadScript } from "@yuno-payments/sdk-web"`,
  then `const sdk = await loadScript({ env: "sandbox" })`,
  `const yuno = await sdk.initialize(publicApiKey)`, then
  `startCheckout({...})` → `mountCheckout()` → `startPayment()` on the pay
  button, `continuePayment()` when `sdk_action_required` (e.g. 3DS). Callback
  names are `createPayment` / `paymentResult` / `error` (the `yuno*`-prefixed
  ones are deprecated aliases). Ground truth:
  `node_modules/@yuno-payments/sdk-web-types/dist/index.d.ts`.
- **Webhooks:** `/api/webhooks/yuno` verifies `x-hmac-signature` =
  base64(HMAC-SHA256) over the RAW body before JSON.parse, dedupes on
  `data.idempotency_key`, and never 500s (Yuno retries 7×).
- **Design tokens** live in `app/globals.css` (Tailwind v4 `@theme` block:
  `primary #3E4FE0`, `primary-dark`, `primary-light`, `pale`, `lime #C7E956`,
  `ink`; `shadow-glass`, `rounded-btn`; `font-display` = Archivo Black via
  next/font). Shared UI in `components/ui.tsx` (GlassCard/Button/Input/Badge),
  `components/nav.tsx`, `components/marquee.tsx` (CSS-only ticker). Light theme
  only, liquid-glass look (translucent white surfaces + gradient mesh
  background) with sneaker-drop accents: marquee bands, rotated `.sticker`
  pills, `.stamp-round` / `.stamp-ink` stamps (all in `globals.css`).
  ⚠️ Restyle-safe zones only — the e2e specs pin exact heading/button texts,
  `#yuno-checkout`, `.text-red-700`, `border-l-lime`, and the ops chip labels;
  never uppercase contract text in the DOM (CSS `text-transform` is fine).

## Agent architecture (`lib/agent/*`)

- `lib/agent/permissions.ts` — the permissions policy module: explicit
  `PERMISSIONS` allowlist (deliberately NOT `ALL_TOOLS_ENABLED`;
  `payments.create/authorize/capture` intentionally absent), `REQUIRES_CONFIRMATION`
  list, and **the confirmation gate** = `buildToolApproval()` feeding AI SDK v7
  `toolApproval` in `app/api/chat/route.ts` (server-enforced; `isDestructiveTool`
  fails closed via regex on unknown destructive tool names). Isomorphic on
  purpose — the `/ops` UI imports it to render scopes and gate markers.
- `lib/agent/toolkit.ts` — per-request toolkit build; caller MUST
  `await toolkit.close()` (chat route does so on finish/abort/error).
- `lib/agent/local-tools.ts` — read-only SQLite tools (`searchOrders`,
  `listRecentOrders`, `paymentsBriefing`); the name→Yuno-ID mapping lives
  here, not in Yuno.
- `lib/agent/audit.ts` — persistent audit trail: every run's prompt, tool
  calls/results (with gated flag), Confirm/Deny decisions, and per-step token
  usage into the `agent_audit` table via `onStepEnd` (NOT the deprecated
  `onStepFinish` alias). Best-effort — an audit failure never breaks the stream.
- `lib/agent/system-prompt.md` — versioned system prompt, read per request.
- **The agent toolkit IS an MCP client** — `createYunoAgentToolkit()` connects to
  the remote MCP at `mcp.prod.y.uno`; every tool call is a remote MCP call, so
  the remote limits apply to us: sessions IP-bound, ~15 req/min, 30-min idle cap.
  Hence per-request create+close, `stopWhen: stepCountIs(10)`, and demo pacing.

## Env vars

See `.env.local.example` for the full annotated list.
