import { execFile } from "node:child_process";
import { posix } from "node:path";

const { isAbsolute, join } = posix;

const PATH_MARKER = "__RUNMETER_PATH__";
const SHELL_TIMEOUT_MS = 5_000;

// Finder and login items start macOS apps with only the system PATH, so a
// Codex CLI from Homebrew, npm or a version manager is not found. The login
// shell's PATH comes first; common install locations and the Codex desktop
// app's bundled CLI follow as fallbacks.
export function mergeMacPath(options: {
  currentPath: string | undefined;
  shellOutput: string | null;
  home: string;
}): string {
  const shellPath =
    options.shellOutput?.match(
      new RegExp(`${PATH_MARKER}([^\\n]*)${PATH_MARKER}`),
    )?.[1] ?? "";
  const fallback = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(options.home, ".local", "bin"),
    join(options.home, ".npm-global", "bin"),
    join(options.home, ".volta", "bin"),
    "/Applications/Codex.app/Contents/Resources",
  ];
  const entries = [
    ...shellPath.split(":"),
    ...(options.currentPath ?? "").split(":"),
    ...fallback,
  ].filter((entry) => entry && isAbsolute(entry));
  return [...new Set(entries)].join(":");
}

export function readLoginShellOutput(shell: string | undefined): Promise<string | null> {
  const executable = shell && isAbsolute(shell) ? shell : "/bin/zsh";
  return new Promise((resolve) => {
    execFile(
      executable,
      ["-ilc", `printf '${PATH_MARKER}%s${PATH_MARKER}' "$PATH"`],
      {
        encoding: "utf8",
        timeout: SHELL_TIMEOUT_MS,
        env: { ...process.env, DISABLE_AUTO_UPDATE: "true" },
      },
      // A slow or broken shell profile falls back to the common locations.
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
}
