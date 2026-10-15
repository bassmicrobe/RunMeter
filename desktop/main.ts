import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  nativeImage,
  session,
  shell,
  Tray,
  type MessageBoxOptions,
  type MessageBoxReturnValue,
} from "electron";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  defaultClaudeSettingsPath,
  defaultDataDirectory,
} from "../relay/core/paths.ts";
import { RELAY_HOST, RELAY_PORT } from "../relay/http-server.ts";
import { createDefaultRelay } from "../relay/server.ts";
import {
  APP_URL,
  canGrantPermission,
  isAllowedExternalUrl,
  isTrustedAppUrl,
} from "./navigation-policy.ts";
import { restoreClaudeSettings, runInstallerStartup } from "./installer.ts";

const APP_USER_MODEL_ID = "com.squirrel.RunMeterDesktop.RunMeter";
const HIDDEN_FLAG = "--hidden";
const NO_AUTO_START_FLAG = "--no-auto-start";
const BUNDLE_DIRECTORY = dirname(fileURLToPath(import.meta.url));

type RelayRuntime = ReturnType<typeof createDefaultRelay>;

interface DesktopPreferences {
  version: 1;
  openAtLogin: boolean;
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let relay: RelayRuntime | null = null;
let quitting = false;
let shutdownStarted = false;
let shutdownComplete = false;

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "不明なエラー").slice(
    0,
    500,
  );
}

function assetPath(name: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, "assets", name)
    : resolve(BUNDLE_DIRECTORY, "..", "..", "assets", name);
}

function installClaudeBridgeRuntime(dataDirectory: string): {
  executablePath: string;
  scriptPath: string;
} {
  const sourceDirectory = app.isPackaged
    ? join(process.resourcesPath, "bridge")
    : resolve(BUNDLE_DIRECTORY, "..", "bridge");
  const runtimeMetadata = JSON.parse(
    readFileSync(join(sourceDirectory, "runtime.json"), "utf8"),
  ) as { nodeVersion?: unknown };
  if (
    typeof runtimeMetadata.nodeVersion !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(runtimeMetadata.nodeVersion)
  ) {
    throw new Error("同梱されたClaude連携ランタイムを確認できません。");
  }

  const targetDirectory = join(
    dataDirectory,
    "bridge",
    `node-v${runtimeMetadata.nodeVersion}`,
  );
  mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
  for (const name of [
    "index.js",
    "package.json",
    "runtime.json",
    "NODE-LICENSE.txt",
  ]) {
    copyFileSync(join(sourceDirectory, name), join(targetDirectory, name));
  }
  const executablePath = join(targetDirectory, "node.exe");
  if (!existsSync(executablePath)) {
    copyFileSync(join(sourceDirectory, "node.exe"), executablePath);
  }
  return {
    executablePath,
    scriptPath: join(targetDirectory, "index.js"),
  };
}

function preferencesPath(): string {
  return join(app.getPath("userData"), "desktop-preferences.json");
}

function readPreferences(): DesktopPreferences | null {
  const path = preferencesPath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    if (raw.length > 16_384) return null;
    const parsed = JSON.parse(raw) as Partial<DesktopPreferences>;
    return parsed.version === 1 && typeof parsed.openAtLogin === "boolean"
      ? { version: 1, openAtLogin: parsed.openAtLogin }
      : null;
  } catch {
    return null;
  }
}

