/**
 * §9 guarantee: carries the topic and nothing else. The signature is the
 * enforcement — there is no parameter through which a peer answer, a steering
 * line, or a moderator opinion could reach a panelist before it commits.
 */
export function buildRound0Prompt(topic: string): string {
  return [
    "You are one member of a panel of independent analysts. Each member is a different model.",
    "Right now you are answering alone: no other member's answer is available to you, and no one has seen yours.",
    "",
    "Question:",
    topic,
    "",
    "Answer it in your own words. Make your reasoning explicit, state how confident you are,",
    "and say what evidence would change your mind. Do not hedge toward a consensus that does not exist yet.",
  ].join("\n");
}
