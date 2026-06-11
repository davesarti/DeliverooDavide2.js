import { bfs } from "./bfs.js";
import { astar } from "./astar.js";

/*
 * Selects the pathfinding algorithm to use based on configuration.
 */
export function findPath(start, goal, algorithm = "bfs", bs, options = {}) {
  if (algorithm === "bfs") {
    return bfs(start, goal, bs, options);
  }

  if (algorithm === "astar") {
    return astar(start, goal, bs, options);
  }

  throw new Error(`Unknown pathfinding algorithm: ${algorithm}`);
}