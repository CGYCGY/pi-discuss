import { describe, expect, test } from "bun:test";
import { buildDebatePrompt } from "../src/modules/prompts/debate.ts";
import { buildPanelistSystem } from "../src/modules/prompts/panelist-system.ts";
import { buildPersonaAppend } from "../src/modules/prompts/persona.ts";
import { buildRound0Prompt } from "../src/modules/prompts/round-0.ts";
import { renderSteer, STEER_HEADING } from "../src/modules/prompts/steer.ts";
import { buildSynthesisPrompt } from "../src/modules/prompts/synthesis.ts";
import type { SlotAnswer } from "../src/modules/types.ts";

const PEERS: SlotAnswer[] = [
  { slot: "claude", outcome: "answered", text: "CLAUDE POSITION", tokens: 1, cost: 0 },
  { slot: "gpt", outcome: "timed-out", text: "stub", error: "budget expired", tokens: 0, cost: 0 },
];

describe("round-0 (§9: the topic and nothing else)", () => {
  test("carries the topic", () => {
    expect(buildRound0Prompt("SHOULD WE SHIP IT")).toContain("SHOULD WE SHIP IT");
  });

  test("carries no peer text — the builder takes no channel for it", () => {
    const text = buildRound0Prompt("SHOULD WE SHIP IT");
    expect(text).not.toContain("CLAUDE POSITION");
    expect(text).not.toContain(STEER_HEADING);
    expect(buildRound0Prompt.length).toBe(1);
  });
});

describe("debate (§9: peers labeled by slot name)", () => {
  const prompt = buildDebatePrompt({ topic: "TOPIC", round: 2, peers: PEERS });

  test("labels each peer position by slot name", () => {
    expect(prompt).toContain("### claude (answered)");
    expect(prompt).toContain("CLAUDE POSITION");
  });

  test("reports a peer that did not answer rather than omitting it", () => {
    expect(prompt).toContain("### gpt (timed-out)");
    expect(prompt).toContain("budget expired");
  });

  test("demands what changed, what is still disputed, and what would move it", () => {
    expect(prompt).toContain("Changed my mind:");
    expect(prompt).toContain("Still dispute:");
    expect(prompt).toContain("Would move me:");
  });

  test("omits the steering block entirely when there is no steering", () => {
    expect(prompt).not.toContain(STEER_HEADING);
  });
});

describe("steer (§9: verbatim and identical across slots)", () => {
  const text = "focus on cost; ignore /latency and `templates`";

  test("reaches the prompt verbatim", () => {
    expect(renderSteer(text)).toContain(text);
  });

  test("every slot's prompt carries a byte-identical steering block", () => {
    const blocks = ["claude", "gpt", "deepseek"].map((name) => {
      const prompt = buildDebatePrompt({
        topic: "TOPIC",
        round: 1,
        peers: PEERS.filter((p) => p.slot !== name),
        steer: text,
      });
      const start = prompt.indexOf(STEER_HEADING);
      expect(start).toBeGreaterThanOrEqual(0);
      return prompt.slice(start, start + STEER_HEADING.length + text.length + 1);
    });
    expect(new Set(blocks).size).toBe(1);
    expect(blocks[0]).toBe(`${STEER_HEADING}\n${text}`);
  });
});

describe("persona-append (§9: frames a role, never a position)", () => {
  test("an empty persona produces no append at all", () => {
    expect(buildPersonaAppend("")).toBeUndefined();
    expect(buildPersonaAppend("   ")).toBeUndefined();
  });

  test("a role is framed without pre-committing to a conclusion", () => {
    const text = buildPersonaAppend("a security reviewer")!;
    expect(text).toContain("a security reviewer");
    expect(text).toContain("It does not tell you what to conclude");
  });
});

describe("synthesis (§9: attributed disagreement, missing slots reported)", () => {
  const prompt = buildSynthesisPrompt({
    topic: "TOPIC",
    panel: ["claude (anthropic/x)", "gpt (openai/y)"],
    rounds: [{ round: 0, startedAt: "", answers: PEERS }],
  });

  test("carries every answer attributed by slot", () => {
    expect(prompt).toContain("#### claude — answered");
    expect(prompt).toContain("CLAUDE POSITION");
  });

  test("names the non-answering slot rather than presenting a full panel", () => {
    expect(prompt).toContain("gpt (round 0: timed-out)");
    expect(prompt).toContain("Not heard from");
  });

  test("forbids averaging positions into a middle nobody argued", () => {
    expect(prompt).toContain("never average two positions");
    expect(prompt).toContain("Raised by one");
  });

  test("says so explicitly when nothing is missing", () => {
    const clean = buildSynthesisPrompt({
      topic: "TOPIC",
      panel: ["claude", "gpt"],
      rounds: [{ round: 0, startedAt: "", answers: [PEERS[0]!] }],
    });
    expect(clean).toContain("Every panelist answered every round.");
  });
});

describe("panelist system prompt (§5: the stated inventory tracks the allowlist)", () => {
  const plain = buildPanelistSystem({ research: false });
  const researching = buildPanelistSystem({ research: true });

  test("without research it claims no tool beyond reading, so a panelist does not invent one", () => {
    expect(plain).toContain("file reading and search tools and nothing else");
    expect(plain).not.toContain("web_search");
    expect(plain).not.toContain("fetch_url");
  });

  test("with research it names the tools it actually has", () => {
    expect(researching).toContain("web_search");
    expect(researching).toContain("fetch_url");
    expect(researching).toContain("Cite the URL");
  });

  test("both stay read-only and keep the anti-hedging clause (§9, §17)", () => {
    for (const text of [plain, researching]) {
      expect(text).toContain("You are read-only");
      expect(text).toContain("cannot run commands, edit");
      expect(text).toContain("hedges toward the middle");
    }
  });
});
