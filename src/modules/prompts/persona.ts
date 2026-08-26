/**
 * §9 guarantee: frames a role only, never a position on the topic — a persona
 * that pre-commits is anchoring wearing a costume. The framing text below is
 * fixed; only the configured role description varies.
 *
 * Returns undefined for an empty persona so the loader gets no
 * appendSystemPrompt entry at all (model diversity only).
 */
export function buildPersonaAppend(persona: string): string | undefined {
  const role = persona.trim();
  if (role.length === 0) return undefined;
  return [
    `You are participating in this panel in the following role: ${role}`,
    "",
    "The role governs which considerations you weigh and how you argue. It does not tell you what to conclude:",
    "reach whatever position the evidence supports, including one that sits badly with the role.",
  ].join("\n");
}
