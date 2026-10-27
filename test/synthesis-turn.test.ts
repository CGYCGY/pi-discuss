import { describe, expect, test } from "bun:test";
import {
  lastAssistantText,
  runSynthesisTurn,
  SynthesisCapture,
  type SynthesisHost,
  type TranscriptMessage,
} from "../src/modules/synthesis-turn.ts";

const TYPE = "pi-discuss.synthesis-request";

function assistant(text: string, stopReason = "stop"): TranscriptMessage {
  return { role: "assistant", content: [{ type: "text", text }], stopReason };
}

const ourStart = { messageType: "custom", message: { customType: TYPE } };

/**
 * Models pi >=1.2.0: send() flips the session busy synchronously, and the run's
 * events play out only after the caller has started waiting for idle.
 */
function host(capture: SynthesisCapture, run: ((c: SynthesisCapture) => void) | "none"): SynthesisHost & { sends: number } {
  let busy = false;
  let release: (() => void) | undefined;
  const h = {
    sends: 0,
    send() {
      h.sends++;
      if (run === "none") return;
      busy = true;
      queueMicrotask(() => {
        run(capture);
        busy = false;
        release?.();
      });
    },
    isIdle: () => !busy,
    waitForIdle: () => (busy ? new Promise<void>((r) => (release = r)) : Promise.resolve()),
  };
  return h;
}

describe("lastAssistantText", () => {
  test("takes the latest assistant text, skipping textless messages", () => {
    expect(
      lastAssistantText([assistant("first"), { role: "user", content: [] }, assistant("final"), { role: "assistant", content: [] }]),
    ).toBe("final");
  });

  test("an aborted latest message yields nothing, not its partial text or an older reply", () => {
    expect(lastAssistantText([assistant("older reply"), assistant("half a synth", "aborted")])).toBe("");
  });
});

describe("runSynthesisTurn (/pd-synthesize)", () => {
  test("writes the reply of the run our message started", async () => {
    const capture = new SynthesisCapture(TYPE);
    const outcome = await runSynthesisTurn(
      capture,
      host(capture, (c) => {
        c.onBeforeAgentStart(ourStart);
        c.onAgentEnd([assistant("the synthesis")]);
        c.onAgentSettled(false);
      }),
    );
    expect(outcome).toEqual({ kind: "ok", text: "the synthesis" });
  });

  test("a slow pre-run phase is waited out, not timed out", async () => {
    const capture = new SynthesisCapture(TYPE);
    let busy = false;
    let release: (() => void) | undefined;
    const outcome = runSynthesisTurn(capture, {
      send: () => {
        busy = true;
      },
      isIdle: () => !busy,
      waitForIdle: () => new Promise<void>((r) => (release = r)),
    });
    // Stands in for a long compaction: nothing has fired yet, and the command must still be waiting.
    await new Promise((r) => setTimeout(r, 20));
    capture.onBeforeAgentStart(ourStart);
    capture.onAgentEnd([assistant("late but complete")]);
    capture.onAgentSettled(false);
    busy = false;
    release?.();
    expect(await outcome).toEqual({ kind: "ok", text: "late but complete" });
  });

  test("refuses when the send left the session idle", async () => {
    const capture = new SynthesisCapture(TYPE);
    const h = host(capture, "none");
    expect(await runSynthesisTurn(capture, h)).toEqual({ kind: "not-started" });
    expect(h.sends).toBe(1);
  });

  test("a run that went busy but never settled failed before it started", async () => {
    const capture = new SynthesisCapture(TYPE);
    expect(await runSynthesisTurn(capture, host(capture, () => {}))).toEqual({ kind: "failed-to-start" });
  });

  test("an aborted run is not written, even with text captured", async () => {
    const capture = new SynthesisCapture(TYPE);
    const outcome = await runSynthesisTurn(
      capture,
      host(capture, (c) => {
        c.onBeforeAgentStart(ourStart);
        c.onAgentEnd([assistant("half a synth")]);
        c.onAgentSettled(true);
      }),
    );
    expect(outcome).toEqual({ kind: "aborted" });
  });

  test("a run with no text is refused", async () => {
    const capture = new SynthesisCapture(TYPE);
    const outcome = await runSynthesisTurn(
      capture,
      host(capture, (c) => {
        c.onBeforeAgentStart(ourStart);
        c.onAgentEnd([{ role: "assistant", content: [] }]);
        c.onAgentSettled(false);
      }),
    );
    expect(outcome).toEqual({ kind: "empty" });
  });

  test("another run's reply is never captured, before or after ours", async () => {
    const capture = new SynthesisCapture(TYPE);
    const outcome = await runSynthesisTurn(
      capture,
      host(capture, (c) => {
        c.onBeforeAgentStart({ messageType: "user" });
        c.onBeforeAgentStart({ messageType: "custom", message: { customType: "other.ext" } });
        c.onAgentEnd([assistant("someone else's reply")]);
        c.onAgentSettled(false);
        c.onBeforeAgentStart(ourStart);
        c.onAgentEnd([assistant("the synthesis")]);
        c.onAgentSettled(false);
        c.onAgentEnd([assistant("a follow-up run")]);
      }),
    );
    expect(outcome).toEqual({ kind: "ok", text: "the synthesis" });
  });

  test("a retry's later agent_end with text replaces the earlier one", async () => {
    const capture = new SynthesisCapture(TYPE);
    const outcome = await runSynthesisTurn(
      capture,
      host(capture, (c) => {
        c.onBeforeAgentStart(ourStart);
        c.onAgentEnd([assistant("first try")]);
        c.onAgentEnd([assistant("retried")]);
        c.onAgentSettled(false);
      }),
    );
    expect(outcome).toEqual({ kind: "ok", text: "retried" });
  });
});
