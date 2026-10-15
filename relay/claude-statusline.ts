#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createCredentialVault } from "./credential-vault.ts";

type UnknownRecord = Record<string, unknown>;

function object(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function number(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : undefined;
}

function rateWindow(value: unknown): UnknownRecord | undefined {
  const input = object(value);
  if (!input) return undefined;
  const usedPercentage = number(input.used_percentage, 0, 100);
  const resetsAt = number(input.resets_at, 0);
  if (usedPercentage === undefined && resetsAt === undefined) return undefined;
  return {
    ...(usedPercentage !== undefined ? { used_percentage: usedPercentage } : {}),
    ...(resetsAt !== undefined ? { resets_at: resetsAt } : {}),
  };
}

export function sanitizeClaudeStatusLine(value: unknown): UnknownRecord {
  const input = object(value) ?? {};
  const rateLimits = object(input.rate_limits);
  const context = object(input.context_window);
  const current = object(context?.current_usage);
  const fiveHour = rateWindow(rateLimits?.five_hour);
  const sevenDay = rateWindow(rateLimits?.seven_day);
  const contextWindow: UnknownRecord = {};

  for (const [source, target] of [
    ["total_input_tokens", "total_input_tokens"],
    ["total_output_tokens", "total_output_tokens"],
    ["context_window_size", "context_window_size"],
    ["used_percentage", "used_percentage"],
    ["remaining_percentage", "remaining_percentage"],
  ] as const) {
    const parsed = number(
      context?.[source],
      0,
      source.endsWith("percentage") ? 100 : Number.MAX_SAFE_INTEGER,
    );
    if (parsed !== undefined) contextWindow[target] = parsed;
  }

  const currentUsage: UnknownRecord = {};
  for (const key of [
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
  ]) {
    const parsed = number(current?.[key]);
    if (parsed !== undefined) currentUsage[key] = parsed;
  }
  if (Object.keys(currentUsage).length > 0) contextWindow.current_usage = currentUsage;

  return {
    ...(fiveHour || sevenDay
      ? {
          rate_limits: {
            ...(fiveHour ? { five_hour: fiveHour } : {}),
            ...(sevenDay ? { seven_day: sevenDay } : {}),
          },
        }
      : {}),
    ...(Object.keys(contextWindow).length > 0 ? { context_window: contextWindow } : {}),
  };
}

function parseDataDirectory(): string | null {
  const index = process.argv.indexOf("--data-dir");
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value ? resolve(value) : null;
}

async function postToRelay(dataDirectory: string, payload: UnknownRecord): Promise<void> {
  const tokenPath = join(dataDirectory, "service-claude-statusline.token");
  if (!existsSync(tokenPath)) return;
  const token = readFileSync(tokenPath, "utf8").trim();
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(token)) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_500);
  try {
    await fetch("http://127.0.0.1:47831/v1/providers/claude/ingest", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch {
    // The status line must remain usable when the optional relay is offline.
  } finally {
    clearTimeout(timer);
  }
}

async function readPreviousCommand(dataDirectory: string): Promise<string | null> {
  try {
    const statePath = join(dataDirectory, "claude-statusline-state.json");
    if (!existsSync(statePath)) return null;
    const state = object(JSON.parse(readFileSync(statePath, "utf8")) as unknown);
    // A fresh installation usually has no previous status line. Avoid spawning
    // an OS vault helper on every CLI update when there is nothing to restore.
    if (state?.version === 1 && state.hadPreviousStatusLine === false) return null;
    const raw = await createCredentialVault(dataDirectory).get(
      "claude",
      "previous-statusline",
    );
    if (!raw) return null;
    const previous = object(JSON.parse(raw) as unknown);
    const command = previous?.command;
    return typeof command === "string" && command.trim() ? command : null;
  } catch {
    return null;
  }
}

async function runPrevious(command: string, input: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let output = "";
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, 2_500);
    child.stdin.on("error", () => undefined);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (output.length < 64_000) output += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on("close", () => {
      clearTimeout(timer);
      finish(output || null);
    });
    child.stdin.end(input, "utf8");
  });
}

function fallbackLine(payload: UnknownRecord): string {
  const rates = object(payload.rate_limits);
  const five = object(rates?.five_hour)?.used_percentage;
  const seven = object(rates?.seven_day)?.used_percentage;
  const parts: string[] = [];
  if (typeof five === "number") parts.push(`5時間 ${Math.round(five)}%`);
  if (typeof seven === "number") parts.push(`7日 ${Math.round(seven)}%`);
  return parts.length > 0 ? `RunMeter｜${parts.join("・")}` : "RunMeter｜利用枠を取得中";
}

export async function runClaudeStatusLine(): Promise<void> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) return;
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }
  const dataDirectory = parseDataDirectory();
  const payload = sanitizeClaudeStatusLine(input);
  const [, previousOutput] = await Promise.all([
    dataDirectory ? postToRelay(dataDirectory, payload) : Promise.resolve(),
    (async () => {
      const previousCommand = dataDirectory ? await readPreviousCommand(dataDirectory) : null;
      return previousCommand ? runPrevious(previousCommand, raw) : null;
    })(),
  ]);
  const output = previousOutput ?? `${fallbackLine(payload)}\n`;
  if (process.platform === "win32") {
    // Electron is a GUI-subsystem executable on Windows. Writing directly to
    // the inherited stdout handle keeps Claude Code's command pipe usable.
    try {
      writeFileSync(1, output, "utf8");
      return;
    } catch {
      // Fall through for terminals that expose stdout only as a Node stream.
    }
  }
  process.stdout.write(output);
}

const entryPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryPath === import.meta.url) {
  void runClaudeStatusLine();
}
