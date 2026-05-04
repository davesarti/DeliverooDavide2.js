import {findCellToExplore} from './utils.js';

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

    const AGENT_AVOID_RADIUS = 5;
    const AGENT_AVOID_WEIGHT = 100;

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

    async function executePath(path, shouldStop = () => false, onStep = null) {
        for (const dir of path) {
            await waitWhilePaused();
            if (shouldStop()) {
                throw ['stopped'];
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
            while (me.x !== x || me.y !== y) {
                await waitWhilePaused();
                if (this.stopped) {
                    throw ['stopped'];
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

            return await executePath(path, () => this.stopped);
        }
    }

    const BASE_STEP_COST = 1;
    const MIN_EDGE_COST = 0.2;
    const PARCEL_REWARD_DISCOUNT = 0.1;
    const MAX_CONSECUTIVE_WAITS = 50;

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
            let key = currentKey;
            while (cameFrom.has(key)) {
                const { prev, move } = cameFrom.get(key);
                path.unshift(move);
                key = prev;
            }
            return path;
        }

        #buildParcelRewardByKey() {
            const rewards = new Map();
            for (const parcel of parcels.values()) {
                if (parcel.carriedBy) continue;
                const key = this.#key(parcel.x, parcel.y);
                rewards.set(key, (rewards.get(key) ?? 0) + (parcel.reward ?? 0));
            }
            return rewards;
        }

        #stepCostFor(key, rewardByKey, x, y) {
            const reward = rewardByKey.get(key) ?? 0;
            const discounted = BASE_STEP_COST - reward * PARCEL_REWARD_DISCOUNT;
            const base = Math.max(MIN_EDGE_COST, discounted);
            const agentCost = agentProximityCost(x, y);
            if (!Number.isFinite(agentCost)) {
                return Number.POSITIVE_INFINITY;
            }
            return base + agentCost;
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
            if (!map.length || !map[0]?.length) {
                throw 'map not ready';
            }

            if (me.x === targetX && me.y === targetY) {
                return [];
            }

            const height = map.length;
            const width = map[0].length;

            const openSet = [{ x: me.x, y: me.y }];
            const openSetKeys = new Set([this.#key(me.x, me.y)]);

            const cameFrom = new Map();
            const gScore = new Map();
            gScore.set(this.#key(me.x, me.y), 0);

            const fScore = new Map();
            fScore.set(
                this.#key(me.x, me.y),
                this.#heuristic(me.x, me.y, targetX, targetY)
            );

            const rewardByKey = this.#buildParcelRewardByKey();

            const directions = [
                { dx: 1, dy: 0, move: 'right' },
                { dx: -1, dy: 0, move: 'left' },
                { dx: 0, dy: 1, move: 'up' },
                { dx: 0, dy: -1, move: 'down' }
            ];

            while (openSet.length > 0) {
                openSet.sort((a, b) =>
                    (fScore.get(this.#key(a.x, a.y)) ?? Number.MAX_VALUE) -
                    (fScore.get(this.#key(b.x, b.y)) ?? Number.MAX_VALUE)
                );

                const current = openSet.shift();
                const currentKey = this.#key(current.x, current.y);
                openSetKeys.delete(currentKey);

                if (current.x === targetX && current.y === targetY) {
                    return this.#reconstructPath(cameFrom, currentKey);
                }

                for (const { dx, dy, move } of directions) {
                    const newX = current.x + dx;
                    const newY = current.y + dy;

                    const insideMap =
                        newX >= 0 && newX < width &&
                        newY >= 0 && newY < height;

                    if (!insideMap) continue;
                    if (Number(map[newY][newX]) === 0) continue;
                    if (map[newY][newX] == "↓" && move === 'up') continue;
                    if (map[newY][newX] == "↑" && move === 'down') continue;
                    if (map[newY][newX] == "→" && move === 'left') continue;
                    if (map[newY][newX] == "←" && move === 'right') continue;
                    if (isOccupied(newX, newY, crates)) continue;
                    if (isAgentOccupied(newX, newY)) continue;

                    const neighborKey = this.#key(newX, newY);
                    const stepCost = this.#stepCostFor(neighborKey, rewardByKey, newX, newY);
                    if (!Number.isFinite(stepCost)) continue;
                    const tentativeGScore = (gScore.get(currentKey) ?? Number.MAX_VALUE) + stepCost;

                    if (tentativeGScore < (gScore.get(neighborKey) ?? Number.MAX_VALUE)) {
                        cameFrom.set(neighborKey, { prev: currentKey, move });
                        gScore.set(neighborKey, tentativeGScore);
                        fScore.set(
                            neighborKey,
                            tentativeGScore + this.#heuristic(newX, newY, targetX, targetY)
                        );
                        if (!openSetKeys.has(neighborKey)) {
                            openSet.push({ x: newX, y: newY });
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

            while (me.x !== x || me.y !== y) {
                await waitWhilePaused();
                if (this.stopped) throw ['stopped'];

                await this.#tryPickupHere();

                const path = this.findPath(x, y);
                if (!path) {
                    consecutiveWaits += 1;
                    if (consecutiveWaits > MAX_CONSECUTIVE_WAITS) {
                        throw 'wait limit exceeded';
                    }
                    this.log('wait', 'no path', `count=${consecutiveWaits}`);
                    await new Promise((res) => setImmediate(res));
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
                    await new Promise((res) => setImmediate(res));
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
