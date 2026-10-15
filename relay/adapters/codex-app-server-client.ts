import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, extname, isAbsolute, join } from "node:path";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";

type RpcParams = Record<string, unknown> | undefined;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(reason: Error): void;
  timer: NodeJS.Timeout;
}

interface RpcMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
}

export type CodexNotificationListener = (method: string, params: unknown) => void;

export interface CodexRpcClient {
  request(method: string, params?: RpcParams, timeoutMs?: number): Promise<unknown>;
  onNotification(listener: CodexNotificationListener): () => void;
  close(): Promise<void>;
}

export class CodexRpcError extends Error {
  readonly code: number | null;

  constructor(message: string, code: number | null = null) {
    super(redact(message));
    this.name = "CodexRpcError";
    this.code = code;
  }
}

function redact(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]")
    .replace(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "[redacted-jwt]")
    .slice(0, 1_000);
}

interface CodexInvocation {
  command: string;
  leadingArgs: string[];
}

type SpawnCodexProcess = (command: string, args: string[]) => ChildProcessWithoutNullStreams;

function resolveNodeExecutable(): string | null {
  const executableName = process.platform === "win32" ? "node.exe" : "node";
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const normalized = directory.replace(/^"|"$/g, "");
    if (!normalized) continue;
    const candidate = join(normalized, executableName);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveWindowsCodexInvocation(command: string): CodexInvocation {
  if (process.platform !== "win32") return { command, leadingArgs: [] };

  const candidates: string[] = [];
  const hasPath = isAbsolute(command) || command.includes("\\") || command.includes("/");
  if (hasPath) {
    candidates.push(command);
    if (!extname(command)) candidates.push(`${command}.exe`, `${command}.cmd`);
  } else {
    for (const directory of (process.env.PATH ?? "").split(delimiter)) {
      const normalized = directory.replace(/^"|"$/g, "");
      if (!normalized) continue;
      candidates.push(
        join(normalized, `${command}.exe`),
        join(normalized, `${command}.cmd`),
        join(normalized, command),
      );
    }
  }

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    if (extname(candidate).toLowerCase() === ".exe") {
      return { command: candidate, leadingArgs: [] };
    }
    const codexScript = join(
      dirname(candidate),
      "node_modules",
      "@openai",
      "codex",
      "bin",
      "codex.js",
    );
    if (existsSync(codexScript)) {
      const nodeExecutable = resolveNodeExecutable();
      if (!nodeExecutable) {
        throw new CodexRpcError(
          "Codex CLI was found, but its Node.js runtime is not available on PATH.",
        );
      }
      return { command: nodeExecutable, leadingArgs: [codexScript] };
    }
  }
  return { command, leadingArgs: [] };
}

export class CodexAppServerClient implements CodexRpcClient {
  readonly #listeners = new Set<CodexNotificationListener>();
  readonly #pending = new Map<number, PendingRequest>();
  readonly #command: string;
  readonly #spawnProcess: SpawnCodexProcess;
  readonly #initializeTimeoutMs: number;
  #nextId = 1;
  #process: ChildProcessWithoutNullStreams | null = null;
  #readline: ReadLineInterface | null = null;
  #startPromise: Promise<void> | null = null;
  #initialized = false;
  #closePromise: Promise<void> | null = null;
  #lastStderr = "";

  constructor(command = "codex", options: {
    spawnProcess?: SpawnCodexProcess;
    initializeTimeoutMs?: number;
  } = {}) {
    this.#command = command;
    this.#spawnProcess = options.spawnProcess ?? ((executable, args) => spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    }));
    this.#initializeTimeoutMs = options.initializeTimeoutMs ?? 15_000;
  }

  async request(
    method: string,
    params?: RpcParams,
    timeoutMs = 15_000,
  ): Promise<unknown> {
    await this.#start();
    return this.#requestRaw(method, params, timeoutMs);
  }

