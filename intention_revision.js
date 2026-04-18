import { distance } from './utils.js';

export function createOptionsGeneration({ parcels, me, agent }) {
    // TODO revisit beliefset revision so to trigger option generation only in the case a new parcel is observed (from lab comments)
    return function optionsGeneration() {
        const options = [];
        for (const parcel of parcels.values()) {
            if (!parcel.carriedBy) {
                options.push(['go_pick_up', parcel.x, parcel.y, parcel.id]);
            }
        }

        let bestOption;
        let nearest = Number.MAX_VALUE;

        for (const option of options) {
            if (option[0] === 'go_pick_up') {
                const [, x, y] = option;
                const currentDistance = distance({ x, y }, me);
                if (currentDistance < nearest) {
                    bestOption = option;
                    nearest = currentDistance;
                }
            }
        }

        if (bestOption) {
            agent.push(bestOption);
        }
    };
}

class Intention {
    #currentPlan;
    #stopped = false;
    #parent;
    #predicate;
    #started = false;
    #planLibrary;

    constructor(parent, predicate, planLibrary) {
        this.#parent = parent;
        this.#predicate = predicate;
        this.#planLibrary = planLibrary;
    }

    get predicate() {
        return this.#predicate;
    }

    get stopped() {
        return this.#stopped;
    }

    stop() {
        this.#stopped = true;
        if (this.#currentPlan) {
            this.#currentPlan.stop();
        }
    }

    log(...args) {
        if (this.#parent && this.#parent.log) {
            this.#parent.log('\t', ...args);
        } else {
            console.log(...args);
        }
    }

    async achieve() {
        if (this.#started) {
            return this;
        }
        this.#started = true;

        for (const planClass of this.#planLibrary) {
            if (this.stopped) {
                throw ['stopped intention', ...this.predicate];
            }

            if (planClass.isApplicableTo(...this.predicate)) {
                this.#currentPlan = new planClass(this.#parent, {
                    createSubIntention: (predicate) => new Intention(this, predicate, this.#planLibrary)
                });

                this.log('achieving intention', ...this.predicate, 'with plan', planClass.name);

                try {
                    const planResult = await this.#currentPlan.execute(...this.predicate);
                    this.log('succesful intention', ...this.predicate, 'with plan', planClass.name, 'with result:', planResult);
                    return planResult;
                } catch (error) {
                    this.log('failed intention', ...this.predicate, 'with plan', planClass.name, 'with error:', error);
                }
            }
        }

        if (this.stopped) {
            throw ['stopped intention', ...this.predicate];
        }

        throw ['no plan satisfied the intention', ...this.predicate];
    }
}

export class IntentionRevision {
    #intentionQueue = [];
    #parcels;
    #planLibrary;

    constructor({ parcels, planLibrary }) {
        this.#parcels = parcels;
        this.#planLibrary = planLibrary;
    }

    get intention_queue() {
        return this.#intentionQueue;
    }

    log(...args) {
        console.log(...args);
    }

    async loop() {
        while (true) {
            if (this.intention_queue.length > 0) {
                console.log('intentionRevision.loop', this.intention_queue.map((i) => i.predicate));

                const intention = this.intention_queue[0];

                const [action, , , parcelId] = intention.predicate;
                if (action === 'go_pick_up') {
                    const parcel = this.#parcels.get(parcelId);
                    if (!parcel || parcel.carriedBy) {
                        console.log('Skipping intention because no more valid', intention.predicate);
                        this.intention_queue.shift();
                        await new Promise((res) => setImmediate(res));
                        continue;
                    }
                }

                await intention.achieve().catch(() => {
                    // Errore piano ignorato: il loop continua con la prossima intenzione.
                });

                this.intention_queue.shift();
            }

            await new Promise((res) => setImmediate(res));
        }
    }

    createIntention(predicate) {
        return new Intention(this, predicate, this.#planLibrary);
    }
}

export class IntentionRevisionQueue extends IntentionRevision {
    async push(predicate) {
        if (this.intention_queue.find((i) => i.predicate.join(' ') === predicate.join(' '))) {
            return;
        }

        console.log('IntentionRevisionQueue.push', predicate);
        const intention = this.createIntention(predicate);
        this.intention_queue.push(intention);
    }
}

export class IntentionRevisionReplace extends IntentionRevision {
    async push(predicate) {
        const last = this.intention_queue.at(this.intention_queue.length - 1);
        if (last && last.predicate.join(' ') === predicate.join(' ')) {
            return;
        }

        console.log('IntentionRevisionReplace.push', predicate);
        const intention = this.createIntention(predicate);
        this.intention_queue.push(intention);

        if (last) {
            last.stop();
        }
    }
}

export class IntentionRevisionRevise extends IntentionRevision {
    async push(predicate) {
        console.log('Revising intention queue. Received', ...predicate);
        // TODO
        // - ordinare per utilita' (reward - cost)
        // - eventualmente interrompere quella corrente
        // - valutare validita' intenzione
    }
}
