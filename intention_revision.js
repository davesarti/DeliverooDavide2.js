import { distance, nearestDeliveryDistance, DISTANCE_FACTOR } from './utils.js';

function generateBestPickupOption({ parcels, me, deliveryTiles }) {
    if (!Array.isArray(deliveryTiles) || deliveryTiles.length === 0) {
        return null;
    }

    let bestOption = null;
    let bestScore = Number.MIN_VALUE;

    for (const parcel of parcels.values()) {
        if (parcel.carriedBy) {
            continue;
        }
        const [deliveryDistance] = nearestDeliveryDistance({ x: parcel.x, y: parcel.y }, deliveryTiles);
        const totalDistance = distance({ x: parcel.x, y: parcel.y }, { x: me.x, y: me.y }) + deliveryDistance;
        const currentScore = parcel.reward - totalDistance * DISTANCE_FACTOR;
        console.log('Evaluating parcel', parcel.id, 'with score', currentScore);
        if (currentScore > bestScore && currentScore > 0) {
            bestOption = ['go_pick_up', parcel.x, parcel.y, parcel.id];
            console.log('New best option found:', bestOption, 'with score:', currentScore);
            bestScore = currentScore;
        }
    }

    return bestOption;
}

function generateDeliveryOptions({ parcels, me, deliveryTiles }) {
    let bestOption = null;

    if (Array.from(parcels.values()).find((p) => p.carriedBy === me.id)) {
        const [, deliveryTile] = nearestDeliveryDistance({ x: me.x, y: me.y }, deliveryTiles);
        if (deliveryTile) {
            bestOption = ['go_drop_off', deliveryTile.x, deliveryTile.y];
        }
    }

    return bestOption;
}

export function optionsGeneration(parcels, me, agent, deliveryTiles) {
    if (!me?.id || me?.x == null || me?.y == null || !Array.isArray(deliveryTiles) || deliveryTiles.length === 0) {
        return;
    }

    const bestOption = generateBestPickupOption({ parcels, me, deliveryTiles });
    if (bestOption) {
        agent.push(bestOption);
    }
    const deliveryOption = generateDeliveryOptions({ parcels, me, deliveryTiles });
    if (deliveryOption) {
        agent.push(deliveryOption);
    }
};

function samePredicateInQueue(queue, predicate) {
    return queue.find((i) => i.predicate.join(' ') === predicate.join(' '));
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
    #me;
    #deliveryTiles;

    constructor({ parcels, planLibrary, me, deliveryTiles = [] }) {
        this.#parcels = parcels;
        this.#planLibrary = planLibrary;
        this.#me = me;
        this.#deliveryTiles = deliveryTiles;
    }

    get intention_queue() {
        return this.#intentionQueue;
    }

    log(...args) {
        console.log(...args);
    }

    intentionScore(predicate) {
    let MyParcels = [...this.#parcels.values()].filter((p) => p.carriedBy === this.#me.id);
    let total = MyParcels.reduce((sum, p) => sum + p.reward, 0);
    let estimatedParcelLoss = 0;
    
    const action = predicate[0];
    if (action === 'go_drop_off') {
        const [, x, y] = predicate;
        const routeEstimatedDistance = distance({ x, y }, this.#me);
        for (const parcel of MyParcels) {
            estimatedParcelLoss += Math.min(parcel.reward, routeEstimatedDistance * DISTANCE_FACTOR); //euristica
        }
        return (total - estimatedParcelLoss);
    }
    else if (action === 'go_pick_up') {
        const [, x, y, parcelId] = predicate;
        const newParcel = this.#parcels.get(parcelId);
        if (!newParcel) {
            return Number.NEGATIVE_INFINITY;
        }
        const routeEstimatedDistance = distance({ x, y }, this.#me) + nearestDeliveryDistance({ x, y }, this.#deliveryTiles)[0];
        let estimatedParcelLoss = 0;
        for (const parcel of MyParcels) {
            estimatedParcelLoss += Math.min(parcel.reward, routeEstimatedDistance * DISTANCE_FACTOR); //euristica
        }
        return (total + newParcel.reward - routeEstimatedDistance * DISTANCE_FACTOR - estimatedParcelLoss);
    }

    else {
        return 0;
    }
}

    sortQueueByScore() {
        const scoredIntentions = this.intention_queue.map((intention, index) => ({
            intention,
            index,
            score: this.intentionScore(intention.predicate)
        }));

        const validIntentions = scoredIntentions.filter((entry) => entry.score !== Number.NEGATIVE_INFINITY);

        validIntentions.sort((a, b) => {
            if (b.score !== a.score) {
                return b.score - a.score;
            }
            return a.index - b.index;
        });

        this.intention_queue.splice(
            0,
            this.intention_queue.length,
            ...validIntentions.map((entry) => entry.intention)
        );

        this.log('Queue ordinata per score', validIntentions.map((entry) => ({
            predicate: entry.intention.predicate,
            score: entry.score
        })));
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
        if (samePredicateInQueue(this.intention_queue, predicate)) {
            return;
        }

        console.log('IntentionRevisionRevise.push', predicate);
        const intention = this.createIntention(predicate);
        this.intention_queue.push(intention);

        this.sortQueueByScore();
    }
}
