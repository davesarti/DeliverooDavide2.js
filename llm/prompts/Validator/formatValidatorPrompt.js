export function buildValidatorUserPrompt(
  request,
  persistentMemory = "None.",
  snapshot = null
) {
  return `
Decide whether the request below is admissible, then call validate_mission once.
Use ONLY the request, the active rules, and the snapshot below — do not assume
anything that is not stated.

## Incoming request
${request}

## Active persistent rules
${persistentMemory || "None."}

## Current game snapshot
${snapshot ? JSON.stringify(snapshot, null, 2) : "Not available."}
`.trim();
}
