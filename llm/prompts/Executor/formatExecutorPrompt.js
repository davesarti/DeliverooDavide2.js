export function buildMissionUserPrompt(
  mission,
  persistentMemory = "None."
) {
  return `
Current mission:

${mission}

Active persistent rules:

${persistentMemory || "None."}

Complete only the current mission, one tool call at a time.
`.trim();
}
