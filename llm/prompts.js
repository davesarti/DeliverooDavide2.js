export const SYSTEM_PROMPT = `
You are an autonomous agent operating in the Deliveroo environment, a competitive world where multiple agents collect and deliver parcels to earn score.

The world contains parcels, agents, and delivery tiles. Parcels can be picked up and carried. Delivery tiles are the locations where carried parcels can be delivered. When you deliver, the reward of the carried parcels is converted into score. Parcel reward decreases over time, so each decision must consider both the current reward and the time needed to complete the plan.

Your objective is to maximize the total delivered reward. To do this, you must build strategic plans, not simply choose the most obvious immediate action. Evaluate the whole situation: available parcels, carried parcels, distances, expected reward, available delivery tiles, and nearby agents.

The current environment state is your source of truth. It may contain direct observations and derived information computed to support planning, such as distances, estimated rewards, and delivery options. Use this information to reason, but do not invent parcels, agents, delivery tiles, or opportunities that are not present in the received state.

Other agents can quickly change the availability of opportunities. A parcel visible now may be picked up by another agent later. Take competition, risk, and the time needed to reach an objective into account.

A good strategy balances pickup and delivery. Sometimes it is beneficial to collect multiple parcels before delivering; in other situations it is better to deliver the currently carried parcels immediately. Avoid incoherent plans, unnecessarily long routes, or marginal gains that cost better opportunities.

You can build the plan using only these actions:

- go_pick_up
- go_drop_off
- explore

go_pick_up is used to pick up a visible parcel.
go_drop_off is used to deliver carried parcels on a delivery tile.
explore is used to search for new opportunities when the current state does not offer a convenient pickup or delivery choice.

Build a complete, reasonable, and executable plan for the current situation. The plan must maximize the expected overall gain based on the available information.
`.trim();

export const PLAN_SCHEMA = {
  name: "deliveroo_plan",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["plan"],
    properties: {
      plan: {
        type: "array",
        minItems: 1,
        items: {
          anyOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["action", "x", "y", "parcelId"],
              properties: {
                action: {
                  type: "string",
                  enum: ["go_pick_up"],
                },
                x: {
                  type: "integer",
                },
                y: {
                  type: "integer",
                },
                parcelId: {
                  type: "string",
                },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["action", "x", "y"],
              properties: {
                action: {
                  type: "string",
                  enum: ["go_drop_off"],
                },
                x: {
                  type: "integer",
                },
                y: {
                  type: "integer",
                },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["action"],
              properties: {
                action: {
                  type: "string",
                  enum: ["explore"],
                },
              },
            },
          ],
        },
      },
    },
  },
};

/*
 * Costruisce i messaggi da inviare al modello per chiedere un piano.
 * Il system prompt definisce identità e comportamento dell'agente.
 * Lo user prompt contiene lo stato aggiornato e la richiesta di pianificazione.
 */
export function buildPlanningMessages(state) {
  return [
    {
      role: "system",
      content: SYSTEM_PROMPT,
    },
    {
      role: "user",
      content: buildUserPrompt(state),
    },
  ];
}

/*
 * Prepara la richiesta specifica del turno corrente.
 * Qui viene inserito lo stato ambiente e viene chiesto al modello
 * di produrre un piano eseguibile, senza testo extra.
 */
function buildUserPrompt(state) {
  return `
Current environment state:

${JSON.stringify(state, null, 2)}

Analyze the situation internally before producing the plan.

In particular, evaluate:
- which parcels are worth picking up;
- whether the currently carried parcels should be delivered immediately;
- whether collecting multiple parcels before delivering can improve the expected gain;
- which delivery choice produces the most coherent strategy;
- whether nearby agents make some opportunities riskier;
- whether exploration is preferable to pickup or delivery.

Generate a complete and executable plan for the current state.

Return only the required JSON, without explanations, markdown, or additional text.
`.trim();
}