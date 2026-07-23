import {
  test,
  expect,
  type FrameLocator,
  type Locator,
  type Page,
} from "@playwright/test";

/**
 * Playground checkout E2E against the REAL Yuno sandbox.
 *
 * Needs a live signed workspace link in PLAYGROUND_E2E_LINK (path or absolute
 * URL) — create one via /admin or the admin API first. Skips when unset, so
 * `npm run e2e` stays green without playground env. Tests never touch
 * credential values; the link is a capability, not a secret pair.
 *
 * SDK DOM map: same as checkout.spec.ts (one __zoid__card_form__ iframe for
 * number/expirationDate/cvv; holder/document/email in the main frame).
 */

const LINK = process.env.PLAYGROUND_E2E_LINK;

const CARD_IFRAME = 'iframe[name^="__zoid__card_form__"]';
const SUCCESS_CARD = "4507990000000002";
const CVV = "123";
const HOLDER = "JOHN DOE";
// Valid CPF check-digit sequence (test value, not a real person's document).
const CPF = "52998224725";

/** Fill an input; if programmatic fill is blocked, fall back to typing. */
async function fillField(locator: Locator, value: string) {
  await locator.click();
  await locator.fill(value);
  const got = await locator.inputValue();
  if (got.replace(/\D/g, "") !== value.replace(/\D/g, "")) {
    await locator.clear();
    await locator.pressSequentially(value, { delay: 50 });
  }
}

/** Fill secure fields (iframe) + holder/document/email (main frame). */
async function fillCardForm(page: Page, card: FrameLocator) {
  await fillField(card.locator('input[name="number"]'), SUCCESS_CARD);
  await fillField(card.locator('input[name="expirationDate"]'), "11/28");
  await fillField(card.locator('input[name="cvv"]'), CVV);

  await fillField(page.locator('input[name="cardHolderName"]'), HOLDER);

  const docSelect = page.locator(".sdk-payments-select__input");
  if (await docSelect.isVisible()) {
    await docSelect.click();
    const cpfOption = page.locator(
      '[data-testid="sdk-payments-select__option-CPF"]',
    );
    await cpfOption.waitFor({ state: "visible", timeout: 15_000 });
    await cpfOption.click();
    await fillField(
      page.locator('input[name="document.document_number"]'),
      CPF,
    );
    await expect(page.getByText("Invalid document.")).toHaveCount(0);
  }

  const email = page.locator('input[name="email"]');
  if (await email.isVisible()) {
    await email.fill("playground.tester@example.com");
  }
}

/** Open the workspace link, enter checkout, pick a scenario, start the SDK. */
async function startScenario(
  page: Page,
  scenarioLabel: RegExp,
): Promise<FrameLocator> {
  await page.goto(LINK!);
  await expect(
    page.getByRole("heading", { name: "Feature Playground" }),
  ).toBeVisible();

  // Three feature cards say "Open →" — target the checkout one by href.
  await page.locator('a[href$="/checkout"]').click();
  await page.waitForURL(/\/checkout$/);

  await page.getByRole("button", { name: scenarioLabel }).click();
  await page.getByRole("button", { name: "Start checkout" }).click();

  const card = page.frameLocator(CARD_IFRAME);
  await expect(card.locator('input[name="number"]')).toBeVisible({
    timeout: 90_000,
  });
  return card;
}

