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

export function createPlanLibrary({ socket, me, shouldPause = () => false }) {
    const planLibrary = [];

    async function waitWhilePaused() {
        while (shouldPause()) {
            await new Promise((res) => setImmediate(res));
        }
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

    class SimpleExplore extends Plan {
        static isApplicableTo(explore) {
            return explore === 'explore';
        }

        async execute(explore) {
            const directions = ['up', 'right', 'down', 'left'];
            while (true) {
                let direction = directions[Math.floor(Math.random() * directions.length)];
                const moved = await socket.emitMove(direction);
                if (moved) {
                    me.x = moved.x;
                    me.y = moved.y;
                }
                await waitWhilePaused();
                if (this.stopped) {
                    throw ['stopped'];
                }
            }
        }
    }


    // Le classi piano vengono registrate nella libreria qui.
    planLibrary.push(GoPickUp);
    planLibrary.push(BlindMove);
    planLibrary.push(GoDropOff);
    planLibrary.push(SimpleExplore);


    return planLibrary;
}
