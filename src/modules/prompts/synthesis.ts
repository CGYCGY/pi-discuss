import type { RoundRecord, SlotAnswer } from "../types.ts";

export interface SynthesisInput {
  topic: string;
  panel: string[];
  rounds: RoundRecord[];
}

function renderAnswer(answer: SlotAnswer): string {
  const head = `#### ${answer.slot} — ${answer.outcome}`;
  if (answer.outcome === "answered") return `${head}\n${answer.text}`;
  return `${head}\nDid not answer (${answer.outcome}): ${answer.error ?? answer.text}`;
}

function renderRound(round: RoundRecord): string {
  const title = round.round === 0 ? "### Round 0 — independent answers" : `### Round ${round.round} — debate`;
  const steer = round.steer === undefined ? [] : [`Moderator steering in force: ${round.steer}`, ""];
  return [title, "", ...steer, round.answers.map(renderAnswer).join("\n\n")].join("\n");
}

/**
 * §9 guarantee: attributed disagreement is preserved and averaging positions into
 * mush is forbidden; unique-to-one-slot points get their own section; slots whose
 * outcome was not `answered` are reported as missing rather than omitted, so a
 * three-of-five panel never reads as five-model consensus (§7).
 */
export function buildSynthesisPrompt(input: SynthesisInput): string {
  const missing = new Set<string>();
  for (const round of input.rounds) {
    for (const answer of round.answers) {
      if (answer.outcome !== "answered") missing.add(`${answer.slot} (round ${round.round}: ${answer.outcome})`);
    }
  }

  return [
    "You are the moderator of a multi-model panel. Below is the complete discussion record: each panelist is a",
    "different frontier model, and each answer is labeled with the panelist's name and its outcome.",
    "",
    `Panel: ${input.panel.join(", ")}`,
    missing.size === 0
      ? "Every panelist answered every round."
      : `Non-answers on the record: ${[...missing].join("; ")}`,
    "",
    "## Topic",
    input.topic,
    "",
    "## Discussion record",
    input.rounds.map(renderRound).join("\n\n"),
    "",
    "## Write the divergence map",
    "Produce a synthesis with exactly these sections:",
    "",
    "**Agreed** — positions every answering panelist holds. Name them.",
    "**Disputed** — each live disagreement, with who is on each side and the actual reason each gave.",
    "  Where a panelist moved across rounds, say so and say what moved it.",
    "**Raised by one** — every substantive point only one panelist made, attributed by name.",
    "  A point nobody else considered is the most valuable thing on this page; do not drop it for being unsupported.",
    "**Not heard from** — every panelist that did not answer a round, with the outcome. Silence is not agreement.",
    "**Where to dig** — what the disagreement implies the reader should check next.",
    "",
    "Two rules. Attribute every claim to the panelist who made it, by name. And never average two positions into a",
    "middle one nobody argued: if the panel split, the split is the finding, and reporting it as a moderate",
    "consensus destroys the only reason the panel was convened.",
  ].join("\n");
}
