import { describe, expect, test } from "bun:test";
import type { SlotConfig } from "../src/modules/config.ts";
import { askPanelist, buildSlotPrompt, ContaminationError, finishRound, runRound } from "../src/modules/rounds.ts";
import type { SlotAnswer } from "../src/modules/types.ts";
import { panelist, slot } from "./helpers.ts";

const NEVER_ABORTED = new AbortController().signal;

function answer(name: string, overrides: Partial<SlotAnswer> = {}): SlotAnswer {
  return { slot: name, outcome: "answered", text: `${name} says so`, tokens: 10, cost: 0.01, ...overrides };
}

describe("round-0 contamination guard (§8.2)", () => {
  test("refuses peer answers at round 0", async () => {
    await expect(
      runRound({
        round: 0,
        topic: "t",
        panelists: [panelist("a")],
        peers: [answer("b")],
        signal: NEVER_ABORTED,
      }),
    ).rejects.toThrow(ContaminationError);
  });

  test("refuses steering at round 0, which is a moderator opinion", async () => {
    await expect(
      runRound({
        round: 0,
        topic: "t",
        panelists: [panelist("a")],
        peers: [],
        steer: "focus on cost",
        signal: NEVER_ABORTED,
      }),
    ).rejects.toThrow(/carries the topic and nothing else/);
  });

  test("allows peers from round 1 on", async () => {
    const record = await runRound({
      round: 1,
      topic: "t",
      panelists: [panelist("a", { reply: "held" })],
      peers: [answer("b")],
      signal: NEVER_ABORTED,
    });
    expect(record.answers[0]!.outcome).toBe("answered");
  });
});

describe("buildSlotPrompt", () => {
  test("excludes the recipient's own previous answer from its peer set", () => {
    const text = buildSlotPrompt(
      {
        round: 1,
        topic: "t",
        panelists: [],
        peers: [answer("a", { text: "MY OWN POSITION" }), answer("b", { text: "PEER POSITION" })],
        signal: NEVER_ABORTED,
      },
      "a",
    );
    expect(text).not.toContain("MY OWN POSITION");
    expect(text).toContain("PEER POSITION");
  });
});

