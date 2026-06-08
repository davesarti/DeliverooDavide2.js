import { beliefState } from "../beliefs/beliefState.js";
import { distance } from "../utils/mapUtils.js";
import {
  formatParcelBasic,
  enrichParcelForDecision,
} from "../utils/stateUtils.js";

/*
 * Costruisce lo stato compatto che verrà passato all'LLM.
 * Qui non ci sono decisioni: prepariamo solo i dati in modo leggibile.
 */
export function buildLLMState() {
  const me = beliefState.me;

  const carriedParcels = [...beliefState.parcels.values()]
    .filter((parcel) => parcel.carriedBy === me.id)
    .map(formatParcelBasic);

  const visibleParcels = [...beliefState.parcels.values()]
    .filter((parcel) => !parcel.carriedBy)
    .map((parcel) =>
      enrichParcelForDecision(
        parcel,
        me,
        beliefState.map.deliveryDistanceMap
      )
    )
    .filter((parcel) => parcel.distanceToNearestDelivery != null)
    .sort((a, b) => {
      if (b.reward !== a.reward) return b.reward - a.reward;
      return a.distanceToMe - b.distanceToMe;
    });

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

    carriedParcels,
    visibleParcels,

    deliveryTiles: beliefState.map.deliveryTiles.map((tile) => ({
      x: tile.x,
      y: tile.y,
    })),

    nearbyAgents,

    map: {
      width: beliefState.map.width,
      height: beliefState.map.height,
    },
  };
}