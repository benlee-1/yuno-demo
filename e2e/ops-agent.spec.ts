import { test, expect, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";

/**
 * /ops payment-agent E2E against the LIVE Yuno sandbox + remote MCP.
 *
 * IMPORTANT: run `npm run seed` immediately before this spec so Maria Silva
 * and João Santos have fresh SUCCEEDED payments — the Maria test REALLY
 * refunds one (that is the point; the sandbox moves no real money). Re-running
 * without reseeding refunds an already-refunded payment.
 *
 * Duplicate seeded orders for the same customer make the agent ask a
 * disambiguation question first (observed live 2026-07-19). The helpers below
 * answer one clarifying turn when that happens, but for demo determinism
 * prefer a clean orders table: `sqlite3 data/demo.db "DELETE FROM orders;"`
 * then `npm run seed`.
 *
 * Timeouts are deliberately generous: every turn is an LLM round-trip plus
 * remote MCP tool calls (sessions IP-bound, ~15 req/min budget).
 */

const DB_PATH = path.join(__dirname, "..", "data", "demo.db");

interface SeedRow {
  merchant_order_id: string;
  payment_id: string;
  status: string | null;
}

/** Newest seeded order for a customer, straight from the local SQLite DB. */
function newestOrderFor(name: string): SeedRow {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const row = db
      .prepare(
        `SELECT merchant_order_id, payment_id, status FROM orders
         WHERE customer_name LIKE ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(`%${name}%`) as SeedRow | undefined;
    if (!row?.payment_id) {
      throw new Error(`No seeded order for ${name} — run \`npm run seed\` first`);
    }
    return row;
  } finally {
    db.close();
  }
}

const promptBox = (page: Page) => page.getByRole("textbox");

async function say(page: Page, text: string) {
  await expect(promptBox(page)).toBeEnabled({ timeout: 30_000 });
  // Type visibly (screencast-friendly) instead of programmatic fill.
  await promptBox(page).pressSequentially(text, { delay: 25 });
  await page.getByRole("button", { name: "Send" }).click();
}

/** The lime-accented confirmation card rendered for gated tools. */
const approvalCard = (page: Page) =>
  page
    .locator("div.border-l-lime")
    .filter({ has: page.getByText("Confirmation required") });

const refundToolCard = (page: Page) =>
  page
    .locator("div.border-l-lime")
    .filter({ hasText: /payment(CancelOrRefund|Refund)/ });

type TurnOutcome = "approval" | "idle";

/**
 * Wait until the current agent turn settles: either the run halts on a
 * confirmation card ("approval") or the stream finishes and the input bar is
 * re-enabled with no approval pending ("idle" — final answer or a clarifying
 * question from the agent).
 */
async function waitTurnEnd(page: Page, timeout = 240_000): Promise<TurnOutcome> {
  await page.waitForTimeout(1_000); // let the submit engage (input -> disabled)
  const approval = approvalCard(page);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if ((await approval.count()) > 0) return "approval";
    if (await promptBox(page).isEnabled()) {
      await page.waitForTimeout(1_000); // final parts may still be rendering
      return (await approval.count()) > 0 ? "approval" : "idle";
    }
    await page.waitForTimeout(750);
  }
  throw new Error(`agent turn did not settle within ${timeout}ms`);
}

/** Prose of the last assistant message (paragraphs/lists/tables, not tool JSON). */
async function lastAssistantProse(page: Page): Promise<string> {
  const last = page.locator("div.mb-4").last();
  const texts = await last.locator("p, li, td, th").allInnerTexts();
  return texts.join("\n").trim();
}

/**
 * Send the refund prompt and drive the chat to the confirmation card,
 * answering at most one clarifying question (e.g. duplicate orders) with the
 * exact merchant_order_id on the way.
 */
async function reachRefundApproval(page: Page, prompt: string, order: SeedRow) {
  await page.goto("/ops");
  await say(page, prompt);

  await expect(page.getByText("searchOrders", { exact: true })).toBeVisible({
    timeout: 120_000,
  });

  let outcome = await waitTurnEnd(page);
  if (outcome === "idle") {
    const question = await lastAssistantProse(page);
    console.log(`[ops-agent] clarifying question:\n${question}`);
    await say(
      page,
      `The newest one: order ${order.merchant_order_id} (payment ${order.payment_id}).`,
    );
    outcome = await waitTurnEnd(page);
  }
  expect(outcome, "expected the run to halt on a confirmation card").toBe(
    "approval",
  );

  const approval = approvalCard(page);
  await expect(approval).toBeVisible();
  // The approval must reference the right payment (id or merchant order id).
  await approval.getByRole("button", { name: /full input/ }).click();
  await expect(approval).toContainText(
    new RegExp(`${order.payment_id}|${order.merchant_order_id}`),
  );

  // Did the agent re-verify with Yuno before the gate? (Non-fatal — log it.)
  const retrieved =
    (await page.getByText(/^paymentRetrieve(ByMerchantOrderId)?$/).count()) > 0;
  console.log(
    `[ops-agent] approval reached for ${order.merchant_order_id}; pre-gate paymentRetrieve card present: ${retrieved}`,
  );
  return approval;
}

// Video for the backup screencast (Playwright requires this at file level).
test.use({
  video: { mode: "on", size: { width: 1280, height: 720 } },
  viewport: { width: 1280, height: 720 },
});

