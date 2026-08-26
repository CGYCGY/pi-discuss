import type { SlotAnswer } from "../types.ts";
import { renderSteer } from "./steer.ts";

export interface DebatePromptInput {
  topic: string;
  round: number;
  /** The previous round's answers from the *other* slots. Never includes the recipient. */
  peers: SlotAnswer[];
  steer?: string;
}

function renderPeer(answer: SlotAnswer): string {
  const head = `### ${answer.slot} (${answer.outcome})`;
  if (answer.outcome === "answered") return `${head}\n${answer.text}`;
  return `${head}\nNo position this round: ${answer.error ?? answer.text}`;
}

/**
 * §9 guarantee: peer positions appear labeled by slot name, and each answer must
 * state what changed, what is still disputed, and what evidence would move it —
 * so attribution survives into the next round instead of dissolving into a
 * consensus nobody argued for.
 */
export function buildDebatePrompt(input: DebatePromptInput): string {
  const parts = [
    `Debate round ${input.round}. You are one member of a panel of independent analysts, each a different model.`,
    "Below are the other members' positions from the previous round, labeled by name.",
    "",
    "Question under discussion:",
    input.topic,
    "",
    "## Other panelists' positions",
    input.peers.map(renderPeer).join("\n\n"),
    "",
  ];

  if (input.steer !== undefined) parts.push(renderSteer(input.steer), "");

  parts.push(
    "## Your reply",
    "Revise or hold your position, and structure your reply around these three headings:",
    "",
    "**Changed my mind:** what a named panelist argued that moved you, and how far.",
    "**Still dispute:** what you continue to reject, naming who argued it and why their reasoning fails.",
    "**Would move me:** the specific evidence or argument that would settle the disagreement.",
    "",
    "Hold a position you still believe. Agreement you do not feel is worse than open disagreement,",
    "because the panel's value is the disagreement map, not a consensus.",
  );

  return parts.join("\n");
}
