import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDiscussionDir, writeRoundAnswer } from "../src/modules/artifacts.ts";
import {
  checkPanelDrift,
  debateLoop,
  type Discussion,
  hydratedRounds,
  newDiscussion,
  nextRoundNumber,
  previousAnswers,
} from "../src/modules/discussion.ts";
import type { DiscussionMeta } from "../src/modules/types.ts";
import { panelist, slot } from "./helpers.ts";

const SAVED: DiscussionMeta = {
  topic: "t",
  createdAt: "2026-08-26T10:00:00.000Z",
  repoAccess: true,
  panel: [
    { name: "claude", model: "anthropic/claude-fable-5", thinking: "high" },
    { name: "gpt", model: "openai/gpt-5.2", thinking: "high" },
  ],
  rounds: [],
};

const CURRENT = [
  slot("claude", { model: "anthropic/claude-fable-5", thinking: "high" }),
  slot("gpt", { model: "openai/gpt-5.2", thinking: "high" }),
];

describe("panel-drift guard (§8.4)", () => {
  test("an unchanged panel passes", () => {
    expect(checkPanelDrift(SAVED, CURRENT)).toEqual([]);
  });

  test("a changed model for a slot refuses", () => {
    const drifted = [CURRENT[0]!, slot("gpt", { model: "openai/gpt-6", thinking: "high" })];
    expect(checkPanelDrift(SAVED, drifted)).toEqual([
      'slot "gpt" ran on openai/gpt-5.2 but panel.yaml now says openai/gpt-6',
    ]);
  });

  test("a removed slot refuses", () => {
    expect(checkPanelDrift(SAVED, [CURRENT[0]!, slot("deepseek")])).toEqual([
      'slot "gpt" is in the discussion but no longer in panel.yaml',
      'slot "deepseek" is in panel.yaml but not in the discussion',
    ]);
  });

  test("an added slot refuses", () => {
    expect(checkPanelDrift(SAVED, [...CURRENT, slot("deepseek")])).toEqual([
      'slot "deepseek" is in panel.yaml but not in the discussion',
    ]);
  });

  test("a changed thinking level refuses: the factory always passes the configured level", () => {
    const relaxed = [slot("claude", { model: "anthropic/claude-fable-5", thinking: "low" }), CURRENT[1]!];
    expect(checkPanelDrift(SAVED, relaxed)).toEqual([
      'slot "claude" ran at thinking high but panel.yaml now says low',
    ]);
  });
});

describe("round bookkeeping", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-discuss-discussion-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  function discussionWithRounds(dir: string, meta: DiscussionMeta) {
    return newDiscussion({
      dir,
      meta,
      panel: { slots: CURRENT, defaults: { rounds: 2, repoAccess: true } },
      panelists: [panelist("claude"), panelist("gpt")],
    });
  }

  test("nextRoundNumber starts at 0 and follows the highest round on the record", () => {
    expect(nextRoundNumber(SAVED)).toBe(0);
    expect(nextRoundNumber({ ...SAVED, rounds: [{ round: 0, startedAt: "", answers: [] }] })).toBe(1);
  });

  test("previousAnswers reloads prose from the round files, which is what a resume has", () => {
    const dir = createDiscussionDir(cwd, "d");
    const meta: DiscussionMeta = {
      ...SAVED,
      rounds: [
        {
          round: 0,
          startedAt: "",
          // A ledger read back off disk carries outcomes but no prose.
          answers: [
            { slot: "claude", outcome: "answered", text: "", tokens: 1, cost: 0 },
            { slot: "gpt", outcome: "answered", text: "", tokens: 1, cost: 0 },
          ],
        },
      ],
    };
    writeRoundAnswer(dir, 0, { slot: "claude", outcome: "answered", text: "claude position", tokens: 1, cost: 0 }, "m");
    writeRoundAnswer(dir, 0, { slot: "gpt", outcome: "answered", text: "gpt position", tokens: 1, cost: 0 }, "m");

    const discussion = discussionWithRounds(dir, meta);
    expect(previousAnswers(discussion).map((a) => a.text)).toEqual(["claude position", "gpt position"]);
    expect(hydratedRounds(discussion)[0]!.answers.map((a) => a.text)).toEqual(["claude position", "gpt position"]);
  });

  test("previousAnswers is empty before round 0, which is what keeps round 0 clean", () => {
    const dir = createDiscussionDir(cwd, "d");
    expect(previousAnswers(discussionWithRounds(dir, SAVED))).toEqual([]);
  });
});

