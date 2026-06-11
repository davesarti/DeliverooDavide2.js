export function buildPersistentMemoryUpdateMessages({ currentMemory, updateRequest }) {
  return [
    {
      role: "system",
      content: `
You update the persistent memory of a DeliverooJS LLM agent.

The persistent memory contains only durable non-navigation rules that must affect future missions.

Store rules such as:
- "collect exactly N parcels before delivering"
- "prefer delivery tile (x,y)"
- "never deliver in tile (x,y)"
- "ignore parcels with reward higher than N"
- "ignore parcels with reward lower than N"
- "delivery in tile (x,y) gives 5x reward"
- "delivery in tile (x,y) gives 0 reward"

Do not store:
- one-shot missions;
- temporary requests;
- greetings;
- normal questions;
- already completed tasks;
- navigation restrictions such as "do not go through tile (x,y)" because those are handled separately.

Rules:
- Return only the updated persistent memory.
- Use a short bullet list.
- If no durable rule remains, return exactly: None.
- Do not infer extra strategies.
- Only store rules explicitly stated in the update request.
- Do not reinterpret reward multipliers as parcel filtering rules.
- If a new rule contradicts an older rule about the same tile, parcel class, stack size, or delivery condition, keep only the newest rule.
- If the update cancels a previous rule, remove that rule.
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