import { callLLMJson } from "./client.js";
import { buildPlanningMessages, PLAN_SCHEMA } from "./prompts.js";
import { distance, isDeliveryTile } from "../utils/mapUtils.js";
import {
  nearestDeliveryTileAt,
  enrichParcelForDecision,
  buildNearbyDeliveryTiles,
} from "../utils/stateUtils.js";
import { wait, waitUntil } from "../utils/asyncUtils.js";
import { RUNTIME } from "../utils/constants.js";

const MAX_DELIVERY_OPTIONS_PER_PARCEL = 3;

// ==========================================
// Readiness check
// ==========================================

function isReady(bs) {
  return (
    bs.me.id &&
    bs.me.x != null &&
    bs.me.y != null &&
    Array.isArray(bs.map.grid) &&
    bs.map.grid.length > 0 &&
    Array.isArray(bs.map.deliveryTiles) &&
    bs.map.deliveryTiles.length > 0
  );
}

// ==========================================
// State builder
// ==========================================

export function buildLLMState(bs) {
  const me = bs.me;

  const carriedParcels = [...bs.parcels.values()].filter(
    (parcel) => parcel.carriedBy === me.id
  );

  const visibleParcels = [...bs.parcels.values()]
    .filter((parcel) => !parcel.carriedBy)
    .map((parcel) =>
      enrichParcelForDecision(
        parcel,
        me,
        bs.map.deliveryDistanceMap,
        {
          maxDeliveryOptions: MAX_DELIVERY_OPTIONS_PER_PARCEL,
          parcelDecayingEvent: bs.config.parcelDecayingEvent,
        }
      )
    )
    .filter((parcel) => parcel.deliveryOptions.length > 0)
    .sort((a, b) => {
      if (b.reward !== a.reward) return b.reward - a.reward;
      return a.distanceToMe - b.distanceToMe;
    });

  const nearbyDeliveryTiles = buildNearbyDeliveryTiles(
    me,
    bs.map.deliveryTiles
  );

  const nearbyAgents = [...bs.agents.values()]
    .map((agent) => ({
      id: agent.id,
      name: agent.name,
      x: Math.round(agent.x),
      y: Math.round(agent.y),
      distanceToMe: distance(me, agent),
    }))
    .sort((a, b) => a.distanceToMe - b.distanceToMe);

  return {
    me: {
      id: me.id,
      name: me.name,
      x: Math.round(me.x),
      y: Math.round(me.y),
      score: me.score,
    },
    carried: {
      count: carriedParcels.length,
      totalReward: carriedParcels.reduce(
        (sum, parcel) => sum + (parcel.reward ?? 0),
        0
      ),
    },
    visibleParcels,
    nearbyDeliveryTiles,
    nearbyAgents,
  };
}

// ==========================================
// Plan normalization
// ==========================================

export function normalizeLLMPlan(llmPlan, bs) {
  if (!llmPlan || !Array.isArray(llmPlan.plan)) return [];

  const predicates = [];

  for (const step of llmPlan.plan) {
    const predicate = normalizeLLMStep(step, bs);
    if (predicate) predicates.push(predicate);
  }

  return predicates;
}

function normalizeLLMStep(step, bs) {
  if (step.action === "go_pick_up") return normalizePickupStep(step, bs);
  if (step.action === "go_drop_off") return normalizeDropoffStep(step, bs);
  if (step.action === "explore") return ["explore"];
  return null;
}

function normalizePickupStep(step, bs) {
  const parcel = bs.parcels.get(step.parcelId);
  if (!parcel) return null;
  if (parcel.carriedBy) return null;

  return [
    "go_pick_up",
    Math.round(parcel.x),
    Math.round(parcel.y),
    parcel.id,
  ];
}

function normalizeDropoffStep(step, bs) {
  const x = Math.round(step.x);
  const y = Math.round(step.y);

  if (isDeliveryTile(x, y, bs.map.deliveryTiles)) {
    return ["go_drop_off", x, y];
  }

  const nearest = nearestDeliveryTileAt(
    bs.me,
    bs.map.deliveryDistanceMap
  );

  if (!nearest) return null;

  return ["go_drop_off", nearest.tile.x, nearest.tile.y];
}

// ==========================================
// Predicate validation
// ==========================================

function hasCarriedParcels(bs) {
  return [...bs.parcels.values()].some(
    (parcel) => parcel.carriedBy === bs.me.id
  );
}

function validatePredicate(predicate, bs) {
  if (!Array.isArray(predicate) || predicate.length === 0) {
    return { ok: false, error: "Invalid predicate." };
  }

  const [action, x, y, parcelId] = predicate;

  if (action === "go_pick_up") {
    const parcel = bs.parcels.get(parcelId);
    if (!parcel) return { ok: false, error: `Parcel ${parcelId} not found.` };
    if (parcel.carriedBy) return { ok: false, error: `Parcel ${parcelId} is already carried.` };
    return { ok: true };
  }

  if (action === "go_drop_off") {
    if (!hasCarriedParcels(bs)) {
      return { ok: false, error: "No carried parcels to deliver." };
    }
    if (!isDeliveryTile(x, y, bs.map.deliveryTiles)) {
      return { ok: false, error: `Tile (${x}, ${y}) is not a delivery tile.` };
    }
    return { ok: true };
  }

  if (action === "explore") return { ok: true };

  return { ok: false, error: `Unknown predicate action "${action}".` };
}

// ==========================================
// Plan execution
// ==========================================

async function executePlan(predicates, bs, actions) {
  for (const predicate of predicates) {
    const validation = validatePredicate(predicate, bs);

    if (!validation.ok) {
      console.log(`[${bs.me.name ?? "LLM"}] Invalid predicate:`, predicate, validation.error);
      return false;
    }

    console.log(`[${bs.me.name ?? "LLM"}] Executing:`, predicate);
    await actions.executePredicate(predicate);
  }

  return true;
}

// ==========================================
// Entry point
// ==========================================

function timestamp() {
  return new Date().toISOString();
}

function logWithTime(name, ...args) {
  console.log(`[${timestamp()}] [${name ?? "LLM"}]`, ...args);
}

export async function startLLMAgent(socket, bs, actions) {
  logWithTime(bs.me.name, "Waiting for initial beliefs...");

  await waitUntil(() => isReady(bs), RUNTIME.READINESS_CHECK_DELAY_MS);

  logWithTime(bs.me.name, "Agent ready");

  while (true) {
    try {
      const state = buildLLMState(bs);
      const messages = buildPlanningMessages(state);
      const planningStartedAt = Date.now();

      logWithTime(bs.me.name, "Planning started");

      const llmPlan = await callLLMJson({
        messages,
        schema: PLAN_SCHEMA,
        temperature: 0,
      });

      logWithTime(bs.me.name, `Planning finished in ${Date.now() - planningStartedAt}ms`);

      let predicates = normalizeLLMPlan(llmPlan, bs);

      if (predicates.length === 0) {
        predicates = [["explore"]];
      }

      logWithTime(bs.me.name, "Plan:", predicates);

      const executionStartedAt = Date.now();
      await executePlan(predicates, bs, actions);
      logWithTime(bs.me.name, `Execution finished in ${Date.now() - executionStartedAt}ms`);

      await wait(RUNTIME.LLM_LOOP_DELAY_MS);
    } catch (error) {
      logWithTime(bs.me.name, "Error:", error?.message ?? error);
      await wait(RUNTIME.LLM_ERROR_DELAY_MS);
    }
  }
}