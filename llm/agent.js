import { beliefState } from "../beliefs/beliefState.js";
import { callLLMJson } from "./client.js";
import { buildPlanningMessages, PLAN_SCHEMA } from "./prompts.js";
import { executePredicate } from "../actions/actions.js";
import { distance, isDeliveryTile } from "../utils/mapUtils.js";
import {
  nearestDeliveryTileAt,
  enrichParcelForDecision,
  buildNearbyDeliveryTiles,
} from "../utils/stateUtils.js";
import { wait, waitUntil } from "../utils/asyncUtils.js";
import { RUNTIME } from "../utils/constants.js";

const MAX_DELIVERY_OPTIONS_PER_PARCEL = 3;



/*
 * Controlla se l'agente ha già ricevuto le informazioni minime per partire:
 * identità, posizione, mappa e delivery tiles.
 */
function isReady() {
  return (
    beliefState.me.id &&
    beliefState.me.x != null &&
    beliefState.me.y != null &&
    Array.isArray(beliefState.map.grid) &&
    beliefState.map.grid.length > 0 &&
    Array.isArray(beliefState.map.deliveryTiles) &&
    beliefState.map.deliveryTiles.length > 0
  );
}

/*
 * Costruisce lo stato compatto da passare all'LLM.
 * Lo stato contiene solo informazioni utili alla decisione, non tutto il beliefState grezzo.
 */
export function buildLLMState() {
  const me = beliefState.me;

  const carriedParcels = [...beliefState.parcels.values()].filter(
    (parcel) => parcel.carriedBy === me.id
  );

  const visibleParcels = [...beliefState.parcels.values()]
    .filter((parcel) => !parcel.carriedBy)
    .map((parcel) =>
      enrichParcelForDecision(
        parcel,
        me,
        beliefState.map.deliveryDistanceMap,
        {
          maxDeliveryOptions: MAX_DELIVERY_OPTIONS_PER_PARCEL,
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
    beliefState.map.deliveryTiles
  );

  const nearbyAgents = [...beliefState.agents.values()]
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

/*
 * Converte il piano JSON dell'LLM in predicate eseguibili dal runtime.
 * Il JSON è già valido strutturalmente perché viene controllato in client.js.
 */
export function normalizeLLMPlan(llmPlan) {
  if (!llmPlan || !Array.isArray(llmPlan.plan)) {
    return [];
  }

  const predicates = [];

  for (const step of llmPlan.plan) {
    const predicate = normalizeLLMStep(step);

    if (predicate) {
      predicates.push(predicate);
    }
  }

  return predicates;
}

/*
 * Normalizza un singolo step JSON in una predicate interna.
 * Le predicate sono il formato che l'esecutore sa interpretare.
 */
function normalizeLLMStep(step) {
  if (step.action === "go_pick_up") {
    return normalizePickupStep(step);
  }

  if (step.action === "go_drop_off") {
    return normalizeDropoffStep(step);
  }

  if (step.action === "explore") {
    return ["explore"];
  }

  return null;
}

/*
 * Normalizza una pickup.
 * Usa sempre le coordinate reali del pacco presenti nel beliefState, non quelle eventualmente inventate dall'LLM.
 */
function normalizePickupStep(step) {
  const parcel = beliefState.parcels.get(step.parcelId);

  if (!parcel) return null;
  if (parcel.carriedBy) return null;

  return [
    "go_pick_up",
    Math.round(parcel.x),
    Math.round(parcel.y),
    parcel.id,
  ];
}

/*
 * Normalizza una dropoff.
 * Se la tile indicata dall'LLM non è una delivery tile valida, usa la delivery più vicina.
 */
function normalizeDropoffStep(step) {
  const x = Math.round(step.x);
  const y = Math.round(step.y);

  if (isDeliveryTile(x, y, beliefState.map.deliveryTiles)) {
    return ["go_drop_off", x, y];
  }

  const nearest = nearestDeliveryTileAt(
    beliefState.me,
    beliefState.map.deliveryDistanceMap
  );

  if (!nearest) return null;

  return [
    "go_drop_off",
    nearest.tile.x,
    nearest.tile.y,
  ];
}

/*
 * Controlla se l'agente sta trasportando almeno un pacco.
 * Serve per capire se una dropoff ha senso prima di eseguirla.
 */
function hasCarriedParcels() {
  return [...beliefState.parcels.values()].some(
    (parcel) => parcel.carriedBy === beliefState.me.id
  );
}

/*
 * Valida una predicate rispetto al beliefState corrente.
 * Questa non è validazione JSON: controlla se l'azione è davvero sensata ora.
 */
function validatePredicate(predicate) {
  if (!Array.isArray(predicate) || predicate.length === 0) {
    return {
      ok: false,
      error: "Invalid predicate.",
    };
  }

  const [action, x, y, parcelId] = predicate;

  if (action === "go_pick_up") {
    const parcel = beliefState.parcels.get(parcelId);

    if (!parcel) {
      return {
        ok: false,
        error: `Parcel ${parcelId} not found.`,
      };
    }

    if (parcel.carriedBy) {
      return {
        ok: false,
        error: `Parcel ${parcelId} is already carried.`,
      };
    }

    return { ok: true };
  }

  if (action === "go_drop_off") {
    if (!hasCarriedParcels()) {
      return {
        ok: false,
        error: "No carried parcels to deliver.",
      };
    }

    if (!isDeliveryTile(x, y, beliefState.map.deliveryTiles)) {
      return {
        ok: false,
        error: `Tile (${x}, ${y}) is not a delivery tile.`,
      };
    }

    return { ok: true };
  }

  if (action === "explore") {
    return { ok: true };
  }

  return {
    ok: false,
    error: `Unknown predicate action "${action}".`,
  };
}

/*
 * Esegue una lista di predicate una alla volta.
 * Se una predicate è invalida o fallisce, interrompe il piano e lascia ripianificare il loop principale.
 */
async function executePlan(predicates) {
  for (const predicate of predicates) {
    const validation = validatePredicate(predicate);

    if (!validation.ok) {
      console.log("[LLM] Invalid predicate:", predicate, validation.error);
      return false;
    }

    console.log("[LLM] Executing:", predicate);
    await executePredicate(predicate);
  }

  return true;
}

/*
 * Avvia il loop principale dell'agente LLM.
 * A ogni ciclo costruisce lo stato, chiede un piano al modello, lo normalizza, lo valida ed esegue.
 */
export async function startLLMAgent() {
  console.log("[LLM] Waiting for initial beliefs...");

  await waitUntil(
    isReady,
    RUNTIME.READINESS_CHECK_DELAY_MS
  );

  console.log("[LLM] Agent ready");

  while (true) {
    try {
      const state = buildLLMState();

      const messages = buildPlanningMessages(state);

      const llmPlan = await callLLMJson({
        messages,
        schema: PLAN_SCHEMA,
        temperature: 0,
      });

      let predicates = normalizeLLMPlan(llmPlan);

      if (predicates.length === 0) {
        predicates = [["explore"]];
      }

      console.log("[LLM] Plan:", predicates);

      await executePlan(predicates);

      await wait(RUNTIME.LLM_LOOP_DELAY_MS);
    } catch (error) {
      console.log("[LLM] Error:", error?.message ?? error);
      await wait(RUNTIME.LLM_ERROR_DELAY_MS);
    }
  }
}