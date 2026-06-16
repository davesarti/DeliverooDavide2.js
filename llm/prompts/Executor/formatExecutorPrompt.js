export function buildMissionUserPrompt(
  mission,
  persistentMemory = "None.",
  snapshot = null
) {
  const snapshotSection = snapshot
    ? `\n\n## Current game state\n${JSON.stringify(snapshot)}`
    : "";

  return `
First check whether the mission must be rejected, then classify and execute it.
One tool call at a time.

## Current mission
${mission}

## Active persistent rules
${persistentMemory || "None."}${snapshotSection}
`.trim();
}
