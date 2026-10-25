import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("license page links the MIT, branding and full upstream notices", async ({ page, request }, testInfo) => {
  await page.route("http://127.0.0.1:47831/**", route => route.abort());
  await page.goto("/");
  await page.getByRole("link", { name: "ライセンス・OSS表記", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "ライセンス・OSS表記" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "RunMeter本体：MITライセンス" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "ロゴ・ブランド素材：権利留保" })).toBeVisible();
  for (const [linkName, path, source] of [
    ["MITライセンス原文を開く", "/licenses/LICENSE.txt", "LICENSE"],
    ["ブランド素材の権利表記を開く", "/licenses/BRANDING_LICENSE.txt", "BRANDING_LICENSE.md"],
    ["OSSの一覧・ライセンス原文を開く", "/licenses/THIRD_PARTY_NOTICES.txt", "THIRD_PARTY_NOTICES.txt"],
  ]) {
    await expect(page.getByRole("link", { name: linkName, exact: true })).toHaveAttribute("href", path);
    const response = await request.get(path);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/plain");
    const original = await readFile(new URL(`../../${source}`, import.meta.url), "utf8");
    expect((await response.text()).replaceAll("\r\n", "\n")).toBe(original.replaceAll("\r\n", "\n"));
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("licenses.png"), fullPage: true });
});
