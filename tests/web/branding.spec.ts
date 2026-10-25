import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("http://127.0.0.1:47831/**", route => route.abort());
});

test("supplied logo stays visible in the expanded and compact navigation", async ({ page }, testInfo) => {
  await page.goto("/");
  const trigger = page.getByRole("main").getByRole("button", { name: "メニューを開閉", exact: true });
  const mobile = (page.viewportSize()?.width ?? 1280) < 768;
  if (mobile) {
    const originalViewport = page.viewportSize()!;
    await page.setViewportSize({ ...originalViewport, width: 700 });
    await expect(page.locator('header img[src="/brand/runmeter-mark-dark.svg"]')).toBeVisible();
    await page.setViewportSize(originalViewport);
    await expect(page.locator('header img[src="/brand/runmeter-mark-dark.svg"]')).toBeVisible();
    await trigger.click();
  }
  const visibleLogo = page.locator('img[alt="RunMeter"]:visible');
  await expect(visibleLogo).toHaveCount(1);
  await expect(visibleLogo).toHaveAttribute("src", "/brand/runmeter-logo-dark.svg");
  await expect.poll(() => visibleLogo.evaluate(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)).toBe(true);
  if (!mobile) await page.screenshot({ path: testInfo.outputPath("logo-desktop.png"), fullPage: true });
  if (mobile) {
    await page.getByRole("button", { name: "閉じる", exact: true }).click();
    await expect(trigger).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath("logo-mobile.png"), fullPage: true });
  } else {
    await trigger.click();
    await expect(visibleLogo).toHaveAttribute("src", "/brand/runmeter-mark-dark.svg");
    await expect(visibleLogo).toBeVisible();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("favicon formats and supplied SVG variants are served with the new metadata", async ({ request }) => {
  const page = await request.get("/");
  expect(await page.text()).toContain("/brand/runmeter-appicon.svg?v=20261025");
  const favicon = await request.get("/favicon.ico?v=20261025");
  expect(favicon.status()).toBe(200);
  const icon = await favicon.body();
  expect(icon.readUInt16LE(2)).toBe(1);
  expect(icon.readUInt16LE(4)).toBe(4);
  expect(Array.from({ length: 4 }, (_, index) => icon.readUInt8(6 + index * 16))).toEqual([16, 32, 48, 64]);
  for (const name of ["appicon", "logo-dark", "logo-light", "mark-dark"]) {
    const response = await request.get(`/brand/runmeter-${name}.svg`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("image/svg+xml");
    expect(await response.text()).not.toMatch(/<script|foreignObject|\son[a-z]+\s*=/i);
  }
});
