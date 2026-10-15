import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function defaultDataDirectory(): string {
  if (process.env.RUNMETER_DATA_DIR) return resolve(process.env.RUNMETER_DATA_DIR);
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    return localAppData ? join(localAppData, "RunMeter") : join(homedir(), "AppData", "Local", "RunMeter");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "RunMeter");
  }
  const stateHome = process.env.XDG_STATE_HOME;
  return stateHome ? join(stateHome, "runmeter") : join(homedir(), ".local", "state", "runmeter");
}

export function defaultClaudeSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}
