import {
    AGENT_AVOID_RADIUS,
    AGENT_AVOID_WEIGHT,
    BASE_STEP_COST,
    MIN_EDGE_COST,
    PARCEL_REWARD_DISCOUNT,
    MAX_CONSECUTIVE_WAITS,
    ASTAR_WAIT_MS,
    findCellToExplore
} from './utils.js';
import {Heap} from 'heap-js';

const GO_TO_TIMEOUT_MS = 5000;

export class Plan {
    #stopped = false;
    #parent;
    #subIntentions = [];
    #createSubIntention;

    constructor(parent, { createSubIntention }) {
        this.#parent = parent;
        this.#createSubIntention = createSubIntention;
    }

    stop() {
        this.#stopped = true;
        for (const intention of this.#subIntentions) {
            intention.stop();
        }
    }

    get stopped() {
        return this.#stopped;
    }

    log(...args) {
        if (this.#parent && this.#parent.log) {
            this.#parent.log('\t', ...args);
        } else {
            console.log(...args);
        }
    }

    async subIntention(predicate) {
        const subIntention = this.#createSubIntention(predicate);
        this.#subIntentions.push(subIntention);
        return subIntention.achieve();
    }
}

export function createPlanLibrary({ socket, me, spawnTiles, map, crates, parcels = new Map(), agents = new Map(), shouldPause = () => false }) {
    const planLibrary = [];

    function isOccupied(x, y, objects) {
        for (const obj of objects.values()) {
            if (obj.x === x && obj.y === y) return true;
        }
        return false;
    }

    function isAgentOccupied(x, y) {
        for (const agent of agents.values()) {
            if (agent.x === x && agent.y === y) return true;
        }
        return false;
    }

    function agentProximityCost(x, y) {
        let cost = 0;
        const sigma = Math.max(AGENT_AVOID_RADIUS / 2, 1);
        for (const agent of agents.values()) {
            const dx = Math.abs(agent.x - x);
            const dy = Math.abs(agent.y - y);
            const dist = dx + dy;
            if (dist <= 1) {
                return Number.POSITIVE_INFINITY;
            }
            if (dist <= AGENT_AVOID_RADIUS) {
                const gaussian = Math.exp(-(dist * dist) / (2 * sigma * sigma));
                cost += gaussian * AGENT_AVOID_WEIGHT;
            }
        }
        return cost;
    }
    
    async function waitWhilePaused() {
        while (shouldPause()) {
            await new Promise((res) => setImmediate(res));
        }
    }

    async function executePath(path, shouldStop = () => false, onStep = null, timeoutMs = null) {
        const startedAt = Date.now();
        for (const dir of path) {
            await waitWhilePaused();
            if (shouldStop()) {
                throw ['stopped'];
            }
            if (timeoutMs != null && Date.now() - startedAt > timeoutMs) {
                throw 'go_to timeout';
            }

            const moved = await socket.emitMove(dir);
            if (!moved) {
                throw 'movement failed';
            }

            me.x = moved.x;
            me.y = moved.y;

            if (onStep) {
                await onStep();
            }

            if (shouldStop()) {
                throw ['stopped'];
            }
        }
        return true;
    }

    class GoPickUp extends Plan {
        static isApplicableTo(go_pick_up, x, y, id) {
            return go_pick_up === 'go_pick_up';
        }

        async execute(go_pick_up, x, y) {
            await waitWhilePaused();
            if (this.stopped) {
                throw ['stopped'];
            }
            await this.subIntention(['go_to', x, y]);
            await waitWhilePaused();
            if (this.stopped) {
                throw ['stopped'];
            }
            await socket.emitPickup();
            if (this.stopped) {
                throw ['stopped'];
            }
            return true;
        }
    }

    class GoDropOff extends Plan {
        static isApplicableTo(go_drop_off, x, y) {
            return go_drop_off === 'go_drop_off';
        }

        async execute(go_drop_off, x, y) {
            await waitWhilePaused();
            if (this.stopped) {
                throw ['stopped'];
            }
            await this.subIntention(['go_to', x, y]);
            await waitWhilePaused();
            if (this.stopped) {
                throw ['stopped'];
            }
            await socket.emitPutdown();
            if (this.stopped) {
                throw ['stopped'];
            }
            return true;
        }
    }

    class BlindMove extends Plan {
        static isApplicableTo(go_to, x, y) {
            return go_to === 'go_to';
        }

        async execute(go_to, x, y) {
            const startedAt = Date.now();
            while (me.x !== x || me.y !== y) {
                await waitWhilePaused();
                if (this.stopped) {
                    throw ['stopped'];
                }
                if (Date.now() - startedAt > GO_TO_TIMEOUT_MS) {
                    throw 'go_to timeout';
                }
                let movedHorizontally;
                let movedVertically;

                if (x > me.x) {
                    movedHorizontally = await socket.emitMove('right');
                } else if (x < me.x) {
                    movedHorizontally = await socket.emitMove('left');
                }

                if (movedHorizontally) {
                    me.x = movedHorizontally.x;
                    me.y = movedHorizontally.y;
                }

                await waitWhilePaused();
                if (this.stopped) {
                    throw ['stopped'];
                }

                if (y > me.y) {
                    movedVertically = await socket.emitMove('up');
                } else if (y < me.y) {
                    movedVertically = await socket.emitMove('down');
                }

                if (movedVertically) {
                    me.x = movedVertically.x;
                    me.y = movedVertically.y;
                }

                if (!movedHorizontally && !movedVertically) {
                    this.log('stucked');
                    throw 'stucked';
                }
            }
            return true;
        }
    }

    class BFSMove extends Plan {
        static isApplicableTo(go_to, x, y) {
            return go_to === 'go_to';
        }
        
        findPath(targetX, targetY) {

            if (!map.length || !map[0]?.length) {
                throw 'map not ready';
            }

            const queue = [];
            const height = map.length;
            const width = map[0].length;

            const visited = Array.from(
                { length: height },
                () => Array(width).fill(false)
            );

            queue.push({ x: me.x, y: me.y, path: [] });
            visited[me.y][me.x] = true;

            const directions = [
                { dx: 1, dy: 0, move: 'right' },
                { dx: -1, dy: 0, move: 'left' },
                { dx: 0, dy: 1, move: 'up' },
                { dx: 0, dy: -1, move: 'down' }
            ];

            while (queue.length > 0) {
                const current = queue.shift();

                if (current.x === targetX && current.y === targetY) {
                    return current.path;
                }

                for (const { dx, dy, move } of directions) {
                    const newX = current.x + dx;
                    const newY = current.y + dy;

                    const insideMap =
                        newX >= 0 && newX < width &&
                        newY >= 0 && newY < height;

                    if (!insideMap) continue;
                    if (visited[newY][newX]) continue;
                    if (Number(map[newY][newX]) === 0) continue;
                    if (map[newY][newX] == "↓" && move === 'up') continue;
                    if (map[newY][newX] == "↑" && move === 'down') continue;
                    if (map[newY][newX] == "→" && move === 'left') continue;
                    if (map[newY][newX] == "←" && move === 'right') continue;
                    if (isOccupied(newX, newY, crates)) continue;
                    if (isAgentOccupied(newX, newY)) continue;

                    visited[newY][newX] = true;

                    queue.push({
                        x: newX,
                        y: newY,
                        path: [...current.path, move]
                    });
                }
            }

            return null;
        }

        async execute(go_to, x, y) {
            await waitWhilePaused();
            if (this.stopped) throw ['stopped'];

            const path = this.findPath(x, y);

            if (!path) {
                throw 'path not found';
            }

            await waitWhilePaused();
            if (this.stopped) throw ['stopped'];

            return await executePath(path, () => this.stopped, null, GO_TO_TIMEOUT_MS);
        }
    }

    class AStarMove extends Plan {
        static isApplicableTo(go_to, x, y) {
            return go_to === 'go_to';
        }

        #key(x, y) {
            return `${x},${y}`;
        }

        #heuristic(x, y, targetX, targetY) {
            return (Math.abs(x - targetX) + Math.abs(y - targetY)) * MIN_EDGE_COST;
        }

        #reconstructPath(cameFrom, currentKey) {
            const path = [];
            let k = currentKey;
            while (cameFrom.has(k)) {
                const { prev, move } = cameFrom.get(k);
                path.unshift(move);
                k = prev;
            }
            return path;
        }

        #buildParcelRewardByKey() {
            const rewards = new Map();
            for (const parcel of parcels.values()) {
                if (parcel.carriedBy) continue;
                const k = this.#key(parcel.x, parcel.y);
                rewards.set(k, (rewards.get(k) ?? 0) + (parcel.reward ?? 0));
            }
            return rewards;
        }

        // Restituisce il costo per entrare nella cella (nx, ny) con la mossa `move`.
        // Restituisce Infinity se la cella è invalida (muro, fuori mappa,
        // direzione vietata, cassa) — così il loop principale non ha bisogno
        // di nessun `continue` esplicito per i controlli di validità.
        #moveCost(nx, ny, move, width, height, rewardByKey) {
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) return Infinity;
            const cell = map[ny][nx];
            if (Number(cell) === 0)                return Infinity;
            if (cell === '↓' && move === 'up')     return Infinity;
            if (cell === '↑' && move === 'down')   return Infinity;
            if (cell === '→' && move === 'left')   return Infinity;
            if (cell === '←' && move === 'right')  return Infinity;
            if (isOccupied(nx, ny, crates))        return Infinity;
            if (isAgentOccupied(nx, ny))           return Infinity;

            // Cella valida: costo base ridotto dalla reward del pacco (se presente),
            // ma mai sotto MIN_EDGE_COST per non rompere A*.
            const reward = rewardByKey.get(this.#key(nx, ny)) ?? 0;
            return Math.max(MIN_EDGE_COST, BASE_STEP_COST - reward * PARCEL_REWARD_DISCOUNT);
        }

        async #tryPickupHere() {
            for (const parcel of parcels.values()) {
                if (parcel.carriedBy) continue;
                if (parcel.x === me.x && parcel.y === me.y) {
                    await socket.emitPickup();
                    return;
                }
            }
        }

        findPath(targetX, targetY) {
            if (!map.length || !map[0]?.length) throw 'map not ready';
            if (me.x === targetX && me.y === targetY) return [];

            const height = map.length;
            const width  = map[0].length;
            const rewardByKey = this.#buildParcelRewardByKey();

            const gScore   = new Map();
            const fScore   = new Map();
            const cameFrom = new Map();
            const closedSet   = new Set();  // nodi già espansi: non vengono mai rivisitati

            const startKey = this.#key(me.x, me.y);
            gScore.set(startKey, 0);
            fScore.set(startKey, this.#heuristic(me.x, me.y, targetX, targetY));

            // Min-heap ordinata per fScore crescente: pop() estrae sempre
            // il nodo con f più basso in O(log n) invece di O(n log n) del sort.
            const openSet = new Heap((a, b) =>
                (fScore.get(this.#key(a.x, a.y)) ?? Infinity) -
                (fScore.get(this.#key(b.x, b.y)) ?? Infinity)
            );
            const openSetKeys = new Set([startKey]);
            openSet.push({ x: me.x, y: me.y });

            const directions = [
                { dx:  1, dy:  0, move: 'right' },
                { dx: -1, dy:  0, move: 'left'  },
                { dx:  0, dy:  1, move: 'up'    },
                { dx:  0, dy: -1, move: 'down'  }
            ];

            while (openSet.size() > 0) {
                const current    = openSet.pop();
                const currentKey = this.#key(current.x, current.y);
                openSetKeys.delete(currentKey);

                // Il nodo potrebbe essere nell'heap con un fScore vecchio
                // (aggiornato ma non rimosso): lo saltiamo se già espanso.
                if (closedSet.has(currentKey)) continue;
                closedSet.add(currentKey);

                if (current.x === targetX && current.y === targetY) {
                    return this.#reconstructPath(cameFrom, currentKey);
                }

                for (const { dx, dy, move } of directions) {
                    const nx = current.x + dx;
                    const ny = current.y + dy;
                    const neighborKey = this.#key(nx, ny);

                    if (closedSet.has(neighborKey)) continue;

                    // #moveCost restituisce Infinity per celle non valide:
                    // non servono più i continue espliciti per ogni controllo.
                    const cost = this.#moveCost(nx, ny, move, width, height, rewardByKey);
                    if (!isFinite(cost)) continue;

                    const tentativeG = (gScore.get(currentKey) ?? Infinity) + cost;

                    if (tentativeG < (gScore.get(neighborKey) ?? Infinity)) {
                        cameFrom.set(neighborKey, { prev: currentKey, move });
                        gScore.set(neighborKey, tentativeG);
                        fScore.set(neighborKey, tentativeG + this.#heuristic(nx, ny, targetX, targetY));
                        if (!openSetKeys.has(neighborKey)) {
                            openSet.push({ x: nx, y: ny });
                            openSetKeys.add(neighborKey);
                        }
                    }
                }
            }

            return null;
        }

        async execute(go_to, x, y) {
            await waitWhilePaused();
            if (this.stopped) throw ['stopped'];

            let consecutiveWaits = 10;
            const startedAt = Date.now();

            while (me.x !== x || me.y !== y) {
                await waitWhilePaused();
                if (this.stopped) throw ['stopped'];
                if (Date.now() - startedAt > GO_TO_TIMEOUT_MS) {
                    throw 'go_to timeout';
                }

                await this.#tryPickupHere();

                const path = this.findPath(x, y);
                if (!path) {
                    consecutiveWaits += 1;
                    if (consecutiveWaits > MAX_CONSECUTIVE_WAITS) {
                        throw 'wait limit exceeded';
                    }
                    await new Promise((res) => setTimeout(res, ASTAR_WAIT_MS));
                    continue;
                }

                if (path.length === 0) {
                    return true;
                }

                const move = path[0];
                const next = {
                    x: me.x + (move === 'right' ? 1 : move === 'left' ? -1 : 0),
                    y: me.y + (move === 'up' ? 1 : move === 'down' ? -1 : 0)
                };

                const risk = agentProximityCost(next.x, next.y);
                if (!Number.isFinite(risk)) {
                    consecutiveWaits += 1;
                    if (consecutiveWaits > MAX_CONSECUTIVE_WAITS) {
                        throw 'wait limit exceeded';
                    }
                    await new Promise((res) => setTimeout(res, ASTAR_WAIT_MS));
                    continue;
                }

                const moved = await socket.emitMove(move);
                if (!moved) {
                    throw 'movement failed';
                }

                me.x = moved.x;
                me.y = moved.y;
                consecutiveWaits = 0;
            }

            return true;
        }
    }

    class SimpleExplore extends Plan {
        static isApplicableTo(explore) {
            return explore === 'explore';
        }

        async execute(explore) {
            const cell = findCellToExplore(spawnTiles, me);
            if (!cell) {
                 throw ['no spawn tiles available'];
            }
            await this.subIntention(['go_to', cell.x, cell.y]);
            return true;
        }
    }


    // Le classi piano vengono registrate nella libreria qui.
    planLibrary.push(GoPickUp);
    //planLibrary.push(BlindMove);
    planLibrary.push(GoDropOff);
    planLibrary.push(SimpleExplore);
    planLibrary.push(AStarMove);
    planLibrary.push(BFSMove);

    return planLibrary;
}
