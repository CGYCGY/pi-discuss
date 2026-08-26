import { readRoundAnswerText } from "./artifacts.ts";
import type { PanelConfig, SlotConfig } from "./config.ts";
import type { Panelist } from "./panelists.ts";
import type { DiscussionMeta, RoundRecord, SlotAnswer } from "./types.ts";

export interface Discussion {
  dir: string;
  meta: DiscussionMeta;
  slots: SlotConfig[];
  panelists: Panelist[];
  /** Cancellation is extension-owned: ctx.signal is undefined in idle-fired handlers (§12). */
  controller: AbortController;
  /** Verbatim /pd-steer text, consumed by the next debate round. */
  pendingSteer?: string;
  running: boolean;
  /** Settles when the in-flight round has written its artifacts; shutdown awaits it. */
  inFlight?: Promise<void>;
  defaultRounds: number;
  maxCost?: number;
}

export function newDiscussion(args: {
  dir: string;
  meta: DiscussionMeta;
  panel: PanelConfig;
  panelists: Panelist[];
}): Discussion {
  return {
    dir: args.dir,
    meta: args.meta,
    slots: args.panel.slots,
    panelists: args.panelists,
    controller: new AbortController(),
    running: false,
    defaultRounds: args.panel.defaults.rounds,
    ...(args.panel.defaults.maxCost === undefined ? {} : { maxCost: args.panel.defaults.maxCost }),
  };
}

export function nextRoundNumber(meta: DiscussionMeta): number {
  return meta.rounds.reduce((max, r) => Math.max(max, r.round + 1), 0);
}

export interface DebateLoopOptions {
  rounds: number;
  discussion: Discussion;
  /** Runs one round. Resolves true only when the round reached the record. */
  runRound: (round: number, steer: string | undefined) => Promise<boolean>;
  /** Appends the steering block to topic.md. */
  recordSteer: (text: string, round: number) => void;
  /** Checked before each round: cost guard, disposal latch, still-the-active-discussion. */
  canStart: () => boolean;
}

/**
 * Steering is consumed only once the round that carried it is committed.
 *
 * Command handlers genuinely re-enter — the interactive mode does not await
 * onSubmit — so a second `/pd-debate` can arrive while the first is running and
 * be refused. Clearing `pendingSteer` before the round is committed would let
 * that refusal silently destroy the user's steering text, and the round it was
 * meant for would never see it.
 */
export async function debateLoop(opts: DebateLoopOptions): Promise<void> {
  const { discussion } = opts;
  for (let i = 0; i < opts.rounds; i++) {
    if (!opts.canStart()) return;

    const round = nextRoundNumber(discussion.meta);
    const steer = discussion.pendingSteer;

    if (!(await opts.runRound(round, steer))) return;

    if (steer !== undefined) {
      // Only clear what we actually sent: a /pd-steer that landed mid-round is
      // queued for the next one, not for the round that just finished.
      if (discussion.pendingSteer === steer) discussion.pendingSteer = undefined;
      opts.recordSteer(steer, round);
    }

    // /pd-abort cancels the whole requested run, not just the round it landed in.
    if (discussion.controller.signal.aborted) return;
  }
}

/** The previous round's answers, with prose reloaded from the round-k/*.md files. */
export function previousAnswers(discussion: Discussion): SlotAnswer[] {
  const last = discussion.meta.rounds[discussion.meta.rounds.length - 1];
  if (last === undefined) return [];
  return last.answers.map((a) => ({
    ...a,
    text: a.text.length > 0 ? a.text : readRoundAnswerText(discussion.dir, last.round, a.slot),
  }));
}

/** Rounds with prose reloaded, for synthesis after a resume. */
export function hydratedRounds(discussion: Discussion): RoundRecord[] {
  return discussion.meta.rounds.map((round) => ({
    ...round,
    answers: round.answers.map((a) => ({
      ...a,
      text: a.text.length > 0 ? a.text : readRoundAnswerText(discussion.dir, round.round, a.slot),
    })),
  }));
}

/**
 * §8.4: restoring `claude.jsonl` into a slot now pointing at another model would
 * yield one transcript in two models' voices, and nothing in the artifact would
 * show it.
 *
 * Thinking level is compared too. createAgentSession restores the saved level
 * only when the caller passes none, and the panelist factory always passes the
 * configured one — so an edited panel.yaml silently reasons at a different depth
 * than the meta.yaml snapshot claims for the whole discussion.
 */
export function checkPanelDrift(meta: DiscussionMeta, slots: SlotConfig[]): string[] {
  const problems: string[] = [];
  const saved = new Map(meta.panel.map((s) => [s.name, s]));
  const current = new Map(slots.map((s) => [s.name, s]));

  for (const name of saved.keys()) {
    if (!current.has(name)) problems.push(`slot "${name}" is in the discussion but no longer in panel.yaml`);
  }
  for (const name of current.keys()) {
    if (!saved.has(name)) problems.push(`slot "${name}" is in panel.yaml but not in the discussion`);
  }
  for (const [name, savedSlot] of saved) {
    const currentSlot = current.get(name);
    if (currentSlot === undefined) continue;
    if (currentSlot.model !== savedSlot.model) {
      problems.push(`slot "${name}" ran on ${savedSlot.model} but panel.yaml now says ${currentSlot.model}`);
    }
    if (currentSlot.thinking !== savedSlot.thinking) {
      problems.push(
        `slot "${name}" ran at thinking ${savedSlot.thinking} but panel.yaml now says ${currentSlot.thinking}`,
      );
    }
  }

  return problems;
}
