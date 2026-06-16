export function buildMissionUserPrompt(
  mission,
  persistentMemory = "None."
) {
  return `
Complete ONLY the current mission below, one tool call at a time. First classify it
as a durable rule or an action task, then proceed.

## Current mission
${mission}

## Active persistent rules
${persistentMemory || "None."}
`.trim();
}
