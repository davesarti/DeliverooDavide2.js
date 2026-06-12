export function buildValidatorUserPrompt(
  request,
  persistentMemory = "None."
) {
  return `
Incoming request:

${request}

Active persistent rules:

${persistentMemory || "None."}

Evaluate whether the incoming request is admissible.
`.trim();
}
