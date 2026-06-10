import { bfs } from "./bfs.js";
import { astar } from "./astar.js";

/*
 * Sceglie l'algoritmo di pathfinding da usare in base alla configurazione.
 */
export function findPath(start, goal, algorithm = "bfs", bs) {
  if (algorithm === "bfs") {
    return bfs(start, goal, bs);
  }

  if (algorithm === "astar") {
    return astar(start, goal, bs);
  }

  throw new Error(`Unknown pathfinding algorithm: ${algorithm}`);
}