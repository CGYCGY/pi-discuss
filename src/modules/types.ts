import type { SlotConfig, ThinkingLevel } from "./config.ts";

/** §7: a slot that did not answer is recorded, never dropped. */
export type SlotOutcome = "answered" | "errored" | "timed-out" | "refused";

export interface SlotAnswer {
  slot: string;
  outcome: SlotOutcome;
  /** The answer, or a stub explaining the non-answer. Never empty. */
  text: string;
  /** Underlying failure text for `errored` / `timed-out`. */
  error?: string;
  tokens: number;
  cost: number;
}

export interface RoundRecord {
  round: number;
  startedAt: string;
  /** The verbatim steering text that was in force for this round, if any. */
  steer?: string;
  answers: SlotAnswer[];
}

export interface PanelSnapshotSlot {
  name: string;
  model: string;
  thinking: ThinkingLevel;
}

export interface DiscussionMeta {
  topic: string;
  createdAt: string;
  repoAccess: boolean;
  panel: PanelSnapshotSlot[];
  rounds: RoundRecord[];
}

export function snapshotPanel(slots: SlotConfig[]): PanelSnapshotSlot[] {
  return slots.map((s) => ({ name: s.name, model: s.model, thinking: s.thinking }));
}
