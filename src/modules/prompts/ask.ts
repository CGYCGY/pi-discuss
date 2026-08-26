/**
 * A direct question from the moderator to one panelist, delivered into that
 * slot's existing context. It is deliberately not a round: no peer text is
 * attached, so pressing one panelist cannot leak another's position into it.
 */
export function buildAskPrompt(question: string): string {
  return [
    "The moderator is asking you directly, outside the round structure. No other panelist sees this exchange,",
    "and your answer does not become a round position.",
    "",
    question,
  ].join("\n");
}
