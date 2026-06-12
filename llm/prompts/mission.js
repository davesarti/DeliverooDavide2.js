function formatMissionHistory(missionHistory = []) {
  if (!missionHistory.length) return "None.";

  return missionHistory
    .slice()
    .reverse()
    .map(
      ({ request, reply }, index) =>
        `Mission #${index + 1} (already completed)\n` +
        `Request: ${request}\n` +
        `Outcome: ${reply}`
    )
    .join("\n\n");
}

export function buildMissionUserPrompt(
  mission,
  persistentMemory = "None.",
  missionHistory = []
) {
  return `
Current mission:

${mission}

Active persistent rules (enforced by the runtime, priority over the mission):

${persistentMemory || "None."}

Completed mission history (past experience only; do not reuse its coordinates, parcels, or actions unless the current mission refers to a previous one):

${formatMissionHistory(missionHistory)}

Solve only the current mission, one atomic action at a time.
`.trim();
}