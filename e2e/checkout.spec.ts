import {
  test,
  expect,
  type FrameLocator,
  type Locator,
  type Page,
} from "@playwright/test";

/**
 * E2E against the REAL Yuno sandbox. The dev server reads .env.local itself;
 * these tests never touch credential values.
 *
 * DOM map (discovered 2026-07-19, SDK v1.9.15 / card-form v1.86.7):
 * - #yuno-checkout — SDK mount point (app/checkout/page.tsx)
 * - [data-testid="radio-CARD"] — card payment-method radio (pre-selected)
 * - Secure fields live in ONE iframe: iframe[name^="__zoid__card_form__"]
 *   (src https://sdk-web-card.sandbox.y.uno/.../card-form.html) containing
 *   input[name="number"], input[name="expirationDate"], input[name="cvv"]
 * - Main frame (NOT in the iframe): input[name="cardHolderName"],
 *   BR document combobox (.sdk-payments-select__input + [role="option"]),
 *   input[name="document.document_number"], input[name="email"]
 * - App pay button: "Pay R$ 89,00" (calls yuno.startPayment())
 */

const SHOTS =
  "/private/tmp/claude-501/-Users-benlee-code-yuno-demo/4df5d6bf-a9f2-47d0-9f35-5d2f68a97c1f/scratchpad/e2e";

const CARD_IFRAME = 'iframe[name^="__zoid__card_form__"]';
const SUCCESS_CARD = "4507990000000002";
const CVV = "123";
const HOLDER = "JOHN DOE";
const CUSTOMER = "Playwright Buyer";
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

/** Storefront -> /checkout with the SDK card form mounted. */
async function beginCheckout(page: Page): Promise<FrameLocator> {
  await page.goto("/");
  await page.getByLabel("Customer name").fill(CUSTOMER);
  await page.getByRole("button", { name: /buy now/i }).click();
  await page.waitForURL(/\/checkout\?/);

  // The Yuno SDK loads remote assets + creates a session; be patient.
  const card = page.frameLocator(CARD_IFRAME);
  await expect(card.locator('input[name="number"]')).toBeVisible({
    timeout: 90_000,
  });

  // CARD is pre-selected on this account; click it if that ever changes.
  const cardRadio = page.locator('[data-testid="radio-CARD"]');
  if ((await cardRadio.getAttribute("aria-checked")) !== "true") {
    await cardRadio.click();
  }
  return card;
}

/** Fill secure fields (iframe) + holder/document/email (main frame). */
async function fillCardForm(
  page: Page,
  card: FrameLocator,
  expiry: string,
  cardNumber: string = SUCCESS_CARD,
) {
  await fillField(card.locator('input[name="number"]'), cardNumber);
  await fillField(card.locator('input[name="expirationDate"]'), expiry);
  await fillField(card.locator('input[name="cvv"]'), CVV);

  await fillField(page.locator('input[name="cardHolderName"]'), HOLDER);

  // BR document (CPF) — SDK renders a combobox in the main frame.
  // Options carry data-testids like sdk-payments-select__option-CPF.
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
    await email.fill("playwright.buyer@example.com");
  }
}

const payButton = (page: Page) =>
  page.getByRole("button", { name: /^Pay R\$/ });

const statusBadge = (page: Page) => page.locator('dt:text-is("Status") + dd');

test.describe("Yuno sandbox checkout (live)", () => {
  test("successful purchase with the success test card", async ({ page }) => {
    test.setTimeout(300_000);

    await page.goto("/");
    await page.screenshot({ path: `${SHOTS}/01-storefront.png`, fullPage: true });

    const card = await beginCheckout(page);
    await page.screenshot({
      path: `${SHOTS}/02-checkout-mounted.png`,
      fullPage: true,
    });

    await fillCardForm(page, card, "11/28");
    await page.screenshot({
      path: `${SHOTS}/03-checkout-filled.png`,
      fullPage: true,
    });

    await payButton(page).click();

    // Tokenization + backend POST /v1/payments + redirect. No fixed sleeps.
    await page.waitForURL(/\/checkout\/result/, { timeout: 120_000 });

    await expect(
      page.getByRole("heading", { name: "Payment approved" }),
    ).toBeVisible({ timeout: 90_000 });
    await expect(statusBadge(page)).toHaveText(/SUCCEEDED|APPROVED/);

    const status = (await statusBadge(page).textContent())?.trim();
    const heading = (
      await page.getByRole("heading", { level: 1 }).textContent()
    )?.trim();
    console.log(`[RESULT success] heading="${heading}" status="${status}"`);

    await page.screenshot({
      path: `${SHOTS}/04-result-success.png`,
      fullPage: true,
    });
  });

  test("declined purchase with expired card (11/20)", async ({ page }) => {
    test.setTimeout(300_000);

    const card = await beginCheckout(page);
    await fillCardForm(page, card, "11/20");
    await page.screenshot({
      path: `${SHOTS}/05-decline-filled.png`,
      fullPage: true,
    });

    await payButton(page).click();

    // Observed live (2026-07-19): the SDK client-side-validates the expired
    // date inside the secure-field iframe ("Invalid year.") and BLOCKS
    // submission — no token is created and the backend is never called.
    // The race below still tolerates a result-page navigation in case the
    // SDK behavior changes.
    const sdkExpiredError = card
      .getByText(/invalid year|invalid month|invalid expiry|expired/i)
      .first();
    const appError = page.locator(".text-red-700").first();

    const outcome = await Promise.race([
      page
        .waitForURL(/\/checkout\/result/, { timeout: 120_000 })
        .then(() => "navigated" as const),
      sdkExpiredError
        .waitFor({ state: "visible", timeout: 120_000 })
        .then(() => "sdk-validation-error" as const),
      appError
        .waitFor({ state: "visible", timeout: 120_000 })
        .then(() => "app-error" as const),
    ]);

    if (outcome === "navigated") {
      await expect(
        page.getByRole("heading", { name: "Payment declined" }),
      ).toBeVisible({ timeout: 90_000 });
      const status = (await statusBadge(page).textContent())?.trim();
      const heading = (
        await page.getByRole("heading", { level: 1 }).textContent()
      )?.trim();
      console.log(
        `[RESULT decline] outcome=result-page heading="${heading}" status="${status}"`,
      );
      await expect(statusBadge(page)).not.toHaveText(/SUCCEEDED|APPROVED/);
    } else if (outcome === "sdk-validation-error") {
      const text = (await sdkExpiredError.textContent())?.trim();
      console.log(
        `[RESULT decline] outcome=sdk-client-side-validation blocked submission: "${text}"`,
      );
      // Submission blocked client-side: still on /checkout, no payment made.
      await expect(page).toHaveURL(/\/checkout\?/);
    } else {
      const text = (await appError.textContent())?.trim();
      console.log(`[RESULT decline] outcome=app-inline-error: "${text}"`);
    }

    await page.screenshot({
      path: `${SHOTS}/06-decline-endstate.png`,
      fullPage: true,
    });
  });

  // NOTE (2026-07-19): a browser-flow decline was probed with Yuno's
  // 3DS-family PAN 4234123412340003 (declines via NMI in the DIRECT
  // workflow) — the SDK rejects it client-side ("Invalid card number.",
  // BIN check beyond Luhn). Conclusion: no deterministic browser decline
  // exists on this account; the demo narrates Ana's seeded DECLINED order.
});
