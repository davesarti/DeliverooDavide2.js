export function buildMissionUserPrompt(mission, persistentMemory = "None.", missionHistory = []) {
  const historyText =
    missionHistory.length > 0
      ? missionHistory.map(({ request, reply }) => `- ${request} => ${reply}`).join("\n")
      : "None.";

  return `
Mission received from chat:

${mission}

Persistent memory:

${persistentMemory || "None."}

Mission history:

${historyText}

Solve it one atomic action at a time.
`.trim();
}
