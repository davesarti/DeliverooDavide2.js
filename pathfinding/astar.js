import { Heap } from "heap-js";
import {
  DIRECTIONS,
  canUseNeighborTile,
  distance,
} from "../utils/mapUtils.js";
import {
  BASE_STEP_COST,
  MIN_EDGE_COST,
  SOFT_OBSTACLE_HARD_RADIUS,
  AGENT_SOFT_PENALTY,
} from "../utils/constants.js";

/*
 * Computes an A* path using the full agent state.
 *
 * `options.avoidTiles` are tiles where a move was just physically refused
 * during the current goTo: they are hard-blocked for this plan (on top of
 * the static blockedTiles) so the replanner is forced onto a genuinely
 * different route instead of greedily re-entering a proven-blocked corridor.
 */
export function astar(start, goal, bs, options = {}) {
  const baseBlocked = options.blockedTiles ?? bs.map.blockedTiles ?? new Set();

  let blockedTiles = baseBlocked;
  if (options.avoidTiles && options.avoidTiles.size > 0) {
    blockedTiles = new Set(baseBlocked);
    for (const key of options.avoidTiles) blockedTiles.add(key);
  }

  return astarOnState({
    map: bs.map.grid,
    // ignoreCrates: treat crates as passable. Used to ask "would a path exist
    // if crates weren't in the way?" — i.e. whether a crate is the blocker and
    // a PDDL push could open the route (see goTo's crate-block detection).
    crates: options.ignoreCrates ? new Map() : bs.crates,
    agents: bs.agents,
    blockedTiles,
    // LLM rule tiles: soft cost, never hard blocks — keyed by "x,y" with a
    // { penalty } value. They make a route costlier (so A* prefers going
    // around) but never impassable, so a rule can never make a goal
    // unreachable and strand the agent.
    penaltyTiles: bs.rules?.penaltyTiles ?? new Map(),
    start,
    goal,
  });
}

/*
 * Finds a path with A* taking into account obstacles and estimated cost.
 *
 * Other agents are not all hard obstacles: only those close to the start
 * actually block us right now. Agents farther along the route will most
 * likely have moved by the time we arrive, so their tiles stay traversable
 * and just cost extra — the path prefers going around them but never fails
 * outright because someone stands in a corridor many tiles away.
 */
export function astarOnState({
  map,
  crates = new Map(),
  agents = new Map(),
  blockedTiles = new Set(),
  penaltyTiles = new Map(),
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

  // Split sensed agents into hard obstacles (near the start: they are in
  // the way now) and soft ones (far away: penalty only).
  const hardAgents = new Map();
  const softAgentTiles = new Set();

  for (const [id, agent] of agents) {
    if (distance({ x: startX, y: startY }, agent) <= SOFT_OBSTACLE_HARD_RADIUS) {
      hardAgents.set(id, agent);
    } else {
      softAgentTiles.add(`${Math.round(agent.x)},${Math.round(agent.y)}`);
    }
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
          agents: hardAgents,
          blockedTiles,
        })
      ) {
        continue;
      }

      if (visited.has(`${nextX},${nextY}`)) continue;

      let edgeCost = BASE_STEP_COST;

      if (softAgentTiles.has(`${nextX},${nextY}`)) {
        edgeCost += AGENT_SOFT_PENALTY;
      }

      // LLM rule penalty: entering a penalized tile costs extra, steering the
      // path around it without ever forbidding it.
      const penaltyEntry = penaltyTiles.get(`${nextX},${nextY}`);
      if (penaltyEntry) {
        edgeCost += penaltyEntry.penalty;
      }

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