  onNotification(listener: CodexNotificationListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#initialized = false;
    this.#startPromise = null;
    this.#readline?.close();
    this.#readline = null;

    const child = this.#process;
    this.#process = null;
    this.#rejectPending(new CodexRpcError("Codex app-server was closed."));
    const closing = this.#stopProcess(child);
    this.#closePromise = closing;
    try {
      await closing;
    } finally {
      if (this.#closePromise === closing) this.#closePromise = null;
    }
  }

  async #stopProcess(child: ChildProcessWithoutNullStreams | null): Promise<void> {
    if (child && child.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill();
          resolve();
        }, 1_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        child.stdin.end();
      });
    }
  }

  async #start(): Promise<void> {
    if (this.#closePromise) await this.#closePromise;
    if (this.#initialized && this.#process?.exitCode === null) return;
    if (this.#startPromise) return this.#startPromise;

    const startup = (async () => {
      this.#lastStderr = "";
      const invocation = resolveWindowsCodexInvocation(this.#command);
      const child = this.#spawnProcess(
        invocation.command,
        [...invocation.leadingArgs, "app-server", "--listen", "stdio://"],
      );
      this.#process = child;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        if (this.#process !== child) return;
        this.#lastStderr = redact(`${this.#lastStderr}${chunk}`).slice(-1_000);
      });
      child.on("error", (error) => this.#handleExit(error, child));
      child.stdin.on("error", (error) => this.#handleExit(error, child));
      child.on("exit", (code) => {
        if (this.#process === child) {
          const detail = this.#lastStderr ? ` ${this.#lastStderr}` : "";
          this.#handleExit(
            new CodexRpcError(`Codex app-server exited (${code ?? "unknown"}).${detail}`), child,
          );
        }
      });

      this.#readline = createInterface({ input: child.stdout, crlfDelay: Infinity });
      this.#readline.on("line", (line) => {
        if (this.#process === child) this.#handleLine(line);
      });

      try {
        await this.#requestRaw(
          "initialize",
          {
            clientInfo: {
              name: "runmeter",
              title: "RunMeter",
              version: "0.1.0",
            },
          },
          this.#initializeTimeoutMs,
        );
        if (this.#process !== child) throw new CodexRpcError("Codex app-server was closed.");
        this.#send({ method: "initialized", params: {} });
        this.#initialized = true;
      } catch (error) {
        if (this.#process === child) await this.close();
        throw error;
      }
    })();
    this.#startPromise = startup;

    try {
      await startup;
    } finally {
      if (this.#startPromise === startup) this.#startPromise = null;
    }
  }

  #requestRaw(method: string, params: RpcParams, timeoutMs: number): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CodexRpcError(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#send({ id, method, ...(params ? { params } : {}) });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error("Failed to write Codex request"));
      }
    });
  }

  #send(message: RpcMessage): void {
    const child = this.#process;
    if (!child || child.exitCode !== null || child.stdin.destroyed) {
      throw new CodexRpcError("Codex app-server is not running.");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
  }

  #handleLine(line: string): void {
    if (!line || line.length > 2_000_000) return;
    let message: RpcMessage;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      message = parsed as RpcMessage;
    } catch {
      return;
    }

    if (typeof message.id === "number" && !message.method) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(
          new CodexRpcError(
            typeof message.error.message === "string" ? message.error.message : "Codex app-server request failed.",
            typeof message.error.code === "number" ? message.error.code : null,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method === "string" && typeof message.id === "number") {
      // No server-initiated request capabilities are enabled. Reply instead of
      // allowing app-server to wait for a response that can never arrive.
      this.#send({
        id: message.id,
        error: { code: -32601, message: "Method not supported by RunMeter" },
      });
      return;
    }

    if (typeof message.method === "string") {
      for (const listener of this.#listeners) {
        try {
          listener(message.method, message.params);
        } catch {
          // Adapter notification handlers are isolated from the transport.
        }
      }
    }
  }

  #handleExit(error: Error, child: ChildProcessWithoutNullStreams): void {
    if (this.#process !== child) return;
    this.#initialized = false;
    this.#startPromise = null;
    this.#process = null;
    this.#readline?.close();
    this.#readline = null;
    this.#rejectPending(error);
    if (child.exitCode === null) child.kill();
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
