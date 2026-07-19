import { test, expect, type Locator } from "@playwright/test";

/**
 * Backup-screencast recording: the full happy-path checkout against the LIVE
 * Yuno sandbox, with video enabled and slightly slowed actions so the footage
 * is watchable. Functionally identical to the success test in
 * e2e/checkout.spec.ts (same selector map — see that file's DOM notes).
 *
 * Video lands in test-results/…/video.webm (copy it out after the run).
 */

test.use({
  video: { mode: "on", size: { width: 1280, height: 720 } },
  viewport: { width: 1280, height: 720 },
  launchOptions: { slowMo: 150 },
});

const CARD_IFRAME = 'iframe[name^="__zoid__card_form__"]';
const SUCCESS_CARD = "4507990000000002";
const CVV = "123";
const EXPIRY = "11/28";
// Demo persona from DEMO.md's live-buy beat.
const CUSTOMER = "Carlos Mendes";
const HOLDER = "CARLOS MENDES";
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

test.describe("screencast — happy-path checkout (live sandbox)", () => {
  test("buy the coffee with the success card", async ({ page }) => {
    test.setTimeout(300_000);

    await page.goto("/");
    await page.waitForTimeout(1200); // screencast beat: storefront visible

    await page.getByLabel("Customer name").pressSequentially(CUSTOMER, {
      delay: 60,
    });
    await page.getByRole("button", { name: /buy now/i }).click();
    await page.waitForURL(/\/checkout\?/);

    const card = page.frameLocator(CARD_IFRAME);
    await expect(card.locator('input[name="number"]')).toBeVisible({
      timeout: 90_000,
    });

    const cardRadio = page.locator('[data-testid="radio-CARD"]');
    if ((await cardRadio.getAttribute("aria-checked")) !== "true") {
      await cardRadio.click();
    }

    await fillField(card.locator('input[name="number"]'), SUCCESS_CARD);
    await fillField(card.locator('input[name="expirationDate"]'), EXPIRY);
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
      await email.fill("carlos.mendes@example.com");
    }

    await page.waitForTimeout(1200); // screencast beat: filled form visible
    await page.getByRole("button", { name: /^Pay R\$/ }).click();

    await page.waitForURL(/\/checkout\/result/, { timeout: 120_000 });
    await expect(
      page.getByRole("heading", { name: "Payment approved" }),
    ).toBeVisible({ timeout: 90_000 });
    await expect(page.locator('dt:text-is("Status") + dd')).toHaveText(
      /SUCCEEDED|APPROVED/,
    );

    await page.waitForTimeout(2500); // screencast beat: hold the success page
  });
});
