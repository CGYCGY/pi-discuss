export const STEER_HEADING = "Steering from the moderator, applied identically to every panelist:";

/**
 * §9 guarantee: the user's text reaches every slot verbatim and identically, so a
 * round's divergence stays attributable to the models rather than to differences
 * in what each was told. Nothing here is interpolated per slot, and the text is
 * not reformatted.
 */
export function renderSteer(text: string): string {
  return `${STEER_HEADING}\n${text}`;
}
