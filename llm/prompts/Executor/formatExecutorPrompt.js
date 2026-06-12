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

Active persistent rules:

${persistentMemory || "None."}

Completed mission history:
Use only if the current mission explicitly refers to a previous mission.

${formatMissionHistory(missionHistory)}

Complete only the current mission, one tool call at a time.
`.trim();
}
