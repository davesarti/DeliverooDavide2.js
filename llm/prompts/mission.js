function formatMissionHistory(missionHistory = []) {
  if (!missionHistory.length) return "None.";

  return missionHistory
    .slice()
    .reverse()
    .map(
      ({ request, reply }, index) =>
        `Mission #${index + 1}\n` +
        `Request:\n${request}\n\n` +
        `Outcome:\n${reply}\n\n` +
        `Status: already completed`
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

Persistent memory:
These are mandatory rules. They have priority over the current mission and must always be respected.

${persistentMemory || "None."}

Completed mission history:
The following missions are already finished.
They are provided only as past experience.
Never reuse coordinates, parcels, delivery tiles, or actions from this section unless the current mission explicitly refers to a previous mission.

${formatMissionHistory(missionHistory)}

Solve only the current mission, one atomic action at a time.
`.trim();
}