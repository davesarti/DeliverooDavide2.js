import { bfs } from "./bfs.js";
import { astar } from "./astar.js";

export function findPath(start, goal, algorithm = "bfs") {
  if (algorithm === "bfs") {
    return bfs(start, goal);
  }

  if (algorithm === "astar") {
    return astar(start, goal);
  }

  throw new Error(`Unknown pathfinding algorithm: ${algorithm}`);
}