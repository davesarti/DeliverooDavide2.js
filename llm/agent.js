import { beliefState } from "../beliefs/beliefState.js";
import { distance } from "../utils/mapUtils.js";
import {
  enrichParcelForDecision,
  buildNearbyDeliveryTiles,
} from "../utils/stateUtils.js";

const MAX_DELIVERY_OPTIONS_PER_PARCEL = 3;

/*
 * Costruisce lo stato corrente da passare all'LLM.
 * Questa funzione descrive solo l'ambiente: non aggiunge errori, obiettivi o decisioni.
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