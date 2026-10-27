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
  type NativeImage,
} from "electron";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
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
import { mergeMacPath, readLoginShellOutput } from "./shell-path.ts";

const APP_USER_MODEL_ID = "com.squirrel.RunMeterDesktop.RunMeter";
const HIDDEN_FLAG = "--hidden";
const NO_AUTO_START_FLAG = "--no-auto-start";
const BUNDLE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const IS_MAC = process.platform === "darwin";
// Where the resident icon lives, as users call it on each platform.
const TRAY_AREA = IS_MAC ? "メニューバー" : "通知領域";
const BRIDGE_NODE_NAME = process.platform === "win32" ? "node.exe" : "node";

type RelayRuntime = ReturnType<typeof createDefaultRelay>;

interface DesktopPreferences {
  version: 1;
  openAtLogin: boolean;
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let relay: RelayRuntime | null = null;
let quitting = false;
let startHidden = process.argv.includes(HIDDEN_FLAG);
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
  const executablePath = join(targetDirectory, BRIDGE_NODE_NAME);
  if (!existsSync(executablePath)) {
    copyFileSync(join(sourceDirectory, BRIDGE_NODE_NAME), executablePath);
    if (process.platform !== "win32") chmodSync(executablePath, 0o755);
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
  if (!app.isPackaged) return;
  if (IS_MAC) {
    // macOS registers the app bundle itself; launch arguments are not passed,
    // so a login launch is detected with wasOpenedAtLogin instead.
    app.setLoginItemSettings({ openAtLogin });
    return;
  }
  if (process.platform !== "win32") return;
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
  // silently at login. Users can disable this from the tray menu.
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
  // The Dock icon is shown only while the window is open, like other
  // menu-bar apps; Relay keeps running from the menu bar.
  if (IS_MAC) void app.dock?.show();
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
        label: IS_MAC ? "ログイン時に起動" : "Windowsログイン時に起動",
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

function trayIcon(): NativeImage {
  if (!IS_MAC) {
    return nativeImage
      .createFromPath(assetPath("runmeter.png"))
      .resize({ width: 20, height: 20 });
  }
  // The @2x file next to it is loaded automatically for Retina displays.
  const icon = nativeImage.createFromPath(assetPath("runmeterTemplate.png"));
  icon.setTemplateImage(true);
  return icon;
}

function createTray(): void {
  tray = new Tray(trayIcon());
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
    if (IS_MAC) app.dock?.hide();
  });
  window.on("closed", () => {
    mainWindow = null;
  });
  window.once("ready-to-show", () => {
    if (!startHidden) window.show();
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
        `インターネット接続を確認し、${TRAY_AREA}のRunMeterメニューから「画面を再読み込み」を選んでください。`,
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
  if (!relay || !mainWindow || startHidden) return;
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

// A Mac app opened from Downloads runs from a randomized read-only copy
// (App Translocation), which would also break the login item. Returns true when
// the app is relaunching from /Applications.
function offerMoveToApplications(): boolean {
  if (app.isInApplicationsFolder()) return false;
  const response = dialog.showMessageBoxSync({
    type: "question",
    title: "RunMeter",
    message: "RunMeterを「アプリケーション」フォルダーへ移動しますか？",
    detail:
      "ログイン時の自動起動とClaude連携を安定して使うため、アプリケーションフォルダーからの起動をおすすめします。移動後、RunMeterが再起動します。",
    buttons: ["移動する", "今は移動しない"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return false;
  try {
    return app.moveToApplicationsFolder();
  } catch (error) {
    dialog.showErrorBox("移動できませんでした", errorMessage(error));
    return false;
  }
}

async function runDesktop(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  if (process.platform === "win32") app.setAppUserModelId(APP_USER_MODEL_ID);
  app.on("second-instance", showMainWindow);
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("window-all-closed", () => {
    // Keep Relay available from the notification area.
  });

  const shellOutput =
    IS_MAC && app.isPackaged
      ? readLoginShellOutput(process.env.SHELL)
      : Promise.resolve(null);
  await app.whenReady();
  if (IS_MAC && app.isPackaged) {
    if (offerMoveToApplications()) return;
    process.env.PATH = mergeMacPath({
      currentPath: process.env.PATH,
      shellOutput: await shellOutput,
      home: homedir(),
    });
    if (app.getLoginItemSettings().wasOpenedAtLogin) startHidden = true;
  }
  if (IS_MAC && startHidden) app.dock?.hide();
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
