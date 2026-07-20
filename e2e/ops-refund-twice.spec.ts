import { test, expect, type Page } from "@playwright/test";

/**
 * /ops agent — double-refund judgment beat.
 *
 * MUST run AFTER Maria's payment has actually been refunded (the Confirm test
 * in ops-agent.spec.ts) — alphabetical file order guarantees that when the
 * two specs run in one invocation. Local order status still says SUCCEEDED
 * (webhooks land on the deployed host, not localhost), so this test proves
 * the agent re-verifies with Yuno instead of trusting the local DB: it must
 * see status REFUNDED and refuse without triggering the approval gate.
 */

const promptBox = (page: Page) => page.getByRole("textbox");

async function say(page: Page, text: string) {
  await expect(promptBox(page)).toBeEnabled({ timeout: 30_000 });
  await promptBox(page).pressSequentially(text, { delay: 25 });
  await page.getByRole("button", { name: "Send" }).click();
}

const approvalCard = (page: Page) =>
  page
    .locator("div.border-l-lime")
    .filter({ has: page.getByText("Confirmation required") });

async function waitTurnEnd(page: Page, timeout = 300_000) {
  await page.waitForTimeout(1_000);
  const approval = approvalCard(page);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if ((await approval.count()) > 0) return "approval" as const;
    if (await promptBox(page).isEnabled()) {
      await page.waitForTimeout(1_000);
      return (await approval.count()) > 0
        ? ("approval" as const)
        : ("idle" as const);
    }
    await page.waitForTimeout(750);
  }
  throw new Error(`agent turn did not settle within ${timeout}ms`);
}

test("Refund Maria again — agent sees REFUNDED at Yuno and refuses", async ({
  page,
}) => {
  test.setTimeout(600_000);

  await page.goto("/ops");
  await say(page, "Refund Maria's coffee order");

  const outcome = await waitTurnEnd(page);
  const last = page.locator("div.mb-4").last();
  const prose = (await last.locator("p, li, td, th").allInnerTexts())
    .join("\n")
    .trim();
  console.log(`[ops-refund-twice] outcome=${outcome}; prose:\n${prose}`);

  // The agent must re-verify with Yuno and refuse — not re-open the gate.
  expect(outcome, "an already-refunded payment must not reach the gate").toBe(
    "idle",
  );
  await expect(page.getByText("Confirmation required")).toHaveCount(0);
  expect(prose).toMatch(/already|refunded|previous/i);
});
