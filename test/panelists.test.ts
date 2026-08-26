import { describe, expect, test } from "bun:test";
import { disposePanelists, PANELIST_TOOLS, RESEARCH_TOOLS } from "../src/modules/panelists.ts";
import { FETCH_TOOL_NAME, SEARCH_TOOL_NAME } from "../src/modules/research.ts";
import { panelist } from "./helpers.ts";

describe("panelist tool surface (§5)", () => {
  test("the allowlist is read-only and mechanically excludes the mutating tools", () => {
    expect([...PANELIST_TOOLS]).toEqual(["read", "grep", "find", "ls"]);
    for (const denied of ["write", "edit", "bash", "powershell"]) {
      expect(PANELIST_TOOLS as readonly string[]).not.toContain(denied);
    }
  });

  test("the research names match the tools that get registered, or the allowlist silences them", () => {
    expect([...RESEARCH_TOOLS]).toEqual([SEARCH_TOOL_NAME, FETCH_TOOL_NAME]);
  });

  test("research is not part of the base allowlist, so a plain panel has no network", () => {
    for (const name of RESEARCH_TOOLS) {
      expect(PANELIST_TOOLS as readonly string[]).not.toContain(name);
    }
  });
});

describe("teardown (§12)", () => {
  test("aborts before disposing, because dispose does not stop an in-flight turn", async () => {
    const a = panelist("a");
    const b = panelist("b");
    await disposePanelists([a, b]);
    expect(a.session.calls).toEqual(["abort", "dispose"]);
    expect(b.session.calls).toEqual(["abort", "dispose"]);
  });

  test("one slot's failed teardown does not strand the others", async () => {
    const a = panelist("a");
    const b = panelist("b");
    a.session.abort = async () => {
      throw new Error("already gone");
    };
    await disposePanelists([a, b]);
    expect(b.session.calls).toEqual(["abort", "dispose"]);
    expect(a.session.disposes).toBe(1);
  });
});