describe("outcome taxonomy (§7)", () => {
  test("answered: non-empty reply, captured verbatim", async () => {
    const p = panelist("a", { reply: "  my position  " });
    const record = await runRound({ round: 0, topic: "t", panelists: [p], peers: [], signal: NEVER_ABORTED });
    expect(record.answers[0]).toMatchObject({ slot: "a", outcome: "answered", text: "my position" });
    expect(record.answers[0]!.tokens).toBe(100);
    expect(record.answers[0]!.cost).toBeCloseTo(0.01, 6);
  });

  test("errored: the SDK call threw", async () => {
    const p = panelist("a", { error: "401 no credentials" });
    const record = await runRound({ round: 0, topic: "t", panelists: [p], peers: [], signal: NEVER_ABORTED });
    expect(record.answers[0]).toMatchObject({ slot: "a", outcome: "errored" });
    expect(record.answers[0]!.error).toContain("401 no credentials");
    expect(record.answers[0]!.text).toContain("401 no credentials");
    expect(p.session.aborts).toBe(1);
  });

  test("timed-out: the round budget expired, and any partial text is kept", async () => {
    const p = panelist("a", { hang: true, partial: "half an argument" });
    const record = await runRound({
      round: 0,
      topic: "t",
      panelists: [p],
      peers: [],
      timeoutMs: 20,
      signal: NEVER_ABORTED,
    });
    expect(record.answers[0]!.outcome).toBe("timed-out");
    expect(record.answers[0]!.text).toContain("half an argument");
    expect(p.session.aborts).toBe(1);
  });

  test("timed-out: a previous round's answer is never filed as this round's partial", async () => {
    const p = panelist("a", { hang: true, priorText: "ROUND 1 ANSWER, ALREADY ON THE RECORD" });
    const record = await runRound({
      round: 2,
      topic: "t",
      panelists: [p],
      peers: [answer("b")],
      timeoutMs: 20,
      signal: NEVER_ABORTED,
    });
    expect(record.answers[0]!.outcome).toBe("timed-out");
    expect(record.answers[0]!.text).not.toContain("ROUND 1 ANSWER");
    expect(record.answers[0]!.text).not.toContain("Partial output");
  });

  test("timed-out: text this turn produced is kept even with a previous answer behind it", async () => {
    const p = panelist("a", { hang: true, priorText: "OLD ROUND ANSWER", partial: "THIS ROUND SO FAR" });
    const record = await runRound({
      round: 2,
      topic: "t",
      panelists: [p],
      peers: [answer("b")],
      timeoutMs: 20,
      signal: NEVER_ABORTED,
    });
    expect(record.answers[0]!.text).toContain("THIS ROUND SO FAR");
    expect(record.answers[0]!.text).not.toContain("OLD ROUND ANSWER");
  });

  test("errored: an unsettled previous turn is named as the likely cause", async () => {
    const record = await runRound({
      round: 1,
      topic: "t",
      panelists: [panelist("a", { error: "Agent is already processing." })],
      peers: [answer("b")],
      signal: NEVER_ABORTED,
    });
    expect(record.answers[0]!.error).toContain("may never have settled");
  });

  test("timed-out: /pd-abort trips the discussion signal mid-round", async () => {
    const controller = new AbortController();
    const p = panelist("a", { hang: true });
    const running = runRound({
      round: 0,
      topic: "t",
      panelists: [p],
      peers: [],
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    await Bun.sleep(5);
    controller.abort();
    const record = await running;
    expect(record.answers[0]!.outcome).toBe("timed-out");
    expect(record.answers[0]!.error).toContain("aborted");
    expect(p.session.aborts).toBe(1);
  });

  test("refused: empty text is recorded, never silently dropped", async () => {
    const record = await runRound({
      round: 0,
      topic: "t",
      panelists: [panelist("a", { reply: "   " })],
      peers: [],
      signal: NEVER_ABORTED,
    });
    expect(record.answers[0]!.outcome).toBe("refused");
    expect(record.answers[0]!.text).toContain("empty text");
  });

  test("refused: a short reply that is entirely a refusal, with the raw reply kept", async () => {
    const record = await runRound({
      round: 0,
      topic: "t",
      panelists: [panelist("a", { reply: "I'm sorry, I can't help with that." })],
      peers: [],
      signal: NEVER_ABORTED,
    });
    expect(record.answers[0]!.outcome).toBe("refused");
    expect(record.answers[0]!.text).toContain("I'm sorry, I can't help with that.");
  });

  test("answered: a long answer that merely opens with an apology is not a refusal", async () => {
    const reply = `I'm sorry, that framing is wrong. ${"Here is the actual argument. ".repeat(30)}`;
    const record = await runRound({
      round: 0,
      topic: "t",
      panelists: [panelist("a", { reply })],
      peers: [],
      signal: NEVER_ABORTED,
    });
    expect(record.answers[0]!.outcome).toBe("answered");
  });
});

describe("a panelist fault never aborts the round (§6)", () => {
  test("one slot fails while the others run to completion", async () => {
    const a = panelist("a", { reply: "a position" });
    const b = panelist("b", { error: "transport reset" });
    const c = panelist("c", { hang: true });
    const record = await runRound({
      round: 0,
      topic: "t",
      panelists: [a, b, c],
      peers: [],
      timeoutMs: 30,
      signal: NEVER_ABORTED,
    });
    expect(record.answers.map((x) => [x.slot, x.outcome])).toEqual([
      ["a", "answered"],
      ["b", "errored"],
      ["c", "timed-out"],
    ]);
    expect(record.answers).toHaveLength(3);
  });

  test("every slot is prompted with expandPromptTemplates:false", async () => {
    const a = panelist("a", { reply: "x" });
    const b = panelist("b", { reply: "y" });
    await runRound({ round: 0, topic: "t", panelists: [a, b], peers: [], signal: NEVER_ABORTED });
    for (const p of [a, b]) {
      expect(p.session.prompts[0]!.options).toEqual({ expandPromptTemplates: false });
    }
  });

  test("progress callbacks fire per slot, which is what the footer reads", async () => {
    const started: string[] = [];
    const settled: Array<[string, string]> = [];
    await runRound({
      round: 0,
      topic: "t",
      panelists: [panelist("a", { reply: "x" }), panelist("b", { error: "boom" })],
      peers: [],
      signal: NEVER_ABORTED,
      onSlotStart: (s) => started.push(s.name),
      onSlotSettled: (x) => settled.push([x.slot, x.outcome]),
    });
    expect(started.sort()).toEqual(["a", "b"]);
    expect(settled.sort()).toEqual([
      ["a", "answered"],
      ["b", "errored"],
    ]);
  });
});

describe("askPanelist (/pd-ask)", () => {
  test("presses one slot with the question and no peer text at all", async () => {
    const p = panelist("a", { reply: "my answer" });
    const result = await askPanelist(p, "WHAT ABOUT LATENCY", NEVER_ABORTED);
    expect(result).toMatchObject({ slot: "a", outcome: "answered", text: "my answer" });
    const sent = p.session.prompts[0]!;
    expect(sent.text).toContain("WHAT ABOUT LATENCY");
    expect(sent.text).not.toContain("Other panelists' positions");
    expect(sent.options).toEqual({ expandPromptTemplates: false });
  });

  test("demotes a failure to an outcome rather than throwing at the command handler", async () => {
    const result = await askPanelist(panelist("a", { error: "429" }), "q", NEVER_ABORTED);
    expect(result.outcome).toBe("errored");
  });
});

describe("finishRound (§6 step 5)", () => {
  const slots: SlotConfig[] = [slot("a"), slot("b")];
  const record = {
    round: 1,
    startedAt: "now",
    // Completion order deliberately reversed relative to panel order.
    answers: [answer("b"), answer("a")],
  };

  test("writes and renders in panel order, not completion order", async () => {
    const written: string[] = [];
    const rendered: string[] = [];
    await finishRound({
      record,
      slots,
      isDisposed: () => false,
      writeAnswer: (a) => void written.push(a.slot),
      writeLedger: () => {},
      render: (a) => void rendered.push(a.slot),
    });
    expect(written).toEqual(["a", "b"]);
    expect(rendered).toEqual(["a", "b"]);
  });

  test("the disposed latch stops rendering but never the artifact flush", async () => {
    const written: string[] = [];
    const rendered: string[] = [];
    let ledger = 0;
    await finishRound({
      record,
      slots,
      isDisposed: () => true,
      writeAnswer: (a) => void written.push(a.slot),
      writeLedger: () => {
        ledger++;
      },
      render: (a) => void rendered.push(a.slot),
    });
    expect(written).toEqual(["a", "b"]);
    expect(ledger).toBe(1);
    expect(rendered).toEqual([]);
  });
});
