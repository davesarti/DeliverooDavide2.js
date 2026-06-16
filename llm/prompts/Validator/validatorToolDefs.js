const param = (description) => ({ type: "string", description });

const thought = param(
  "One short sentence justifying the decision. Name the deciding check: " +
  "coherence, coordinate placeholder, arithmetic coordinate, reward sign " +
  "(negative only if below zero), durable rule vs immediate mission, or conflict " +
  "with an active persistent rule."
);

export const SYSTEM_VALIDATOR_TOOLS = [
  {
    type: "function",
    function: {
      name: "validate_mission",
      description:
        "Record the admissibility decision for the incoming request. Call this " +
        "exactly once. Set accepted=true to admit, accepted=false to reject.",
      parameters: {
        type: "object",
        required: ["thought", "accepted", "reason"],
        additionalProperties: false,
        properties: {
          thought,
          accepted: {
            type: "boolean",
            description:
              "true if the request is admissible, false if it must be rejected.",
          },
          reason: {
            type: "string",
            description:
              "Concise justification. If accepted, write exactly 'Request admitted.' " +
              "If rejected, state the single blocking issue.",
          },
        },
      },
    },
  },
];