describe("debateLoop steering consumption", () => {
  function loopFixture(pendingSteer?: string) {
    const discussion: Discussion = newDiscussion({
      dir: "/tmp/not-written",
      meta: { ...SAVED, rounds: [] },
      panel: { slots: CURRENT, defaults: { rounds: 2, repoAccess: true } },
      panelists: [],
    });
    if (pendingSteer !== undefined) discussion.pendingSteer = pendingSteer;
    const recorded: Array<[string, number]> = [];
    return {
      discussion,
      recorded,
      recordSteer: (text: string, round: number) => void recorded.push([text, round]),
    };
  }

  test("a refused round leaves the steering queued and writes no topic.md block", async () => {
    const f = loopFixture("focus on cost");
    await debateLoop({
      rounds: 2,
      discussion: f.discussion,
      canStart: () => true,
      // A re-entrant /pd-debate finds the round already running and is refused.
      runRound: async () => false,
      recordSteer: f.recordSteer,
    });
    expect(f.discussion.pendingSteer).toBe("focus on cost");
    expect(f.recorded).toEqual([]);
  });

  test("a failed round leaves the steering queued for the retry", async () => {
    const f = loopFixture("ignore latency");
    let attempts = 0;
    await debateLoop({
      rounds: 1,
      discussion: f.discussion,
      canStart: () => true,
      runRound: async () => {
        attempts++;
        return false;
      },
      recordSteer: f.recordSteer,
    });
    expect(attempts).toBe(1);
    expect(f.discussion.pendingSteer).toBe("ignore latency");
  });

  test("a committed round consumes the steering exactly once and records it", async () => {
    const f = loopFixture("focus on cost");
    const seen: Array<string | undefined> = [];
    await debateLoop({
      rounds: 2,
      discussion: f.discussion,
      canStart: () => true,
      runRound: async (round, steer) => {
        seen.push(steer);
        f.discussion.meta.rounds.push({ round, startedAt: "", answers: [] });
        return true;
      },
      recordSteer: f.recordSteer,
    });
    expect(seen).toEqual(["focus on cost", undefined]);
    expect(f.recorded).toEqual([["focus on cost", 0]]);
    expect(f.discussion.pendingSteer).toBeUndefined();
  });

  test("steering queued mid-round is kept for the next round, not consumed by this one", async () => {
    const f = loopFixture("first");
    await debateLoop({
      rounds: 1,
      discussion: f.discussion,
      canStart: () => true,
      runRound: async (round) => {
        f.discussion.meta.rounds.push({ round, startedAt: "", answers: [] });
        f.discussion.pendingSteer = "second";
        return true;
      },
      recordSteer: f.recordSteer,
    });
    expect(f.recorded).toEqual([["first", 0]]);
    expect(f.discussion.pendingSteer).toBe("second");
  });

  test("a blocked guard stops the loop before the round and keeps the steering", async () => {
    const f = loopFixture("focus on cost");
    let ran = 0;
    await debateLoop({
      rounds: 3,
      discussion: f.discussion,
      canStart: () => false,
      runRound: async () => {
        ran++;
        return true;
      },
      recordSteer: f.recordSteer,
    });
    expect(ran).toBe(0);
    expect(f.discussion.pendingSteer).toBe("focus on cost");
  });

  test("an abort mid-run stops the remaining rounds", async () => {
    const f = loopFixture();
    let ran = 0;
    await debateLoop({
      rounds: 3,
      discussion: f.discussion,
      canStart: () => true,
      runRound: async (round) => {
        ran++;
        f.discussion.meta.rounds.push({ round, startedAt: "", answers: [] });
        f.discussion.controller.abort();
        return true;
      },
      recordSteer: f.recordSteer,
    });
    expect(ran).toBe(1);
  });
});