function writePreferences(preferences: DesktopPreferences): void {
  const path = preferencesPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(preferences, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

function loginLauncherPath(): string {
  if (!app.isPackaged || process.platform !== "win32") return process.execPath;
  const versionDirectory = dirname(process.execPath);
  return resolve(versionDirectory, "..", basename(process.execPath));
}

function applyOpenAtLogin(openAtLogin: boolean): void {
  if (process.platform !== "win32" || !app.isPackaged) return;
  app.setLoginItemSettings({
    openAtLogin,
    path: loginLauncherPath(),
    args: [HIDDEN_FLAG],
    enabled: openAtLogin,
    name: "RunMeter",
  });
}

function setOpenAtLogin(openAtLogin: boolean): void {
  applyOpenAtLogin(openAtLogin);
  writePreferences({ version: 1, openAtLogin });
  rebuildTrayMenu();
}

function configureOpenAtLogin(): void {
  if (!app.isPackaged || process.argv.includes(NO_AUTO_START_FLAG)) return;
  const preferences = readPreferences();
  if (preferences) {
    applyOpenAtLogin(preferences.openAtLogin);
    return;
  }
  // Relay is useful only while running, so a fresh desktop install starts it
  // silently with Windows. Users can disable this from the tray menu.
  setOpenAtLogin(true);
}

function openExternalHttps(value: string): void {
  if (!isAllowedExternalUrl(value)) return;
  void shell.openExternal(value).catch(() => {
    dialog.showErrorBox(
      "ブラウザーを開けませんでした",
      "既定のブラウザーの設定を確認してください。",
    );
  });
}

function showMessageBox(
  options: MessageBoxOptions,
): Promise<MessageBoxReturnValue> {
  return mainWindow
    ? dialog.showMessageBox(mainWindow, options)
    : dialog.showMessageBox(options);
}

async function showPairingCode(): Promise<void> {
  if (!relay) {
    await showMessageBox({
      type: "warning",
      title: "Relayを確認できません",
      message: "RunMeter Relayは別のプロセスで起動しています",
      detail:
        "すでにターミナル版Relayを起動している場合は、そちらに表示されたペアリングコードを使用してください。",
      buttons: ["閉じる"],
    });
    return;
  }

  const status = relay.pairing.getPairingCode();
  if (!status.available || !status.code) {
    await showMessageBox({
      type: "warning",
      title: "ペアリングを一時停止しています",
      message: "1分ほど待ってから、もう一度お試しください",
      buttons: ["閉じる"],
    });
    return;
  }

  const result = await showMessageBox({
    type: "info",
    title: "RunMeter ペアリングコード",
    message: status.code,
    detail:
      "RunMeter画面でCodexまたはClaudeの「接続」を押し、この6桁コードを入力してください。コードは5分間・1回だけ有効です。",
    buttons: ["コードをコピー", "閉じる"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (result.response === 0) clipboard.writeText(status.code);
}

function showMainWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function rebuildTrayMenu(): void {
  if (!tray) return;
  const openAtLogin = readPreferences()?.openAtLogin ?? false;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "RunMeterを開く",
        click: showMainWindow,
      },
      {
        label: "画面を再読み込み",
        click: () => {
          if (mainWindow) void loadMainPage(mainWindow);
          showMainWindow();
        },
      },
      {
        label: "ペアリングコードを表示",
        click: () => void showPairingCode(),
      },
      { type: "separator" },
      {
        label: "Windowsログイン時に起動",
        type: "checkbox",
        enabled: app.isPackaged,
        checked: openAtLogin,
        click: (item) => setOpenAtLogin(item.checked),
      },
      { type: "separator" },
      {
        label: "終了",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function createTray(): void {
  const icon = nativeImage.createFromPath(assetPath("runmeter.png"));
  tray = new Tray(icon.resize({ width: 20, height: 20 }));
  tray.setToolTip("RunMeter");
  tray.on("click", showMainWindow);
  rebuildTrayMenu();
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 390,
    minHeight: 620,
    show: false,
    title: "RunMeter",
    icon: assetPath("runmeter.png"),
    backgroundColor: "#090d12",
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalHttps(url);
    return { action: "deny" };
  });
  window.webContents.on("will-frame-navigate", (event) => {
    if (event.isMainFrame && isTrustedAppUrl(event.url)) {
      event.preventDefault();
      void loadMainPage(window);
      return;
    }
    event.preventDefault();
    if (event.isMainFrame) openExternalHttps(event.url);
  });
  window.webContents.on("will-redirect", (event) => {
    if (event.isMainFrame && isTrustedAppUrl(event.url)) return;
    event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  window.webContents.session.on("will-download", (event) =>
    event.preventDefault(),
  );
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    window.hide();
  });
  window.on("closed", () => {
    mainWindow = null;
  });
  window.once("ready-to-show", () => {
    if (!process.argv.includes(HIDDEN_FLAG)) window.show();
  });

  void loadMainPage(window);
  return window;
}

async function loadMainPage(window: BrowserWindow): Promise<void> {
  if (window.isDestroyed() || quitting) return;
  try {
    await window.loadURL(APP_URL);
  } catch (error) {
    if (window.isDestroyed() || quitting) return;
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ERR_ABORTED"
    )
      return;
    await window.loadFile(assetPath("offline.html")).catch(() => {
      dialog.showErrorBox(
        "画面を読み込めませんでした",
        "インターネット接続を確認し、通知領域メニューの「画面を再読み込み」を選んでください。",
      );
    });
  }
}

async function startRelay(): Promise<void> {
  const dataDirectory = defaultDataDirectory();
  const bridge = installClaudeBridgeRuntime(dataDirectory);
  const runtime = createDefaultRelay({
    claudeBridgeExecutablePath: bridge.executablePath,
    claudeBridgeScriptPath: bridge.scriptPath,
  });
  try {
    await runtime.httpServer.start();
    relay = runtime;
  } catch (error) {
    await runtime.registry.dispose().catch(() => undefined);
    runtime.store.close();
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    if (code === "EADDRINUSE") {
      try {
        const response = await fetch(
          `http://${RELAY_HOST}:${RELAY_PORT}/v1/health`,
          {
            signal: AbortSignal.timeout(2_000),
            redirect: "error",
          },
        );
        const health = (await response.json()) as {
          ok?: unknown;
          service?: unknown;
        };
        if (
          response.ok &&
          health.ok === true &&
          health.service === "RunMeter Relay"
        )
          return;
      } catch {
        // A port occupied by another app must not be mistaken for our Relay.
      }
      throw new Error(
        `接続ポート ${RELAY_PORT} を別のアプリが使用しています。使用中のアプリを終了してからRunMeterを起動してください。`,
      );
    }
    throw error;
  }
}

async function stopRelay(): Promise<void> {
  const runtime = relay;
  relay = null;
  if (!runtime) return;
  await runtime.httpServer.close().catch(() => undefined);
  await runtime.registry.dispose().catch(() => undefined);
  runtime.store.close();
}

function scheduleFirstRunPairing(): void {
  if (!relay || !mainWindow || process.argv.includes(HIDDEN_FLAG)) return;
  const marker = join(relay.dataDirectory, "desktop-onboarding-v1");
  if (existsSync(marker)) return;
  const window = mainWindow;
  const showWhenReady = () => {
    if (!isTrustedAppUrl(window.webContents.getURL())) return;
    window.webContents.removeListener("did-finish-load", showWhenReady);
    void showPairingCode()
      .then(() => {
        writeFileSync(marker, `${new Date().toISOString()}\n`, "utf8");
      })
      .catch(() => undefined);
  };
  window.webContents.on("did-finish-load", showWhenReady);
}

async function runDesktop(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  app.setAppUserModelId(APP_USER_MODEL_ID);
  app.on("second-instance", showMainWindow);
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("window-all-closed", () => {
    // Keep Relay available from the notification area.
  });

  await app.whenReady();
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) =>
      callback(
        canGrantPermission(
          permission,
          details.requestingUrl,
          details.isMainFrame,
          webContents.getURL(),
        ),
      ),
  );
  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin, details) =>
      canGrantPermission(
        permission,
        details.requestingUrl ?? requestingOrigin,
        details.isMainFrame,
        webContents?.getURL() ?? "",
      ),
  );

  configureOpenAtLogin();
  await startRelay();
  createTray();
  mainWindow = createMainWindow();
  scheduleFirstRunPairing();

  app.on("activate", () => {
    if (!mainWindow) mainWindow = createMainWindow();
    showMainWindow();
  });
}

