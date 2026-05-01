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

export function createPlanLibrary({ socket, me, spawnTiles, map, crates, shouldPause = () => false }) {
    const planLibrary = [];

    function isOccupied(x, y, objects) {
        for (const obj of objects.values()) {
            if (obj.x === x && obj.y === y) return true;
        }
        return false;
    }
    
    async function waitWhilePaused() {
        while (shouldPause()) {
            await new Promise((res) => setImmediate(res));
        }
    }

    async function executePath(path, shouldStop = () => false) {
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
    planLibrary.push(BFSMove);


    return planLibrary;
}
