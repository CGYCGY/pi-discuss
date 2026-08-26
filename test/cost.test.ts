import { describe, expect, test } from "bun:test";
import { aggregateCost, checkCostGuard, DEFAULT_SOFT_CAP_USD } from "../src/modules/cost.ts";
import { ResearchLedger } from "../src/modules/research.ts";

function source(cost: number, tokens: number) {
  return { getSessionStats: () => ({ cost, tokens: { total: tokens } }) };
}

describe("aggregateCost with research spend (§8.5)", () => {
  test("search spend lands inside totalCost, so the cap cannot be walked past on searches", () => {
    const ledger = new ResearchLedger();
    ledger.record("a", 0.02);
    ledger.record("b", 0.03);

    const snapshot = aggregateCost([{ name: "a", session: source(0.25, 1000) }], ledger);

    expect(snapshot.researchCost).toBeCloseTo(0.05, 6);
    expect(snapshot.totalCost).toBeCloseTo(0.3, 6);
    // Per-slot stays model-only: it mirrors what getSessionStats() reported.
    expect(snapshot.perSlot.get("a")).toEqual({ cost: 0.25, tokens: { total: 1000 } });
  });

  test("no ledger is zero research spend, not an absent field", () => {
    const snapshot = aggregateCost([{ name: "a", session: source(0.25, 1000) }]);
    expect(snapshot.researchCost).toBe(0);
    expect(snapshot.totalCost).toBeCloseTo(0.25, 6);
  });

  test("a research-only overrun still trips the guard", () => {
    const ledger = new ResearchLedger();
    ledger.record("a", 3);
    const snapshot = aggregateCost([{ name: "a", session: source(0, 0) }], ledger);
    expect(checkCostGuard(snapshot.totalCost, 2).action).toBe("refuse");
  });
});

describe("aggregateCost", () => {
  test("sums per-slot stats across the panel", () => {
    const snapshot = aggregateCost([
      { name: "a", session: source(0.25, 1000) },
      { name: "b", session: source(0.5, 2500) },
    ]);
    expect(snapshot.totalCost).toBeCloseTo(0.75, 6);
    expect(snapshot.totalTokens).toBe(3500);
    expect(snapshot.perSlot.get("b")).toEqual({ cost: 0.5, tokens: { total: 2500 } });
  });

  test("a wedged slot reads as zero rather than taking the readout down", () => {
    const snapshot = aggregateCost([
      { name: "a", session: source(0.25, 1000) },
      {
        name: "b",
        session: {
          getSessionStats: () => {
            throw new Error("session disposed");
          },
        },
      },
    ]);
    expect(snapshot.totalCost).toBeCloseTo(0.25, 6);
    expect(snapshot.perSlot.get("b")).toEqual({ cost: 0, tokens: { total: 0 } });
  });
});

describe("checkCostGuard (§8.5)", () => {
  test("with no max_cost the cap is soft: warn and continue", () => {
    const ruling = checkCostGuard(DEFAULT_SOFT_CAP_USD + 1, undefined);
    expect(ruling.action).toBe("warn");
    expect(ruling.action === "warn" && ruling.message).toContain("soft cap");
  });

  test("with no max_cost and spend under the soft cap, nothing is said", () => {
    expect(checkCostGuard(DEFAULT_SOFT_CAP_USD - 0.01, undefined)).toEqual({ action: "proceed" });
  });

  test("an explicit max_cost is a hard refusal at or over the limit", () => {
    const ruling = checkCostGuard(2.5, 2.5);
    expect(ruling.action).toBe("refuse");
    expect(ruling.action === "refuse" && ruling.message).toContain("max_cost");
  });

  test("an explicit max_cost proceeds under the limit, and never soft-warns", () => {
    expect(checkCostGuard(DEFAULT_SOFT_CAP_USD + 10, 100)).toEqual({ action: "proceed" });
  });
});
