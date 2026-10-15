import { existsSync } from "node:fs";
import { join } from "node:path";

import { ClaudeSettingsManager } from "../relay/claude-settings.ts";
import {
  createCredentialVault,
  type CredentialVault,
} from "../relay/credential-vault.ts";

export async function restoreClaudeSettings(options: {
  dataDirectory: string;
  settingsPath: string;
  vault?: CredentialVault;
}): Promise<void> {
  if (!existsSync(join(options.dataDirectory, "claude-statusline-state.json")))
    return;
  const settings = new ClaudeSettingsManager({
    dataDirectory: options.dataDirectory,
    settingsPath: options.settingsPath,
    // Uninstall uses the recorded installed command and never installs this path.
    bridgeScriptPath: join(options.dataDirectory, "bridge", "index.js"),
    vault: options.vault ?? createCredentialVault(options.dataDirectory),
  });
  await settings.uninstall();
}

export async function runInstallerStartup(options: {
  arguments: string[];
  disableAutostart: () => void;
  restoreSettings: () => Promise<void>;
  onCleanupError: (error: unknown) => void;
  startSquirrel: () => Promise<boolean>;
}): Promise<boolean> {
  if (options.arguments.includes("--squirrel-uninstall")) {
    try {
      options.disableAutostart();
    } catch (error) {
      options.onCleanupError(error);
    }
    try {
      await options.restoreSettings();
    } catch (error) {
      // A conflict or unreadable backup must preserve the user's current settings.
      options.onCleanupError(error);
    }
  }
  // Importing electron-squirrel-startup has immediate side effects, including
  // app.quit(). Do not start it until the asynchronous restoration has finished.
  return options.startSquirrel();
}
