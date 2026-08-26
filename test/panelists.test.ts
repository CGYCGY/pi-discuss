import { describe, expect, test } from "bun:test";
import { disposePanelists, PANELIST_TOOLS } from "../src/modules/panelists.ts";
import { panelist } from "./helpers.ts";

describe("panelist tool surface (§5)", () => {
  test("the allowlist is read-only and mechanically excludes the mutating tools", () => {
    expect([...PANELIST_TOOLS]).toEqual(["read", "grep", "find", "ls"]);
    for (const denied of ["write", "edit", "bash", "powershell"]) {
      expect(PANELIST_TOOLS as readonly string[]).not.toContain(denied);
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
