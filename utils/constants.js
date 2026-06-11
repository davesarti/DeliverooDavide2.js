// Costants used in A*
export const BASE_STEP_COST = 1;
export const MIN_EDGE_COST = 0.1;
export const PARCEL_REWARD_DISCOUNT = 0.2;

// Costants used in mapUtils
export const PARCEL_DECAY = 1; // usato solo come fallback se il server non fornisce parcels.decaying_event

// Costants used in stateUtils
export const MAX_DELIVERY_OPTIONS_PER_PARCEL = 3;
export const MOVING_WINDOW_MS = 10000;
export const STALENESS_WEIGHT = 0.7;

export const RUNTIME = {
  LLM_LOOP_DELAY_MS: 500,
  LLM_ERROR_DELAY_MS: 1000,
  READINESS_CHECK_DELAY_MS: 100,

  GO_TO_TIMEOUT_MS: 5000,
  MOVEMENT_RETRY_DELAY_MS: 10,
  MAX_CONSECUTIVE_WAITS: 50,

  FAILED_INTENTION_RETRY_MS: 3000,
};

// Constants used in LLM agent
export const MAX_ITERATIONS = 15;
export const MAX_MISSION_HISTORY = 5;