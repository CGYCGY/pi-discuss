/** Structural, so the host-reply capture needs no type from the transitive agent-core package. */
export interface TranscriptMessage {
  role: string;
  content?: unknown;
}

export function lastAssistantText(messages: readonly TranscriptMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message === undefined || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const text = message.content
      .map((part) =>
        typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text"
          ? String((part as { text?: unknown }).text ?? "")
          : "",
      )
      .join("")
      .trim();
    if (text.length > 0) return text;
  }
  return "";
}

export type SynthesisOutcome =
  | { kind: "ok"; text: string }
  /** sendMessage left the session idle: pi started no run. */
  | { kind: "not-started" }
  /** The session went busy but the run never settled: `_prepareRun` threw (pi reports it as an extension error on `send_message`). */
  | { kind: "failed-to-start" }
  | { kind: "empty" };

/**
 * Scoped to the one run whose before_agent_start carries our message, not to "the
 * next agent_start": another extension's run could otherwise be captured and written
 * to synthesis.md. After that run settles, later runs are ignored too.
 */
export class SynthesisCapture {
  private phase: "armed" | "capturing" | "settled" = "armed";
  private text = "";

  constructor(private readonly customType: string) {}

  onBeforeAgentStart(event: { messageType: string; message?: { customType: string } }): void {
    if (this.phase === "armed" && event.messageType === "custom" && event.message?.customType === this.customType) {
      this.phase = "capturing";
    }
  }

  /** Retries fire agent_end more than once within a run; the last one with text wins. */
  onAgentEnd(messages: readonly TranscriptMessage[]): void {
    if (this.phase !== "capturing") return;
    const text = lastAssistantText(messages);
    if (text.length > 0) this.text = text;
  }

  onAgentSettled(): void {
    if (this.phase !== "capturing") return;
    this.phase = "settled";
  }

  outcome(): SynthesisOutcome {
    if (this.phase !== "settled") return { kind: "failed-to-start" };
    if (this.text.length === 0) return { kind: "empty" };
    return { kind: "ok", text: this.text };
  }
}

export interface SynthesisHost {
  send(): void;
  isIdle(): boolean;
  waitForIdle(): Promise<void>;
}

export async function runSynthesisTurn(capture: SynthesisCapture, host: SynthesisHost): Promise<SynthesisOutcome> {
  host.send();
  // Relies on pi >=1.2.0 marking the session busy synchronously inside sendMessage:
  // AgentSession.sendCustomMessage -> _startRun sets `_isAgentRunActive = true`
  // before its first await (dist/core/agent-session.js:1424 in 1.4.0). Without that,
  // this check would refuse every synthesis. No timer: the wait has to cover pre-run
  // compaction and every extension's before_agent_start, which run before agent_start.
  if (host.isIdle()) return { kind: "not-started" };
  await host.waitForIdle();
  return capture.outcome();
}
