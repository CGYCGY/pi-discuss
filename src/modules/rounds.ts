import type { SlotConfig } from "./config.ts";
import type { Panelist, PanelistSession } from "./panelists.ts";
import { buildAskPrompt } from "./prompts/ask.ts";
import { buildDebatePrompt } from "./prompts/debate.ts";
import { buildRound0Prompt } from "./prompts/round-0.ts";
import type { RoundRecord, SlotAnswer } from "./types.ts";

export const DEFAULT_ROUND_TIMEOUT_MS = 10 * 60 * 1000;

/** Bound on how long a session may take to settle after we abort it. */
const SETTLE_GRACE_MS = 5000;

export class ContaminationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContaminationError";
  }
}

export interface RoundSpec {
  round: number;
  topic: string;
  panelists: Panelist[];
  /** The previous round's answers. Must be empty at round 0. */
  peers: SlotAnswer[];
  steer?: string;
  timeoutMs?: number;
  signal: AbortSignal;
  /** Live per-slot progress for the footer, which is how a stall is told from a slow model (§13). */
  onSlotStart?: (slot: SlotConfig) => void;
  onSlotSettled?: (answer: SlotAnswer) => void;
}

/**
 * §8.2: the anti-anchoring property of round 0 is invisible once violated —
 * nothing about a contaminated answer looks wrong — so it is asserted rather than
 * trusted to the prompt. Steering counts as peer input: it is the moderator's
 * opinion, and round 0 carries the topic and nothing else.
 */
function assertRound0Clean(spec: RoundSpec): void {
  if (spec.round !== 0) return;
  if (spec.peers.length > 0) {
    throw new ContaminationError(
      `round 0 was handed ${spec.peers.length} peer answer(s); panelists must not see each other before first commitment`,
    );
  }
  if (spec.steer !== undefined) {
    throw new ContaminationError("round 0 was handed steering text; round 0 carries the topic and nothing else");
  }
}

export function buildSlotPrompt(spec: RoundSpec, slotName: string): string {
  if (spec.round === 0) return buildRound0Prompt(spec.topic);
  return buildDebatePrompt({
    topic: spec.topic,
    round: spec.round,
    peers: spec.peers.filter((a) => a.slot !== slotName),
    ...(spec.steer === undefined ? {} : { steer: spec.steer }),
  });
}

function safeStats(session: PanelistSession): { cost: number; tokens: number } {
  try {
    const s = session.getSessionStats();
    return { cost: s.cost, tokens: s.tokens.total };
  } catch {
    return { cost: 0, tokens: 0 };
  }
}

function safeLastText(session: PanelistSession): string {
  try {
    return (session.getLastAssistantText() ?? "").trim();
  } catch {
    // A disposed session yields no text; the outcome still records the slot.
    return "";
  }
}

/**
 * These SDK errors mean the session's *previous* turn never settled, so the real
 * fault is upstream of this round. Say so in the artifact — otherwise the record
 * blames the round that merely arrived second.
 */
const UNSETTLED_TURN_RE = /already processing|compaction is in progress/i;

function describeFailure(message: string): string {
  return UNSETTLED_TURN_RE.test(message)
    ? `${message} (a previous round's turn on this slot may never have settled)`
    : message;
}

/**
 * Narrow on purpose. A long answer that happens to open with an apology is a real
 * answer; only a short reply that is entirely a refusal counts, so a false
 * `refused` cannot swallow a position the synthesis needed.
 */
const REFUSAL_RE =
  /^\s*(?:i(?:'m| am) sorry[,.]?\s|i (?:can(?:'t|not)|won't|will not|am unable to) (?:help|assist|comply|answer|engage|provide)|i must decline|sorry[,.]? (?:but )?i can(?:'t|not))/i;

function looksLikeRefusal(text: string): boolean {
  return text.length < 400 && REFUSAL_RE.test(text);
}

function stub(headline: string, partial: string): string {
  const lines = [`_${headline}_`];
  if (partial.length > 0) lines.push("", "Partial output captured before the round ended:", "", partial);
  return lines.join("\n");
}

