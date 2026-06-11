export function buildPersistentMemoryUpdateMessages({ currentMemory, updateRequest }) {
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
