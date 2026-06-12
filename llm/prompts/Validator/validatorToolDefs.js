const param = (description) => ({ type: "string", description });

const thought = param(
  "Briefly check the request before deciding. Consider coherence, reward sign, placeholders, arithmetic coordinates, and conflicts with active persistent rules."
);

export const SYSTEM_VALIDATOR_TOOLS = [
  {
    type: "function",
    function: {
      name: "validate_mission",
      description: "Return whether the incoming request is admissible.",
      parameters: {
        type: "object",
        required: ["thought", "accepted", "reason"],
        additionalProperties: false,
        properties: {
          thought,
          accepted: {
            type: "boolean",
            description:
              "True if the request is admissible. False if it must be rejected.",
          },
          reason: {
            type: "string",
            description:
              "Concise reason for the decision. If accepted, use 'Request admitted.' If rejected, explain the blocking issue.",
          },
        },
      },
    },
  },
];