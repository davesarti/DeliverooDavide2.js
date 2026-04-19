import { distance } from './utils.js';

function generateBestPickupOption({ parcels, me }) {
    let bestOption;
    let nearest = Number.MAX_VALUE;

    for (const parcel of parcels.values()) {
        if (parcel.carriedBy) {
            continue;
        }

        const currentDistance = distance({ x: parcel.x, y: parcel.y }, me);
        if (currentDistance < nearest) {
            bestOption = ['go_pick_up', parcel.x, parcel.y, parcel.id];
            nearest = currentDistance;
        }
    }

    return bestOption;
}

function generateDeliveryOptions({ parcels, me, deliveryTiles }) {
    let nearest = Number.MAX_VALUE;
    let bestOption;
    for (const parcel of parcels.values()) {
        if (parcel.carriedBy !== me.id) {
            continue;
        }
        for (const deliveryTile of deliveryTiles) {
            const currentDistance = distance({ x: deliveryTile.x, y: deliveryTile.y }, me);
            if (currentDistance < nearest) {
                bestOption = ['go_drop_off', deliveryTile.x, deliveryTile.y];
                console.log('New best delivery option', bestOption, 'for parcel', parcel.id);
                nearest = currentDistance;
            }
        }
    }
    return bestOption;
}

export function optionsGeneration(parcels, me, agent, deliveryTiles) {
    const bestOption = generateBestPickupOption({ parcels, me });
    if (bestOption) {
        agent.push(bestOption);
    }
    const deliveryOption = generateDeliveryOptions({ parcels, me, deliveryTiles });
    if (deliveryOption) {
        agent.push(deliveryOption);
    }
};


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
    #me;

    constructor({ parcels, planLibrary, me }) {
        this.#parcels = parcels;
        this.#planLibrary = planLibrary;
        this.#me = me;
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
                const [action] = intention.predicate;   

                if (action === 'go_pick_up') {
                    const parcelId = intention.predicate[3];
                    const parcel = this.#parcels.get(parcelId);
                    if (!parcel || parcel.carriedBy) {
                        console.log('Skipping intention because no more valid', intention.predicate);
                        this.intention_queue.shift();
                        await new Promise((res) => setImmediate(res));
                        continue;
                    }
                }
                if (action === 'go_drop_off') {
                    const allParcels = Array.from(this.#parcels.values());
                    const myParcels = allParcels.find((p) => p.carriedBy === this.#me.id);
                    if (!myParcels) {
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
            else if (this.intention_queue.length === 0) {
                this.log('Intention queue is empty, start exploring');
                this.push(['explore']);
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
