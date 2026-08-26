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
});
