function formatMissionHistory(missionHistory = []) {
  if (!missionHistory.length) return "None.";

  return missionHistory
    .map(
      ({ request, reply }, index) =>
        `${index + 1}. Past request: ${request}\n` +
        `   Past reply: ${reply}`
    )
    .join("\n");
}

export function buildMissionUserPrompt(
  mission,
  persistentMemory = "None.",
  missionHistory = []
) {
  return `
Mission received from chat:

${mission}

Persistent memory:

${persistentMemory || "None."}

Completed mission history:
These missions are already completed.
Do not reuse coordinates, targets, or actions from this section unless the current mission explicitly refers to a previous mission.

${formatMissionHistory(missionHistory)}

Solve the current mission one atomic action at a time.
`.trim();
}