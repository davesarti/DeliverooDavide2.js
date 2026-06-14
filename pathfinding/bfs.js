import {
  DIRECTIONS,
  canUseNeighborTile,
} from "../utils/mapUtils.js";

/*
 * Computes a BFS path using the full agent state.
 */
export function bfs(start, goal, bs, options = {}) {
  return bfsOnState({
    map: bs.map.grid,
    // ignoreCrates: treat crates as passable, so callers can test whether a
    // crate is what blocks the route (see goTo's crate-block detection).
    crates: options.ignoreCrates ? new Map() : bs.crates,
    agents: bs.agents,
    blockedTiles: options.blockedTiles ?? bs.map.blockedTiles,
    start,
    goal,
  });
}

/*
 * Finds the shortest path on the grid avoiding obstacles and occupants.
 */
export function bfsOnState({ map, crates = new Map(), agents = new Map(), blockedTiles = new Set(), start, goal }) {
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
      if (visited[nextY][nextX]) continue;

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