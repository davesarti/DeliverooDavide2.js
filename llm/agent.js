import { beliefState } from "../beliefs/beliefState.js";
import { nearestDeliveryTileAt } from "../utils/stateUtils.js";
import { enrichParcelForDecision, buildNearbyDeliveryTiles, distance, isDeliveryTile} from "../utils/stateUtils.js";

const MAX_DELIVERY_OPTIONS_PER_PARCEL = 3;

/*
 * Costruisce lo stato corrente da passare all'LLM.
 * Questa funzione descrive solo l'ambiente di gioco e passa informazioni utili per la pianificazione.
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
 * Converte il piano JSON dell'LLM in predicate eseguibili.
 * Corregge solo gli errori sicuri, come coordinate pickup sbagliate
 * o delivery non valida sostituibile con la delivery raggiungibile più vicina.
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
 * Normalizza una singola azione prodotta dall'LLM.
 */
function normalizeLLMStep(step) {
  if (!step || typeof step.action !== "string") {
    return null;
  }

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
 * Valida una pickup.
 * Se il parcelId è corretto, usa sempre le coordinate reali del pacco.
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
 * Valida una dropoff.
 * Se la delivery indicata non è valida, prova a sostituirla
 * con la delivery raggiungibile più vicina alla posizione attuale.
 */
function normalizeDropoffStep(step) {
  const x = Math.round(step.x);
  const y = Math.round(step.y);

  if (isDeliveryTile(x, y)) {
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

