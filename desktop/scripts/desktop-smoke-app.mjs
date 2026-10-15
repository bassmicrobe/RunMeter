import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { app, dialog, session } from "electron";

if (
  !process.env.RUNMETER_SMOKE_USER_DATA ||
  !process.env.RUNMETER_DATA_DIR ||
  !process.env.RUNMETER_SMOKE_RESULT
) {
  throw new Error("This harness requires isolated temporary directories.");
}
app.setName("RunMeterReleaseAudit");
app.setPath("userData", process.env.RUNMETER_SMOKE_USER_DATA);
const record = (result) =>
  writeFileSync(process.env.RUNMETER_SMOKE_RESULT, JSON.stringify(result));
record({ phase: "loaded" });
let tested = false;
let failure = null;
let quitWasDeferred = false;
dialog.showErrorBox = (title, content) => {
  record({ failure: `${title}: ${content}` });
  app.exit(1);
};

async function runSmoke() {
  await app.whenReady();
  record({ phase: "ready" });
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ["https://run-meter.vercel.app/*"] },
    (_details, callback) => callback({ cancel: true }),
  );
  app.on("browser-window-created", (_event, window) => {
    record({ phase: "window-created" });
    window.webContents.on("did-finish-load", () => {
      record({ phase: "page-loaded", url: window.webContents.getURL() });
      if (tested || !window.webContents.getURL().endsWith("offline.html"))
        return;
      tested = true;
      void (async () => {
        const preferences = window.webContents.getLastWebPreferences();
        assert.equal(preferences.nodeIntegration, false);
        assert.equal(preferences.contextIsolation, true);
        assert.equal(preferences.sandbox, true);
        assert.equal(preferences.webSecurity, true);
        assert.equal(window.isVisible(), false);
        record({ phase: "preferences-checked" });
        const content = await window.webContents.executeJavaScript(
          "document.body.textContent",
        );
        assert.match(content, /もう一度読み込む/);
        record({ phase: "offline-content-checked" });
        const health = await fetch("http://127.0.0.1:47831/v1/health").then(
          (response) => response.json(),
        );
        assert.equal(health.service, "RunMeter Relay");
        record({ phase: "relay-checked" });
        await window.webContents.executeJavaScript(
          "location.href = 'https://untrusted.runmeter-test.invalid/'; undefined;",
        );
        await new Promise((accept) => setTimeout(accept, 100));
        assert.ok(
          window.webContents.getURL().endsWith("offline.html"),
          "An untrusted navigation escaped the desktop window",
        );
      })()
        .catch((error) => {
          failure = error.message;
        })
        .finally(() => {
          record({ phase: "quitting", failure });
          app.quit();
        });
    });
  });

  await import("../dist/main/index.js");
  app.on("will-quit", (event) => {
    if (event.defaultPrevented) quitWasDeferred = true;
    record({ phase: "will-quit", quitWasDeferred, failure });
  });
  app.on("quit", () => {
    const passed = tested && !failure && quitWasDeferred;
    record({ passed, offlinePage: tested, quitWasDeferred, failure });
    if (!passed) process.exitCode = 1;
  });
}

void runSmoke().catch((error) => {
  record({ failure: error.stack ?? error.message });
  app.exit(1);
});