// ---------------------------------------------------------------------------
// Task A — refund approval round-trip (video-recorded for the screencast)
// ---------------------------------------------------------------------------

test.describe("refund round-trip (Confirm)", () => {
  test("Refund Maria's coffee order — approve and execute", async ({ page }) => {
    test.setTimeout(600_000);
    const maria = newestOrderFor("Maria");
    expect(maria.status).toBe("SUCCEEDED"); // fresh seed sanity

    const approval = await reachRefundApproval(
      page,
      "Refund Maria's coffee order",
      maria,
    );

    await page.waitForTimeout(1500); // screencast beat: card readable on video
    await approval.getByRole("button", { name: "Confirm" }).click();

    // Auto-resubmit → server executes the gated tool → card flips to done.
    const refundCard = refundToolCard(page);
    await expect(refundCard.getByText("done", { exact: true })).toBeVisible({
      timeout: 240_000,
    });
    await expect(refundCard.getByText("error", { exact: true })).toHaveCount(0);

    // Surface the raw tool result for the record.
    await refundCard.getByRole("button", { name: /result/ }).click();
    const rawResult = await refundCard.locator("pre").last().innerText();
    console.log(`[ops-agent] refund tool result:\n${rawResult}`);

    // Final assistant message reports the refund.
    await waitTurnEnd(page, 240_000);
    const prose = await lastAssistantProse(page);
    console.log(`[ops-agent] final assistant text:\n${prose}`);
    expect(prose).toMatch(/refund/i);

    await page.waitForTimeout(2000); // screencast beat: final state on video
  });
});

// ---------------------------------------------------------------------------
// Task A — deny path (no execution)
// ---------------------------------------------------------------------------

test.describe("refund round-trip (Deny)", () => {
  test("Refund João's coffee order — deny, nothing executes", async ({
    page,
  }) => {
    test.setTimeout(600_000);
    const joao = newestOrderFor("João");
    expect(joao.status).toBe("SUCCEEDED");

    const approval = await reachRefundApproval(
      page,
      "Refund João's coffee order",
      joao,
    );

    await approval.getByRole("button", { name: "Deny" }).click();

    // The part flips to output-denied — the tool never ran.
    await expect(page.getByText("User denied this action.")).toBeVisible({
      timeout: 120_000,
    });
    const refundCard = refundToolCard(page);
    await expect(refundCard.getByText("denied", { exact: true })).toBeVisible();
    await expect(refundCard.getByText("done", { exact: true })).toHaveCount(0);

    // Agent acknowledges the denial in prose.
    await waitTurnEnd(page, 240_000);
    const prose = await lastAssistantProse(page);
    console.log(`[ops-agent] deny acknowledgement:\n${prose}`);
    expect(prose.length).toBeGreaterThan(0);
    // Out-of-band API check (payment still SUCCEEDED) runs outside this spec —
    // see pay-check.mjs; the UI-level guarantee is the "denied" state above.
  });
});

// ---------------------------------------------------------------------------
// Task B — ungated tools: payment link + briefing
// ---------------------------------------------------------------------------

test.describe("ungated tools", () => {
  test("Create a payment link for R$ 150 — executes without confirmation", async ({
    page,
  }) => {
    test.setTimeout(600_000);

    await page.goto("/ops");
    await say(page, "Create a payment link for R$ 150");

    const linkCard = page
      .locator("div.border-l-4")
      .filter({ hasText: "paymentLinkCreate" });

    let outcome = await waitTurnEnd(page);
    if (outcome === "idle" && (await linkCard.count()) === 0) {
      // Agent asks for required details (observed live: payment method types +
      // description). Answer once and continue.
      const question = await lastAssistantProse(page);
      console.log(`[ops-agent] payment-link follow-up question:\n${question}`);
      await say(
        page,
        'CARD only, description "Montmare custom order". BRL / BR is correct — no other options needed.',
      );
      outcome = await waitTurnEnd(page);
    }

    // NOT gated: it must execute without ever pausing on a confirmation card.
    expect(outcome).toBe("idle");
    await expect(page.getByText("Confirmation required")).toHaveCount(0);
    await expect(linkCard.getByText("done", { exact: true })).toBeVisible();

    // The response carries a sandbox checkout URL.
    const body = (await page.locator("body").innerText()) ?? "";
    const url = body.match(/https:\/\/checkout\.sandbox\.y\.uno[^\s"')\]`]*/);
    console.log(`[ops-agent] payment link URL: ${url?.[0] ?? "NOT FOUND"}`);
    expect(url, "expected a checkout.sandbox.y.uno URL in the reply").toBeTruthy();
  });

  test("Summarize today's payments — paymentsBriefing", async ({ page }) => {
    test.setTimeout(360_000);

    await page.goto("/ops");
    await say(page, "Summarize today's payments");

    const briefingCard = page
      .locator("div.border-l-4")
      .filter({ hasText: "paymentsBriefing" });
    await expect(briefingCard.getByText("done", { exact: true })).toBeVisible({
      timeout: 180_000,
    });

    await waitTurnEnd(page, 240_000);
    const prose = await lastAssistantProse(page);
    console.log(`[ops-agent] briefing:\n${prose}`);
    // Light-touch assertions (LLM wording varies): amounts + counts present.
    expect(prose).toMatch(/R\$/);
    expect(prose).toMatch(/\d/);
    expect(prose).toMatch(/succeeded|approved|declined|order|payment/i);
  });
});
