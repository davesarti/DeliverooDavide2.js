export function createLLMState() {
  return {
    missionHistory: [],

    persistentMemory: "None.",

    // Cross-turn coordination context (the only state that must survive between
    // separate chat turns). Auto-maintained by the coordination tools.
    // `partnerParkedOn` is a best-effort hint, not ground truth: the authoritative
    // sync state is the BDI's status stream.
    coordination: {
      active: false,
      partnerParkedOn: null,
    },

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