import { Heap } from "heap-js";
import { beliefState } from "../beliefs/beliefState.js";
import {canEnterTile, DIRECTIONS, isOccupied} from "../utils/mapUtils.js";
import { BASE_STEP_COST, MIN_EDGE_COST, PARCEL_REWARD_DISCOUNT } from "../utils/constants.js";

export function astar(start, goal) {
  return astarOnState({
    map: beliefState.map.grid,
    crates: beliefState.crates,
    agents: beliefState.agents,
    parcels: beliefState.parcels,
    start,
    goal,
  });
}

export function astarOnState({
  map,
  crates = new Map(),
  agents = new Map(),
  parcels = new Map(),
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
    return {
      path: [],
      distance: 0,
    };
  }

  const height = map.length;
  const width = map[0].length;

  const rewardByKey = buildParcelRewardByKey(parcels);

  const gScore = new Map();
  const fScore = new Map();
  const cameFrom = new Map();
  const closedSet = new Set();

  const startKey = key(startX, startY);

  gScore.set(startKey, 0);
  fScore.set(startKey, heuristic(startX, startY, goalX, goalY));

  const openSet = new Heap((a, b) => {
    const fa = fScore.get(key(a.x, a.y)) ?? Infinity;
    const fb = fScore.get(key(b.x, b.y)) ?? Infinity;
    return fa - fb;
  });

  const openSetKeys = new Set([startKey]);
  openSet.push({ x: startX, y: startY });

  while (openSet.size() > 0) {
    const current = openSet.pop();
    const currentKey = key(current.x, current.y);

    openSetKeys.delete(currentKey);

    if (closedSet.has(currentKey)) continue;
    closedSet.add(currentKey);

    if (current.x === goalX && current.y === goalY) {
      const path = reconstructPath(cameFrom, currentKey);

      return {
        path,
        distance: path.length,
      };
    }

    for (const { dx, dy, move } of DIRECTIONS) {
      const nextX = current.x + dx;
      const nextY = current.y + dy;
      const nextKey = key(nextX, nextY);

      if (closedSet.has(nextKey)) continue;

      const cost = moveCost({
        x: nextX,
        y: nextY,
        move,
        width,
        height,
        map,
        crates,
        agents,
        rewardByKey,
      });

      if (!Number.isFinite(cost)) continue;

      const tentativeG = (gScore.get(currentKey) ?? Infinity) + cost;

      if (tentativeG < (gScore.get(nextKey) ?? Infinity)) {
        cameFrom.set(nextKey, {
          prev: currentKey,
          move,
        });

        gScore.set(nextKey, tentativeG);
        fScore.set(
          nextKey,
          tentativeG + heuristic(nextX, nextY, goalX, goalY)
        );

        if (!openSetKeys.has(nextKey)) {
          openSet.push({ x: nextX, y: nextY });
          openSetKeys.add(nextKey);
        }
      }
    }
  }

  return null;
}




function key(x, y) {
  return `${x},${y}`;
}

function heuristic(x, y, goalX, goalY) {
  return (
    (Math.abs(x - goalX) + Math.abs(y - goalY)) *
    MIN_EDGE_COST
  );
}

function reconstructPath(cameFrom, currentKey) {
  const path = [];
  let current = currentKey;

  while (cameFrom.has(current)) {
    const { prev, move } = cameFrom.get(current);
    path.unshift(move);
    current = prev;
  }

  return path;
}

function buildParcelRewardByKey(parcels) {
  const rewards = new Map();

  for (const parcel of parcels.values()) {
    if (parcel.carriedBy) continue;

    const parcelKey = key(
      Math.round(parcel.x),
      Math.round(parcel.y)
    );

    rewards.set(
      parcelKey,
      (rewards.get(parcelKey) ?? 0) + (parcel.reward ?? 0)
    );
  }

  return rewards;
}

function moveCost({
  x,
  y,
  move,
  width,
  height,
  map,
  crates,
  agents,
  rewardByKey,
}) {
  if (x < 0 || x >= width || y < 0 || y >= height) {
    return Infinity;
  }

  const cell = map[y][x];

  if (!canEnterTile(cell, move)) {
    return Infinity;
  }

  if (isOccupied(x, y, crates)) {
    return Infinity;
  }

  if (isOccupied(x, y, agents)) {
    return Infinity;
  }

  const reward = rewardByKey.get(key(x, y)) ?? 0;

  return Math.max(
    MIN_EDGE_COST,
    BASE_STEP_COST - reward * PARCEL_REWARD_DISCOUNT
  );
}