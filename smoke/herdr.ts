/**
 * Thin wrapper over the `herdr` CLI's pane surface, for the one smoke check that
 * needs a real terminal (`tui.ts`). herdr is a terminal multiplexer that exposes
 * its panes over a socket API, so it can run pi under a PTY and hand the rendered
 * screen back as text.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where the installer puts it; `HERDR_BIN` overrides, PATH wins over both. */
const FALLBACK_BIN = join(homedir(), ".local", "bin", "herdr");

export class HerdrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HerdrError";
  }
}

export function findHerdr(): string | undefined {
  const override = process.env["HERDR_BIN"];
  if (override !== undefined && override.length > 0) return existsSync(override) ? override : undefined;
  return Bun.which("herdr") ?? (existsSync(FALLBACK_BIN) ? FALLBACK_BIN : undefined);
}

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function run(bin: string, args: string[]): RunResult {
  const proc = Bun.spawnSync([bin, ...args]);
  return {
    ok: proc.success,
    stdout: proc.stdout.toString().trim(),
    stderr: proc.stderr.toString().trim(),
  };
}

function runOrThrow(bin: string, args: string[]): string {
  const result = run(bin, args);
  if (!result.ok) throw new HerdrError(`herdr ${args[0]} ${args[1] ?? ""} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

/**
 * The pane API needs a server; `herdr status` reports the client unconditionally
 * and the server only when one is up, so the server block is what to read.
 */
export function serverRunning(bin: string): boolean {
  const result = run(bin, ["status"]);
  if (!result.ok) return false;
  const server = result.stdout.split(/^server:$/m)[1] ?? "";
  return /^\s+status:\s+running$/m.test(server);
}

export function clientVersion(bin: string): string {
  const result = run(bin, ["status"]);
  const match = /version:\s*(\S+)/.exec(result.stdout);
  return match?.[1] ?? "unknown";
}

/** POSIX single-quoting, so a scratch path can hold anything and still reach the shell intact. */
export function shellQuote(parts: string[]): string {
  return parts.map((p) => `'${p.replaceAll("'", `'\\''`)}'`).join(" ");
}

export type ReadSource = "visible" | "recent" | "recent-unwrapped";

export interface ReadOptions {
  lines?: number;
  source?: ReadSource;
  ansi?: boolean;
}

/**
 * A pane in a workspace this process created and therefore owns. Closing the
 * workspace closes the pane and everything running in it — the herdr rule is to
 * never close layout you did not create, which is why the check makes its own.
 */
export class Pane {
  private closed = false;

  private constructor(
    private readonly bin: string,
    readonly workspaceId: string,
    readonly paneId: string,
  ) {}

  static open(bin: string, opts: { cwd: string; label: string }): Pane {
    const out = runOrThrow(bin, ["workspace", "create", "--cwd", opts.cwd, "--label", opts.label, "--no-focus"]);
    const parsed = JSON.parse(out) as {
      result?: { workspace?: { workspace_id?: string }; root_pane?: { pane_id?: string } };
    };
    const workspaceId = parsed.result?.workspace?.workspace_id;
    const paneId = parsed.result?.root_pane?.pane_id;
    if (workspaceId === undefined || paneId === undefined) {
      throw new HerdrError(`workspace create returned no pane: ${out.slice(0, 300)}`);
    }
    return new Pane(bin, workspaceId, paneId);
  }

  /** Sends the command text and Enter atomically. */
  run(command: string): void {
    runOrThrow(this.bin, ["pane", "run", this.paneId, command]);
  }

  sendText(text: string): void {
    runOrThrow(this.bin, ["pane", "send-text", this.paneId, text]);
  }

  sendKeys(...keys: string[]): void {
    runOrThrow(this.bin, ["pane", "send-keys", this.paneId, ...keys]);
  }

  /**
   * Resolves true on a match, false on the timeout. `wait-output` searches the
   * existing snapshot before it waits, so text already on screen still matches.
   */
  waitFor(match: string, timeoutMs: number, lines = 400): boolean {
    const result = run(this.bin, [
      "pane",
      "wait-output",
      this.paneId,
      "--match",
      match,
      "--source",
      "recent-unwrapped",
      "--lines",
      String(lines),
      "--timeout",
      String(timeoutMs),
    ]);
    return result.ok;
  }

  read(opts: ReadOptions = {}): string {
    return runOrThrow(this.bin, [
      "pane",
      "read",
      this.paneId,
      "--source",
      opts.source ?? "recent-unwrapped",
      "--lines",
      String(opts.lines ?? 400),
      "--format",
      opts.ansi === true ? "ansi" : "text",
    ]);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    run(this.bin, ["workspace", "close", this.workspaceId]);
  }
}
