export function buildValidatorUserPrompt(
  request,
  persistentMemory = "None.",
  snapshot = null
) {
  return `
Incoming request:

${request}

Active persistent rules:

${persistentMemory || "None."}

Current game snapshot:

${snapshot ? JSON.stringify(snapshot, null, 2) : "Not available."}

Evaluate whether the incoming request is admissible.
`.trim();
}