async function settle(session: PanelistSession): Promise<void> {
  // waitForIdle is belt-and-braces after prompt() resolves (0.84.3 compacts
  // mid-flight on long turns), but a wedged session must not hold the round open,
  // so it gets a grace window rather than an unbounded await.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      session.waitForIdle(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SETTLE_GRACE_MS);
      }),
    ]);
  } catch {
    /* best-effort */
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runSlot(
  panelist: Panelist,
  text: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<SlotAnswer> {
  const { session, slot } = panelist;
  const before = safeStats(session);
  // Snapshot the transcript's last assistant text BEFORE prompting. On the
  // timeout path getLastAssistantText() falls back to the *previous* round's
  // answer when the aborted turn produced nothing, and filing that as this
  // round's partial output would feed a stale position into the next round's
  // peer set and into synthesis.
  const priorText = safeLastText(session);

  let cancelled = false;
  let failure: Error | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  try {
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        cancelled = true;
        reject(new Error("round aborted before this slot started"));
        return;
      }
      timer = setTimeout(() => {
        cancelled = true;
        reject(new Error(`exceeded the ${timeoutMs}ms round budget`));
      }, timeoutMs);
      onAbort = () => {
        cancelled = true;
        reject(new Error("round aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      // expandPromptTemplates:false is not optional: debate prompts embed other
      // models' output, which routinely contains `/`-prefixed lines that would
      // otherwise expand as prompt templates.
      session.prompt(text, { expandPromptTemplates: false }).then(resolve, reject);
    });
  } catch (err) {
    failure = err instanceof Error ? err : new Error(String(err));
    try {
      await session.abort();
    } catch {
      /* best-effort: the outcome is already decided */
    }
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }

  await settle(session);

  const captured = safeLastText(session);
  const after = safeStats(session);
  const tokens = Math.max(0, after.tokens - before.tokens);
  const cost = Math.max(0, after.cost - before.cost);

  const base = { slot: slot.name, tokens, cost };

  if (failure !== undefined) {
    const reason = describeFailure(failure.message);
    if (cancelled) {
      // Only text the aborted turn actually produced counts as partial.
      const partial = captured === priorText ? "" : captured;
      return { ...base, outcome: "timed-out", error: reason, text: stub(`No answer: ${reason}.`, partial) };
    }
    return { ...base, outcome: "errored", error: reason, text: stub(`No answer: the model call failed — ${reason}.`, "") };
  }

  if (captured.length === 0) {
    return { ...base, outcome: "refused", text: stub("No answer: the model returned empty text.", "") };
  }
  if (looksLikeRefusal(captured)) {
    return { ...base, outcome: "refused", text: stub("The model declined to answer. Raw reply:", captured) };
  }
  return { ...base, outcome: "answered", text: captured };
}

/**
 * `/pd-ask`: one slot, one question, its context intact. Deliberately not a round
 * — it borrows the same wrapping and outcome taxonomy but never builds a peer set,
 * so pressing one panelist cannot leak another's position into it.
 */
export async function askPanelist(
  panelist: Panelist,
  question: string,
  signal: AbortSignal,
  timeoutMs = DEFAULT_ROUND_TIMEOUT_MS,
): Promise<SlotAnswer> {
  return runSlot(panelist, buildAskPrompt(question), timeoutMs, signal);
}

/**
 * Steps 1-4 of §6. A panelist fault never aborts the round: every slot call is
 * wrapped and demoted to an outcome, so the other slots run to completion and the
 * round is written with the failure recorded in place.
 */
export async function runRound(spec: RoundSpec): Promise<RoundRecord> {
  assertRound0Clean(spec);

  const timeoutMs = spec.timeoutMs ?? DEFAULT_ROUND_TIMEOUT_MS;
  const startedAt = new Date().toISOString();

  const settled = await Promise.allSettled(
    spec.panelists.map(async (p) => {
      spec.onSlotStart?.(p.slot);
      const answer = await runSlot(p, buildSlotPrompt(spec, p.slot.name), timeoutMs, spec.signal);
      spec.onSlotSettled?.(answer);
      return answer;
    }),
  );

  const answers: SlotAnswer[] = settled.map((result, i) => {
    if (result.status === "fulfilled") return result.value;
    const slot = spec.panelists[i]!.slot;
    const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
    return {
      slot: slot.name,
      outcome: "errored",
      error: reason,
      text: stub(`No answer: the slot runner itself failed — ${reason}.`, ""),
      tokens: 0,
      cost: 0,
    };
  });

  return {
    round: spec.round,
    startedAt,
    ...(spec.steer === undefined ? {} : { steer: spec.steer }),
    answers,
  };
}

export interface FinishRoundOptions {
  record: RoundRecord;
  slots: SlotConfig[];
  /** The §12 latch. */
  isDisposed: () => boolean;
  writeAnswer: (answer: SlotAnswer, slot: SlotConfig) => Promise<void> | void;
  writeLedger: () => Promise<void> | void;
  render: (answer: SlotAnswer, slot: SlotConfig) => Promise<void> | void;
}

/**
 * Step 5 of §6.
 *
 * The latch gates rendering only. Rendering touches a ctx and a session that a
 * replacement may already have invalidated, so it must stop; the artifact writes
 * touch nothing but the filesystem and are deliberately latch-exempt — they *are*
 * §12's "flush partial artifacts", and a round that was already paid for must not
 * be thrown away because a `/new` landed while it was finishing.
 */
export async function finishRound(opts: FinishRoundOptions): Promise<void> {
  const bySlot = new Map(opts.record.answers.map((a) => [a.slot, a]));

  for (const slot of opts.slots) {
    const answer = bySlot.get(slot.name);
    if (answer === undefined) continue;
    await opts.writeAnswer(answer, slot);
  }
  await opts.writeLedger();

  // Panel order, not completion order: parallel execution, sequential display (§14).
  for (const slot of opts.slots) {
    if (opts.isDisposed()) return;
    const answer = bySlot.get(slot.name);
    if (answer === undefined) continue;
    await opts.render(answer, slot);
  }
}