test.describe("Playground checkout scenarios (live)", () => {
  test.skip(
    !LINK,
    "Set PLAYGROUND_E2E_LINK to a live signed workspace link to run",
  );

  test("purchase succeeds with the success test card", async ({ page }) => {
    test.setTimeout(300_000);

    const card = await startScenario(page, /^Purchase One-time/);
    await fillCardForm(page, card);

    // /^Pay \d/ — the GPay express button ("Pay with GPay") must not match.
    await page.getByRole("button", { name: /^Pay \d/ }).click();

    await expect(
      page.getByRole("heading", { name: "Payment approved" }),
    ).toBeVisible({ timeout: 120_000 });
    const status = (
      await page.locator('dt:text-is("Payment id") + dd').textContent()
    )?.trim();
    console.log(`[PLAYGROUND purchase] payment_id="${status}"`);
  });

  test("auth_only holds the authorization", async ({ page }) => {
    test.setTimeout(300_000);

    const card = await startScenario(page, /^Authorize only/);
    await fillCardForm(page, card);

    // /^Pay \d/ — the GPay express button ("Pay with GPay") must not match.
    await page.getByRole("button", { name: /^Pay \d/ }).click();

    // capture:false — depending on the account the top-level status reads
    // SUCCEEDED (with an authorized transaction) or AUTHORIZED.
    const heading = page.getByRole("heading", {
      name: /Authorization held|Payment approved/,
    });
    await expect(heading).toBeVisible({ timeout: 120_000 });
    const text = (await heading.textContent())?.trim();
    console.log(`[PLAYGROUND auth_only] heading="${text}"`);
  });

  test("ops lifecycle: authorize, capture, refund", async ({ page }) => {
    test.setTimeout(420_000);

    // Fresh auth-only payment so the newest ops row is ours.
    const card = await startScenario(page, /^Authorize only/);
    await fillCardForm(page, card);
    await page.getByRole("button", { name: /^Pay \d/ }).click();
    await expect(
      page.getByRole("heading", { name: /Authorization held|Payment approved/ }),
    ).toBeVisible({ timeout: 120_000 });

    await page.goto(`${LINK}/ops`);
    await page.getByRole("button", { name: "Inspect" }).first().click();

    // Capture the authorization (amount prefilled from the transaction).
    await page.getByRole("button", { name: /^Capture…$/ }).first().click();
    await page.getByRole("button", { name: /^Confirm capture$/ }).click();
    await expect(page.getByText(/capture → /)).toBeVisible({
      timeout: 90_000,
    });
    console.log(
      `[PLAYGROUND ops] ${(await page.getByText(/capture → /).textContent())?.trim()}`,
    );

    // Full refund (blank amount = full, per Yuno OpenAPI).
    await page.getByRole("button", { name: /^Refund…$/ }).first().click();
    await page.getByRole("button", { name: /^Confirm refund/ }).click();
    await expect(page.getByText(/refund → /)).toBeVisible({ timeout: 90_000 });
    console.log(
      `[PLAYGROUND ops] ${(await page.getByText(/refund → /).textContent())?.trim()}`,
    );
  });

  test("vault: $0 verify, vaulted token, MIT renewal, void", async ({
    page,
  }) => {
    test.setTimeout(420_000);

    await page.goto(`${LINK}/vault`);
    await page.getByRole("button", { name: "Start verification" }).click();

    const card = page.frameLocator(CARD_IFRAME);
    await expect(card.locator('input[name="number"]')).toBeVisible({
      timeout: 90_000,
    });
    await fillCardForm(page, card);
    await page.getByRole("button", { name: /Verify card/ }).click();

    // The vaulted token can take up to ~80s (client polls the payment).
    await expect(page.getByText("card vaulted")).toBeVisible({
      timeout: 180_000,
    });
    const token = (
      await page.locator("code.break-all").textContent()
    )?.trim();
    console.log(`[PLAYGROUND vault] vaulted_token="${token?.slice(0, 12)}…"`);

    // MIT renewal on the vaulted token (auth-only).
    await page.getByRole("button", { name: /Charge renewal/ }).click();
    await expect(page.getByText(/capture it in Post-payment ops/)).toBeVisible(
      { timeout: 90_000 },
    );

    // Void the MIT authorization from the ops panel (newest row = the MIT).
    await page.goto(`${LINK}/ops`);
    await page.getByRole("button", { name: "Inspect" }).first().click();
    await page.getByRole("button", { name: /^Void \/ cancel…$/ }).first().click();
    await page.getByRole("button", { name: /^Confirm void$/ }).click();
    await expect(page.getByText(/void → /)).toBeVisible({ timeout: 90_000 });
    console.log(
      `[PLAYGROUND vault] ${(await page.getByText(/void → /).textContent())?.trim()}`,
    );
  });

  test("webhook inspector shows deliveries to the workspace endpoint", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    // Read the endpoint URL off the inspector itself (it embeds the ws id).
    await page.goto(`${LINK}/webhooks`);
    const endpoint = (await page
      .locator("code", { hasText: /\/api\/webhooks\/yuno\// })
      .textContent({ timeout: 30_000 }))!.trim();
    console.log(`[PLAYGROUND webhooks] endpoint="${endpoint}"`);

    // Simulate a Yuno delivery (real payload shape, nested under data.payment).
    const orderRef = `e2e-wh-${Date.now()}`;
    const res = await page.request.post(endpoint, {
      data: {
        type: "PAYMENT",
        type_event: "payment.updated",
        version: "2",
        data: {
          payment: {
            id: `pay-${orderRef}`,
            merchant_order_id: orderRef,
            status: "SUCCEEDED",
            idempotency_key: orderRef,
          },
        },
      },
    });
    expect(res.status()).toBe(200);

    // The feed polls every 3s — the delivery must appear with its payload.
    await expect(page.getByText(orderRef).first()).toBeVisible({
      timeout: 30_000,
    });
    console.log(`[PLAYGROUND webhooks] delivery ${orderRef} visible in feed`);
  });
});
