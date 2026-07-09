import { Heap } from "heap-js";
import {
  DIRECTIONS,
  canUseNeighborTile,
  distance,
} from "../utils/mapUtils.js";
import {
  BASE_STEP_COST,
  SOFT_OBSTACLE_HARD_RADIUS,
  AGENT_SOFT_PENALTY,
} from "../utils/constants.js";

/*
 * Computes the real travel cost from `start` to EVERY reachable tile in one
 * pass, using the same edge costs as A* (base step + soft agent penalty +
 * LLM rule penalties). Used by target-selection code (explore ranking, camp
 * anchor) so a candidate whose only access runs through a penalized corridor
 * is scored by what reaching it actually costs — A* alone can't provide this
 * without one point-to-point search per candidate. Movement itself still
 * goes through goTo/A*, which replans per step; this map only decides WHERE
 * to go, never HOW.
 */
export function dijkstraCosts(start, bs, options = {}) {
  return dijkstraCostsOnState({
    map: bs.map.grid,
    crates: bs.crates,
    agents: bs.agents,
    blockedTiles: options.blockedTiles ?? bs.map.blockedTiles ?? new Set(),
    penaltyTiles: bs.rules?.penaltyTiles ?? new Map(),
    start,
  });
}

/*
 * Uniform-cost search over the whole grid: A* without a goal, a heuristic or
 * path tracking. Returns a Map keyed "x,y" -> cost from start (in step units,
 * BASE_STEP_COST = 1); a missing key means the tile is unreachable right now.
 * Agents split hard/soft exactly like astarOnState so both searches agree on
 * which tiles cost extra and which block outright.
 */
export function dijkstraCostsOnState({
  map,
  crates = new Map(),
  agents = new Map(),
  blockedTiles = new Set(),
  penaltyTiles = new Map(),
  start,
}) {
  if (!map.length || !map[0]?.length) {
    throw new Error("map not ready");
  }

  const startX = Math.round(start.x);
  const startY = Math.round(start.y);

  const hardAgents = new Map();
  const softAgentTiles = new Set();

  for (const [id, agent] of agents) {
    if (distance({ x: startX, y: startY }, agent) <= SOFT_OBSTACLE_HARD_RADIUS) {
      hardAgents.set(id, agent);
    } else {
      softAgentTiles.add(`${Math.round(agent.x)},${Math.round(agent.y)}`);
    }
  }

  const heap = new Heap((a, b) => a.g - b.g);
  heap.push({ x: startX, y: startY, g: 0 });

  const costs = new Map();

  while (!heap.isEmpty()) {
    const current = heap.pop();
    const key = `${current.x},${current.y}`;

    if (costs.has(key)) continue;
    costs.set(key, current.g);

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
          agents: hardAgents,
          blockedTiles,
        })
      ) {
        continue;
      }

      if (costs.has(`${nextX},${nextY}`)) continue;

      let edgeCost = BASE_STEP_COST;

      if (softAgentTiles.has(`${nextX},${nextY}`)) {
        edgeCost += AGENT_SOFT_PENALTY;
      }

      const penaltyEntry = penaltyTiles.get(`${nextX},${nextY}`);
      if (penaltyEntry) {
        edgeCost += penaltyEntry.penalty;
      }

      heap.push({ x: nextX, y: nextY, g: current.g + edgeCost });
    }
  }

  return costs;
}
