export function createLLMState() {
  return {
    missionHistory: [],

    persistentMemory: "None.",

    persistentRules: {
      stackSize: null,

      parcelFilters: {
        minReward: null,
        maxReward: null,
      },

      forbiddenDeliveryTiles: new Set(),
      preferredDeliveryTiles: new Set(),

      deliveryMultipliers: new Map(),

      blockedTiles: new Set(),
    },
  };
}