async function bootstrap(): Promise<void> {
  try {
    const installerHandled = await runInstallerStartup({
      arguments: process.argv,
      disableAutostart: () => applyOpenAtLogin(false),
      restoreSettings: () =>
        restoreClaudeSettings({
          dataDirectory: defaultDataDirectory(),
          settingsPath: defaultClaudeSettingsPath(),
        }),
      onCleanupError: (error) => {
        try {
          const directory = defaultDataDirectory();
          mkdirSync(directory, { recursive: true, mode: 0o700 });
          writeFileSync(
            join(directory, "desktop-uninstall-warning.json"),
            JSON.stringify(
              {
                at: new Date().toISOString(),
                message: errorMessage(error),
              },
              null,
              2,
            ),
            { encoding: "utf8", mode: 0o600 },
          );
        } catch {
          // Uninstall may run after profile access has been revoked. Do not
          // overwrite Claude settings or stop removal of the application.
        }
      },
      startSquirrel: async () =>
        (await import("electron-squirrel-startup")).default,
    });
    if (installerHandled) return;
    await runDesktop();
  } catch (error) {
    await dialog.showErrorBox(
      "RunMeterを起動できませんでした",
      errorMessage(error),
    );
    app.quit();
  }
}

app.on("will-quit", (event) => {
  if (shutdownComplete || (!relay && !shutdownStarted)) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  // Electron does not await async event listeners. Keep the process alive until
  // the HTTP server, Codex child process and SQLite connection have closed.
  const fallback = setTimeout(() => app.exit(0), 5_000);
  void stopRelay().finally(() => {
    clearTimeout(fallback);
    shutdownComplete = true;
    // All windows already closed before will-quit. Finish after cleanup without
    // re-entering Electron's cancelled quit sequence.
    app.exit(0);
  });
});

void bootstrap();
