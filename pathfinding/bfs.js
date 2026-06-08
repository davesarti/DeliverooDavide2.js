import { beliefState } from "../beliefs/beliefState.js";
import {
  canEnterTile,
  DIRECTIONS,
  isOccupied,
} from "../utils/mapUtils.js";


export function bfs(start, goal) {
  return bfsOnState({
    map: beliefState.map.grid,
    crates: beliefState.crates,
    agents: beliefState.agents,
    start,
    goal,
  });
}

export function bfsOnState({ map, crates = new Map(), agents = new Map(), start, goal }) {
  if (!map.length || !map[0]?.length) {
    throw new Error("map not ready");
  }

  const startX = Math.round(start.x);
  const startY = Math.round(start.y);
  const goalX = Math.round(goal.x);
  const goalY = Math.round(goal.y);

  const queue = [{ x: startX, y: startY, path: [] }];
  const visited = Array.from(
    { length: map.length },
    () => Array(map[0].length).fill(false)
  );

  visited[startY][startX] = true;

  while (queue.length > 0) {
    const current = queue.shift();

    if (current.x === goalX && current.y === goalY) {
      return {
        path: current.path,
        distance: current.path.length,
      };
    }

    for (const { dx, dy, move } of DIRECTIONS) {
      const nextX = current.x + dx;
      const nextY = current.y + dy;

      const insideMap =
        nextX >= 0 &&
        nextX < map[0].length &&
        nextY >= 0 &&
        nextY < map.length;

      if (!insideMap) continue;
      if (visited[nextY][nextX]) continue;
      if (!canEnterTile(map[nextY][nextX], move)) continue;
      if (isOccupied(nextX, nextY, crates)) continue;
      if (isOccupied(nextX, nextY, agents)) continue;

      visited[nextY][nextX] = true;

      queue.push({
        x: nextX,
        y: nextY,
        path: [...current.path, move],
      });
    }
  }

  return null;
}