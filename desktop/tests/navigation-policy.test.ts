import assert from "node:assert/strict";
import test from "node:test";
import {
  canGrantPermission,
  isAllowedExternalUrl,
  isTrustedAppUrl,
} from "../navigation-policy.ts";

test("only the HTTPS app origin may render in the desktop window", () => {
  assert.equal(isTrustedAppUrl("https://run-meter.vercel.app/#alerts"), true);
  for (const url of [
    "http://run-meter.vercel.app/",
    "https://run-meter.vercel.app.attacker.test/",
    "https://run-meter.vercel.app@attacker.test/",
    "https://user:password@run-meter.vercel.app/",
    "https://run-meter.vercel.app:444/",
    "file:///C:/Windows/System32/cmd.exe",
    "javascript:alert(1)",
  ])
    assert.equal(isTrustedAppUrl(url), false, url);
});

test("external links allow official sign-in, usage, developer and app guide URLs", () => {
  for (const url of [
    "https://auth.openai.com/oauth/authorize?state=example",
    "https://chatgpt.com/codex/settings/usage",
    "https://claude.ai/settings/usage",
    "https://cybereye-tech.jp/",
    "https://run-meter.vercel.app/guide",
  ])
    assert.equal(isAllowedExternalUrl(url), true, url);
  for (const url of [
    "file:///C:/Windows/System32/cmd.exe",
    "ms-settings:privacy",
    "https://attacker.test/",
    "https://auth.openai.com.attacker.test/",
    "https://github.com/example/RunMeter",
    "https://user:password@chatgpt.com/",
    "https://chatgpt.com:444/",
  ])
    assert.equal(isAllowedExternalUrl(url), false, url);
});

test("clipboard writes only work in the trusted top-level app; reads stay denied", () => {
  const app = "https://run-meter.vercel.app/";
  assert.equal(
    canGrantPermission("clipboard-sanitized-write", app, true, app),
    true,
  );
  assert.equal(canGrantPermission("clipboard-read", app, true, app), false);
  assert.equal(
    canGrantPermission("clipboard-sanitized-write", app, false, app),
    false,
  );
  assert.equal(
    canGrantPermission(
      "clipboard-sanitized-write",
      "https://attacker.test",
      true,
      app,
    ),
    false,
  );
  assert.equal(
    canGrantPermission(
      "clipboard-sanitized-write",
      app,
      true,
      "https://attacker.test",
    ),
    false,
  );
  assert.equal(canGrantPermission("media", app, true, app), false);
});
