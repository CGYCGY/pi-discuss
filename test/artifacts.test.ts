import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  appendSteer,
  ArtifactError,
  createDiscussionDir,
  discussionDirName,
  listDiscussionDirs,
  readMeta,
  readRoundAnswerText,
  sessionPath,
  slugify,
  writeMeta,
  writeRoundAnswer,
  writeSynthesis,
  writeTopic,
} from "../src/modules/artifacts.ts";
import type { DiscussionMeta } from "../src/modules/types.ts";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pi-discuss-artifacts-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const META: DiscussionMeta = {
  topic: "should we ship it",
  createdAt: "2026-08-26T10:00:00.000Z",
  repoAccess: true,
  panel: [
    { name: "claude", model: "anthropic/claude-fable-5", thinking: "high" },
    { name: "gpt", model: "openai/gpt-5.2", thinking: "medium" },
  ],
  rounds: [
    {
      round: 0,
      startedAt: "2026-08-26T10:00:01.000Z",
      answers: [
        { slot: "claude", outcome: "answered", text: "yes", tokens: 120, cost: 0.02 },
        { slot: "gpt", outcome: "timed-out", text: "stub", error: "budget", tokens: 3, cost: 0.001 },
      ],
    },
  ],
};

describe("slugify", () => {
  test("produces a filename-safe slug", () => {
    expect(slugify("Should we ship it? (yes/no)")).toBe("should-we-ship-it-yes-no");
  });

  test("never produces an empty or trailing-dash slug", () => {
    expect(slugify("???")).toMatch(/^discussion-[0-9a-f]{8}$/);
    expect(slugify("a".repeat(80))).not.toMatch(/-$/);
  });

  test("distinct non-ASCII topics get distinct slugs rather than all colliding", () => {
    const a = slugify("我们应该发布吗");
    const b = slugify("延迟还是成本");
    expect(a).toMatch(/^discussion-[0-9a-f]{8}$/);
    expect(b).toMatch(/^discussion-[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
    expect(slugify("我们应该发布吗")).toBe(a);
  });
});

describe("discussion directory", () => {
  test("lays out the §10 tree and names it by date and slug", () => {
    const name = discussionDirName(new Date("2026-08-26T10:00:00Z"), "topic-slug");
    expect(name).toMatch(/^\d{4}-\d{2}-\d{2}-topic-slug$/);

    const dir = createDiscussionDir(cwd, name);
    expect(dir).toBe(join(cwd, "discussions", name));
    expect(existsSync(join(dir, "sessions"))).toBe(true);
    expect(sessionPath(dir, "claude")).toBe(join(dir, "sessions", "claude.jsonl"));
  });

  test("collision guard: an existing directory refuses (§8.3)", () => {
    createDiscussionDir(cwd, "2026-08-26-topic");
    expect(() => createDiscussionDir(cwd, "2026-08-26-topic")).toThrow(ArtifactError);
    expect(() => createDiscussionDir(cwd, "2026-08-26-topic")).toThrow(/already exists/);
  });

  test("lists past discussions newest first", () => {
    createDiscussionDir(cwd, "2026-08-24-a");
    createDiscussionDir(cwd, "2026-08-26-b");
    expect(listDiscussionDirs(cwd)).toEqual(["2026-08-26-b", "2026-08-24-a"]);
  });

  test("lists nothing when no discussions exist", () => {
    expect(listDiscussionDirs(cwd)).toEqual([]);
  });
});

describe("artifact writers", () => {
  test("topic.md holds the topic and every steering injection, timestamped", () => {
    const dir = createDiscussionDir(cwd, "d");
    writeTopic(dir, "should we ship it", new Date("2026-08-26T10:00:00Z"));
    appendSteer(dir, "focus on cost, ignore latency", 1, new Date("2026-08-26T10:05:00Z"));
    const body = readFileSync(join(dir, "topic.md"), "utf8");
    expect(body).toContain("should we ship it");
    expect(body).toContain("2026-08-26T10:00:00.000Z");
    expect(body).toContain("## Steering before round 1");
    expect(body).toContain("focus on cost, ignore latency");
  });

  test("round answers land at round-k/<slot>.md with the outcome on the record", () => {
    const dir = createDiscussionDir(cwd, "d");
    const path = writeRoundAnswer(dir, 0, META.rounds[0]!.answers[1]!, "openai/gpt-5.2");
    expect(path).toBe(join(dir, "round-0", "gpt.md"));
    const body = readFileSync(path, "utf8");
    expect(body).toContain("# gpt — round 0");
    const front = parseYaml(body.split("\n---\n")[0]!.replace(/^---\n/, "")) as Record<string, unknown>;
    expect(front).toEqual({
      slot: "gpt",
      round: 0,
      model: "openai/gpt-5.2",
      outcome: "timed-out",
      tokens: 3,
      cost: 0.001,
      error: "budget",
    });
  });

  test("answer prose reads back out of the round file, headings and bullets intact", () => {
    const dir = createDiscussionDir(cwd, "d");
    const text = "## Changed my mind\n\n- gpt moved me on latency\n- nothing else";
    writeRoundAnswer(dir, 0, { ...META.rounds[0]!.answers[0]!, text }, "m");
    expect(readRoundAnswerText(dir, 0, "claude")).toBe(text);
    expect(readRoundAnswerText(dir, 0, "missing")).toBe("");
  });

  test("synthesis.md is written with a timestamp", () => {
    const dir = createDiscussionDir(cwd, "d");
    writeSynthesis(dir, "the divergence map", new Date("2026-08-26T11:00:00Z"));
    const body = readFileSync(join(dir, "synthesis.md"), "utf8");
    expect(body).toContain("# Synthesis");
    expect(body).toContain("the divergence map");
  });
});

describe("meta.yaml ledger", () => {
  test("records the panel snapshot and per-round per-slot outcomes, tokens and cost", () => {
    const dir = createDiscussionDir(cwd, "d");
    writeMeta(dir, META);
    const doc = parseYaml(readFileSync(join(dir, "meta.yaml"), "utf8")) as Record<string, any>;
    expect(doc["panel"]).toEqual([
      { name: "claude", model: "anthropic/claude-fable-5", thinking: "high" },
      { name: "gpt", model: "openai/gpt-5.2", thinking: "medium" },
    ]);
    expect(doc["rounds"][0]["slots"]).toEqual([
      { name: "claude", outcome: "answered", tokens: 120, cost: 0.02 },
      { name: "gpt", outcome: "timed-out", tokens: 3, cost: 0.001, error: "budget" },
    ]);
  });

  test("round-trips through readMeta, minus the prose that lives in the round files", () => {
    const dir = createDiscussionDir(cwd, "d");
    writeMeta(dir, META);
    const back = readMeta(dir);
    expect(back.topic).toBe(META.topic);
    expect(back.createdAt).toBe(META.createdAt);
    expect(back.repoAccess).toBe(true);
    expect(back.panel).toEqual(META.panel);
    expect(back.rounds[0]!.answers.map((a) => [a.slot, a.outcome, a.tokens])).toEqual([
      ["claude", "answered", 120],
      ["gpt", "timed-out", 3],
    ]);
    expect(back.rounds[0]!.answers[0]!.text).toBe("");
  });

  test("preserves the steering text in force for a round", () => {
    const dir = createDiscussionDir(cwd, "d");
    writeMeta(dir, {
      ...META,
      rounds: [{ ...META.rounds[0]!, round: 1, steer: "focus on cost" }],
    });
    expect(readMeta(dir).rounds[0]!.steer).toBe("focus on cost");
  });

  test("refuses a ledger with no panel snapshot", () => {
    const dir = createDiscussionDir(cwd, "d");
    writeFileSync(join(dir, "meta.yaml"), "topic: x\n", "utf8");
    expect(() => readMeta(dir)).toThrow(/missing `panel` snapshot/);
  });

  test("refuses a ledger that is not valid YAML", () => {
    const dir = createDiscussionDir(cwd, "d");
    writeFileSync(join(dir, "meta.yaml"), "panel: [\n  - name: 'unterminated\n", "utf8");
    expect(() => readMeta(dir)).toThrow(ArtifactError);
  });

  test("is written through a temp file, so a crash cannot leave a half-written ledger", () => {
    const dir = createDiscussionDir(cwd, "d");
    writeMeta(dir, META);
    // The rename is atomic and the temp file must not survive it.
    expect(existsSync(join(dir, "meta.yaml.tmp"))).toBe(false);
    expect(readMeta(dir).panel).toEqual(META.panel);
  });
});
