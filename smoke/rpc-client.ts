import { type ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export interface RpcMessage {
  type: string;
  [key: string]: unknown;
}

export interface RpcResponse extends RpcMessage {
  type: "response";
  command: string;
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

/** Carries the tail of the message log, so a hang is diagnosable from the failure alone. */
export class SmokeTimeout extends Error {
  constructor(
    label: string,
    ms: number,
    readonly recent: RpcMessage[],
  ) {
    super(`timed out after ${ms}ms waiting for ${label}`);
    this.name = "SmokeTimeout";
  }
}

interface Waiter {
  match: (message: RpcMessage) => boolean;
  settle: (message: RpcMessage, index: number) => void;
  fail: (err: Error) => void;
}

/** How much of the message log a timeout dump prints. */
const DUMP_TAIL = 40;

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

export interface RpcClientOptions {
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  log: (line: string) => void;
}

/**
 * Minimal RPC driver for `pi --mode rpc`.
 *
 * Framing is LF-only by hand: Node's `readline` also splits on U+2028/U+2029,
 * which are valid inside JSON strings and therefore corrupt the stream (rpc.md).
 *
 * Every inbound message lands in an append-only log, and waits are expressed as
 * "from cursor N". A live-only listener would drop an event that arrived between
 * two awaits — which is exactly what a round-start status does while the caller
 * is still reading the filesystem.
 */
export class RpcClient {
  readonly messages: RpcMessage[] = [];
  readonly uiRequests: RpcMessage[] = [];
  stderr = "";

  private readonly child: ChildProcess;
  private readonly decoder = new StringDecoder("utf8");
  private readonly waiters = new Set<Waiter>();
  private readonly pending = new Map<string, { resolve: (r: RpcResponse) => void; reject: (e: Error) => void }>();
  /** Responses that landed before anyone awaited them — a `notify` then `await` gap is otherwise a lost reply. */
  private readonly received = new Map<string, RpcResponse>();
  private readonly log: (line: string) => void;
  private buffer = "";
  private seq = 0;
  private exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;

  constructor(opts: RpcClientOptions) {
    this.log = opts.log;
    this.child = spawn("pi", opts.args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      // Process-group leader, so teardown can signal the whole tree rather than
      // just the wrapper (lifecycle guide, Rule 3).
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout?.on("data", (chunk: Buffer) => this.onChunk(chunk));
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
    });
    this.child.on("exit", (code, signal) => {
      this.exit = { code, signal };
      const err = new Error(`pi exited (code ${code}, signal ${signal})`);
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
      for (const w of this.waiters) w.fail(err);
      this.waiters.clear();
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get hasExited(): boolean {
    return this.exit !== undefined;
  }

  private onChunk(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl === -1) break;
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.trim().length === 0) continue;
      let message: RpcMessage;
      try {
        message = JSON.parse(line) as RpcMessage;
      } catch {
        this.log(`  ! unparseable stdout line: ${line.slice(0, 200)}`);
        continue;
      }
      this.ingest(message);
    }
  }

  private ingest(message: RpcMessage): void {
    const index = this.messages.length;
    this.messages.push(message);

    if (message.type === "response") {
      const response = message as RpcResponse;
      const id = typeof message["id"] === "string" ? message["id"] : undefined;
      if (id !== undefined) {
        const waiting = this.pending.get(id);
        if (waiting === undefined) this.received.set(id, response);
        else {
          this.pending.delete(id);
          waiting.resolve(response);
        }
      }
      if (!response.success) this.log(`  ! ${response.command} failed: ${response.error ?? "(no error text)"}`);
    }

    if (message.type === "extension_ui_request") this.onUiRequest(message);
    if (message.type === "extension_error") {
      this.log(`  ! extension_error (${String(message["event"])}): ${String(message["error"])}`);
    }

    for (const waiter of [...this.waiters]) {
      if (!waiter.match(message)) continue;
      this.waiters.delete(waiter);
      waiter.settle(message, index);
    }
  }

  private onUiRequest(message: RpcMessage): void {
    this.uiRequests.push(message);
    const method = String(message["method"]);
    if (method === "setStatus") {
      const text = message["statusText"];
      this.log(`  ui setStatus[${String(message["statusKey"])}] ${text === undefined ? "(cleared)" : String(text)}`);
      return;
    }
    if (!DIALOG_METHODS.has(method)) {
      this.log(`  ui ${method}: ${JSON.stringify(message).slice(0, 200)}`);
      return;
    }
    // Dialogs block the extension until answered. Take the affirmative branch so
    // an unexpected prompt cannot wedge the run, and log it loudly enough that a
    // dialog nobody expected is visible in the transcript.
    const id = String(message["id"]);
    const options = message["options"];
    const answer =
      method === "confirm"
        ? { type: "extension_ui_response", id, confirmed: true }
        : method === "select"
          ? { type: "extension_ui_response", id, value: Array.isArray(options) ? options[0] : undefined }
          : { type: "extension_ui_response", id, value: "" };
    this.log(`  ui ${method} auto-answered: ${JSON.stringify(answer)}`);
    this.write(answer);
  }

  private write(payload: unknown): void {
    this.child.stdin?.write(`${JSON.stringify(payload)}\n`);
  }

  /** Cursor into the message log; pass to waitFrom so no event can be missed. */
  mark(): number {
    return this.messages.length;
  }

  since(cursor: number, match: (m: RpcMessage) => boolean): RpcMessage[] {
    return this.messages.slice(cursor).filter(match);
  }

  /** Fire-and-forget. Used for `/pd-*` prompts, whose response only lands when the handler finishes. */
  notify(command: Record<string, unknown>): string {
    const id = `s${++this.seq}`;
    this.log(`> ${JSON.stringify({ id, ...command }).slice(0, 300)}`);
    this.write({ id, ...command });
    return id;
  }

  async request(command: Record<string, unknown>, timeoutMs = 60_000): Promise<RpcResponse> {
    const id = this.notify(command);
    return await this.awaitResponse(id, String(command["type"]), timeoutMs);
  }

  awaitResponse(id: string, label: string, timeoutMs: number): Promise<RpcResponse> {
    const already = this.received.get(id);
    if (already !== undefined) {
      this.received.delete(id);
      return Promise.resolve(already);
    }
    if (this.exit !== undefined) return Promise.reject(new Error(`pi already exited before ${label}`));
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SmokeTimeout(`response to ${label}`, timeoutMs, this.tail()));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  async waitFrom(
    cursor: number,
    label: string,
    match: (m: RpcMessage) => boolean,
    timeoutMs: number,
  ): Promise<{ message: RpcMessage; index: number }> {
    for (let i = cursor; i < this.messages.length; i++) {
      const message = this.messages[i]!;
      if (match(message)) return { message, index: i };
    }
    if (this.exit !== undefined) throw new Error(`pi already exited while waiting for ${label}`);
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new SmokeTimeout(label, timeoutMs, this.tail()));
      }, timeoutMs);
      const waiter: Waiter = {
        match,
        settle: (message, index) => {
          clearTimeout(timer);
          resolve({ message, index });
        },
        fail: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      this.waiters.add(waiter);
    });
  }

  tail(n = DUMP_TAIL): RpcMessage[] {
    return this.messages.slice(-n);
  }

  /**
   * Closing stdin is pi's graceful shutdown, which is what fires `session_shutdown`
   * and lets the extension tear the panel down. The group kill is the backstop.
   */
  async close(graceMs = 15_000): Promise<void> {
    if (this.exit !== undefined) return;
    try {
      this.child.stdin?.end();
    } catch {
      /* already gone */
    }
    const deadline = Date.now() + graceMs;
    while (this.exit === undefined && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (this.exit !== undefined) return;
    this.signalGroup("SIGINT");
    for (let i = 0; i < 30 && this.exit === undefined; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    this.signalGroup("SIGKILL");
  }

  /** Negative pid: the whole group, not just the wrapper (lifecycle guide, Rule 3). */
  signalGroup(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (pid === undefined || this.exit !== undefined) return;
    try {
      process.kill(-pid, signal);
    } catch {
      /* group already reaped */
    }
  }
}

export function isStatus(message: RpcMessage, key: string): boolean {
  return (
    message.type === "extension_ui_request" && message["method"] === "setStatus" && message["statusKey"] === key
  );
}

export function statusText(message: RpcMessage): string | undefined {
  const text = message["statusText"];
  return typeof text === "string" ? text : undefined;
}
