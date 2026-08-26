/** Soft-cap threshold used when panel.yaml sets no explicit `max_cost` (§8.5). */
export const DEFAULT_SOFT_CAP_USD = 5;

/** Structural subset of AgentSession.getSessionStats()'s return. */
export interface SlotStats {
  cost: number;
  tokens: { total: number };
}

export interface StatsSource {
  getSessionStats(): SlotStats;
}

export interface CostSnapshot {
  totalCost: number;
  totalTokens: number;
  perSlot: Map<string, SlotStats>;
}

/**
 * §13: getSessionStats() aggregates over all entries including compacted-away
 * history, so it reflects what was actually billed rather than what is still in
 * the context window.
 */
export function aggregateCost(slots: Array<{ name: string; session: StatsSource }>): CostSnapshot {
  const perSlot = new Map<string, SlotStats>();
  let totalCost = 0;
  let totalTokens = 0;
  for (const { name, session } of slots) {
    let stats: SlotStats;
    try {
      stats = session.getSessionStats();
    } catch {
      // A disposed or wedged session must not take the whole status readout down.
      stats = { cost: 0, tokens: { total: 0 } };
    }
    perSlot.set(name, stats);
    totalCost += stats.cost;
    totalTokens += stats.tokens.total;
  }
  return { totalCost, totalTokens, perSlot };
}

export type CostRuling =
  | { action: "proceed" }
  | { action: "warn"; message: string }
  | { action: "refuse"; message: string };

/**
 * §8.5: an explicit `max_cost` is a hard refusal; with none set the cap is soft
 * (warn and continue). Callers must only consult this at a round boundary —
 * refusing mid-round would strand a paid-for round unwritten.
 */
export function checkCostGuard(spentUsd: number, maxCost: number | undefined): CostRuling {
  if (maxCost !== undefined) {
    if (spentUsd >= maxCost) {
      return {
        action: "refuse",
        message:
          `This discussion has spent $${spentUsd.toFixed(2)}, at or over the max_cost of $${maxCost.toFixed(2)} ` +
          "set in panel.yaml. Raise or remove max_cost to continue.",
      };
    }
    return { action: "proceed" };
  }
  if (spentUsd >= DEFAULT_SOFT_CAP_USD) {
    return {
      action: "warn",
      message:
        `This discussion has spent $${spentUsd.toFixed(2)}, past the $${DEFAULT_SOFT_CAP_USD.toFixed(2)} soft cap. ` +
        "Continuing. Set defaults.max_cost in panel.yaml to make this a hard stop.",
    };
  }
  return { action: "proceed" };
}
