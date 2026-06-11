import { Heap } from "heap-js";
import {
  DIRECTIONS,
  canUseNeighborTile,
} from "../utils/mapUtils.js";
import {
  BASE_STEP_COST,
  MIN_EDGE_COST,
  PARCEL_REWARD_DISCOUNT,
} from "../utils/constants.js";

/*
 * Calcola un percorso A* usando lo stato completo dell'agente.
 */
export function astar(start, goal, bs) {
  return astarOnState({
    map: bs.map.grid,
    crates: bs.crates,
    agents: bs.agents,
    parcels: bs.parcels,
    blockedTiles: bs.map.blockedTiles,
    start,
    goal,
  });
}

/*
 * Cerca un percorso con A* tenendo conto di ostacoli e costo stimato.
 */
export function astarOnState({
  map,
  crates = new Map(),
  agents = new Map(),
  parcels = new Map(),
  blockedTiles = new Set(),
  start,
  goal,
}) {
  if (!map.length || !map[0]?.length) {
    throw new Error("map not ready");
  }

  const startX = Math.round(start.x);
  const startY = Math.round(start.y);
  const goalX = Math.round(goal.x);
  const goalY = Math.round(goal.y);

  if (startX === goalX && startY === goalY) {
    return { path: [], distance: 0 };
  }

  const heuristic = (x, y) =>
    (Math.abs(x - goalX) + Math.abs(y - goalY)) * MIN_EDGE_COST;

  const heap = new Heap((a, b) => a.f - b.f);
  heap.push({ x: startX, y: startY, g: 0, f: heuristic(startX, startY), path: [] });

  const visited = new Map();

  while (!heap.isEmpty()) {
    const current = heap.pop();
    const key = `${current.x},${current.y}`;

    if (visited.has(key)) continue;
    visited.set(key, true);

    if (current.x === goalX && current.y === goalY) {
      return {
        path: current.path,
        distance: current.path.length,
      };
    }

    for (const { dx, dy, move } of DIRECTIONS) {
      const nextX = current.x + dx;
      const nextY = current.y + dy;

      if (
        !canUseNeighborTile({
          x: nextX,
          y: nextY,
          move,
          map,
          crates,
          agents,
          blockedTiles,
        })
      ) {
        continue;
      }

      if (visited.has(`${nextX},${nextY}`)) continue;

      const parcel = [...parcels.values()].find(
        (p) => Math.round(p.x) === nextX && Math.round(p.y) === nextY && !p.carriedBy
      );

      const edgeCost = parcel
        ? Math.max(MIN_EDGE_COST, BASE_STEP_COST - parcel.reward * PARCEL_REWARD_DISCOUNT)
        : BASE_STEP_COST;

      const g = current.g + edgeCost;
      const f = g + heuristic(nextX, nextY);

      heap.push({
        x: nextX,
        y: nextY,
        g,
        f,
        path: [...current.path, move],
      });
    }
  }

  return null;
}