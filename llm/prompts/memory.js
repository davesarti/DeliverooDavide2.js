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
- Never store unresolved relative descriptions such as "nearest delivery tile", "leftmost delivery tile", "current tile", or "tile where I am".
- If the update request contains a relative tile description without concrete coordinates, ignore that part.
- If a new rule gives a different reward, permission, or restriction for the same tile, replace older rules about that tile.
  - Example: "delivery in tile (0,9) gives 5x reward" replaces "never deliver in tile (0,9)".
  - Example: "you can now deliver in tile (0,9)" removes "never deliver in tile (0,9)".
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