/*
 * LLM Mission Agent — atomic execution loop
 */

export const SYSTEM_PROMPT = `
You are an LLM agent operating in the DeliverooJS game.
You receive special missions through the game chat and solve them one atomic action at a time.
 
# How you operate
You work in an Action -> Observation loop.
At each step you choose exactly one action. The runtime executes it and returns an observation.
Each observation is a fact that already happened and is the only source of truth.
 
# Step 0 — Reward check (do this first)
Before choosing any action, read the mission and look for an explicit reward or penalty.
If the mission gives a negative reward in any form ("-10pts", "-10pt", "-5", "lose points", "penalty", "to get -..."), do not do it.
Your first and only action must be final_reply, explaining the mission was declined to avoid losing score.
If the reward is positive, zero, or not mentioned, proceed normally.
 
# Available actions
- calculate: evaluate one mathematical expression. Use it only when a value is written as a formula. Never do arithmetic yourself.
- get_my_position: read the current agent position.
- find_delivery_tile: find a delivery tile by description, such as "leftmost" or "nearest".
- go_to: move to integer coordinates.
- go_pick_up: pick up one known parcel.
- go_drop_off: deliver carried parcels on a delivery tile.
- explore: move toward spawn areas to search for parcels.
- get_environment_state: read the compact current environment state when parcels, carried parcels, delivery tiles, or persistent memory are needed.
- update_persistent_memory: update durable rules that affect future missions. Use it only for persistent instructions, not one-shot missions.
- final_reply: end the mission and send a message back to the sender.
 
# Guidance
- Resolve formulas with calculate, and tile descriptions with find_delivery_tile, before using the resulting coordinates.
- For normal questions that need no game action, answer directly with final_reply.
- Always end the mission with final_reply, whether it succeeded, was declined, or was impossible.
- Keep reason short and operational.
- Use get_environment_state before choosing pickup, dropoff, or delivery-related actions if the current environment has not been observed yet.
- Use update_persistent_memory only for durable rules such as "always", "never", "from now on", or when a previous durable rule is cancelled or changed.
`.trim();

/*
 * Tool definitions per il function calling nativo di Llama 3.3 70B.
 * Ogni tool corrisponde a un'azione atomica del mission loop.
 * Il modello sceglie il tool e popola solo i parametri richiesti.
 */
export const MISSION_TOOLS = [
  {
    type: "function",
    function: {
      name: "calculate",
      description: "Evaluate one mathematical expression. Use it when a coordinate or value is written as a formula. Never compute arithmetic yourself.",
      parameters: {
        type: "object",
        required: ["reason", "expression"],
        additionalProperties: false,
        properties: {
          reason: { type: "string", description: "Short operational reason for this action." },
          expression: { type: "string", description: "The mathematical expression to evaluate." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_my_position",
      description: "Read the current position of this agent.",
      parameters: {
        type: "object",
        required: ["reason"],
        additionalProperties: false,
        properties: {
          reason: { type: "string", description: "Short operational reason for this action." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_delivery_tile",
      description: "Find a delivery tile by textual description, such as 'leftmost' or 'nearest'.",
      parameters: {
        type: "object",
        required: ["reason", "query"],
        additionalProperties: false,
        properties: {
          reason: { type: "string", description: "Short operational reason for this action." },
          query: { type: "string", description: "Textual description of the desired delivery tile, e.g. 'leftmost', 'nearest'." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "go_to",
      description: "Move to a known tile. Use only when x and y are already known integer values.",
      parameters: {
        type: "object",
        required: ["reason", "x", "y"],
        additionalProperties: false,
        properties: {
          reason: { type: "string", description: "Short operational reason for this action." },
          x: { type: "integer", description: "Target x coordinate." },
          y: { type: "integer", description: "Target y coordinate." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "go_pick_up",
      description: "Move to a parcel and pick it up.",
      parameters: {
        type: "object",
        required: ["reason", "x", "y", "parcelId"],
        additionalProperties: false,
        properties: {
          reason: { type: "string", description: "Short operational reason for this action." },
          x: { type: "integer", description: "Parcel x coordinate." },
          y: { type: "integer", description: "Parcel y coordinate." },
          parcelId: { type: "string", description: "Id of the parcel to pick up." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "go_drop_off",
      description: "Move to a delivery tile and deliver all carried parcels.",
      parameters: {
        type: "object",
        required: ["reason", "x", "y"],
        additionalProperties: false,
        properties: {
          reason: { type: "string", description: "Short operational reason for this action." },
          x: { type: "integer", description: "Delivery tile x coordinate." },
          y: { type: "integer", description: "Delivery tile y coordinate." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "explore",
      description: "Move toward spawn areas to search for parcels.",
      parameters: {
        type: "object",
        required: ["reason"],
        additionalProperties: false,
        properties: {
          reason: { type: "string", description: "Short operational reason for this action." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_environment_state",
      description:
        "Read the current compact environment state: agent position, carried parcels, visible parcels, delivery tiles, and persistent memory. Use it before deciding pickup, dropoff, explore, or delivery-related actions when current environment information is needed.",
      parameters: {
        type: "object",
        required: ["reason"],
        additionalProperties: false,
        properties: {
          reason: {
            type: "string",
            description: "Short operational reason for this action.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_persistent_memory",
      description:
        "Update the persistent memory when the sender gives, changes, or cancels a durable rule that should affect future missions. Do not use it for one-shot missions.",
      parameters: {
        type: "object",
        required: ["reason", "text"],
        additionalProperties: false,
        properties: {
          reason: {
            type: "string",
            description: "Short operational reason for this action.",
          },
          text: {
            type: "string",
            description:
              "The natural-language instruction that should update persistent memory.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "final_reply",
      description: "End the mission and send a message back to the sender. Always call this when the mission is completed, declined, or impossible.",
      parameters: {
        type: "object",
        required: ["reason", "message"],
        additionalProperties: false,
        properties: {
          reason: { type: "string", description: "Short operational reason for this action." },
          message: { type: "string", description: "Message to send back to the mission sender." },
        },
      },
    },
  },
];

/*
 * Costruisce il primo user prompt con la missione ricevuta.
 * Gli step successivi sono gestiti come conversation history reale
 * (ruoli assistant + tool) nel loop dell'agente, non qui.
 */
export function buildMissionUserPrompt(mission, persistentMemory = "None.") {
  return `
Mission received from chat:

${mission}

Persistent memory:

${persistentMemory || "None."}

Solve it one atomic action at a time.
`.trim();
}


export function buildPersistentMemoryUpdateMessages({
  currentMemory,
  updateRequest,
}) {
  return [
    {
      role: "system",
      content: `
You update the persistent memory of a DeliverooJS LLM agent.

The persistent memory contains only durable rules that must affect future missions.

Store rules such as:
- "never deliver in tile (x,y)"
- "prefer delivery tile (x,y)"
- "avoid tile (x,y)"
- "from now on collect exactly N parcels before delivering"
- "ignore parcels with reward higher/lower than N"

Do not store one-shot missions, temporary requests, greetings, normal questions, or already completed tasks.

If the new request cancels or changes a previous rule, rewrite the memory accordingly.

Return only the updated persistent memory.
Use a short bullet list.
If no durable rule remains, return exactly: None.
`.trim(),
    },
    {
      role: "user",
      content: `
Current persistent memory:

${currentMemory || "None."}

New memory update request:

${updateRequest}

Rewrite the full persistent memory now.
`.trim(),
    },
  ];
}
 