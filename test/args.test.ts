import { describe, expect, test } from "bun:test";
import { parseOpenArgs } from "../src/index.ts";

describe("parseOpenArgs (/pd)", () => {
  test("takes the whole remainder as the topic when no flag is present", () => {
    expect(parseOpenArgs("  should we ship it?  ")).toEqual({ noRepo: false, topic: "should we ship it?" });
  });

  test("strips --no-repo when it is its own token", () => {
    expect(parseOpenArgs("--no-repo should we ship it")).toEqual({ noRepo: true, topic: "should we ship it" });
  });

  test("--no-repo alone leaves an empty topic for the usage refusal", () => {
    expect(parseOpenArgs("--no-repo")).toEqual({ noRepo: true, topic: "" });
  });

  test("a longer word starting with --no-repo is a topic, not the flag", () => {
    expect(parseOpenArgs("--no-repository access tradeoffs")).toEqual({
      noRepo: false,
      topic: "--no-repository access tradeoffs",
    });
  });

  test("--no-repo later in the topic is topic text, not a flag", () => {
    expect(parseOpenArgs("why --no-repo matters")).toEqual({ noRepo: false, topic: "why --no-repo matters" });
  });

  test("omits research entirely when no research flag is given, leaving panel.yaml in force", () => {
    expect(parseOpenArgs("ship it")).toEqual({ noRepo: false, topic: "ship it" });
  });

  test("--research and --no-research each pin the flag", () => {
    expect(parseOpenArgs("--research ship it")).toEqual({ noRepo: false, research: true, topic: "ship it" });
    expect(parseOpenArgs("--no-research ship it")).toEqual({ noRepo: false, research: false, topic: "ship it" });
  });

  test("leading flags combine in either order", () => {
    expect(parseOpenArgs("--no-repo --research ship it")).toEqual({
      noRepo: true,
      research: true,
      topic: "ship it",
    });
    expect(parseOpenArgs("--research --no-repo ship it")).toEqual({
      noRepo: true,
      research: true,
      topic: "ship it",
    });
  });

  test("the last research flag wins, so a corrected typo does not silently keep the first", () => {
    expect(parseOpenArgs("--research --no-research ship it")).toEqual({
      noRepo: false,
      research: false,
      topic: "ship it",
    });
  });

  test("--research after the topic starts is topic text", () => {
    expect(parseOpenArgs("is --research worth it")).toEqual({ noRepo: false, topic: "is --research worth it" });
  });
});
