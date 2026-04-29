import { distance, nearestDeliveryDistance, DISTANCE_FACTOR, EXPLORATION_INCENTIVE } from './utils.js';

function nearestDeliveryTileAt({ x, y }, deliveryTileMap) {
    const row = deliveryTileMap?.[Math.round(y)];
    const mappedEntry = row?.[Math.round(x)];

    if (mappedEntry) {
        return mappedEntry;  // { tile: deliveryTile, distance: dist }
    }

    return null;
}

function generateBestPickupOptions({ parcels, me, deliveryTileMap }) {
    if (!Array.isArray(deliveryTileMap) || deliveryTileMap.length === 0) {
        return null;
    }

    let bestOption = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const parcel of parcels.values()) {
        if (parcel.carriedBy) {
            continue;
        }
        const nearest = nearestDeliveryTileAt({ x: parcel.x, y: parcel.y }, deliveryTileMap);
        if (!nearest) {
            continue;
        }

        const deliveryDistance = nearest.distance;
        const totalDistance = distance({ x: parcel.x, y: parcel.y }, { x: me.x, y: me.y }) + deliveryDistance;
        const currentScore = parcel.reward - totalDistance * DISTANCE_FACTOR;
        if (currentScore > 0 && currentScore > bestScore) {
            bestScore = currentScore;
            bestOption = ['go_pick_up', parcel.x, parcel.y, parcel.id];
        }
    }
    return bestOption;
}

function generateDeliveryOptions({ parcels, me, deliveryTileMap }) {
    let bestOption = null;

    if (Array.from(parcels.values()).find((p) => p.carriedBy === me.id)) {
        const nearest = nearestDeliveryTileAt({ x: me.x, y: me.y }, deliveryTileMap);
        if (nearest) {
            const deliveryTile = nearest.tile;
            bestOption = ['go_drop_off', deliveryTile.x, deliveryTile.y];
        }
    }

    return bestOption;
}

export function optionsGeneration(parcels, me, agent, deliveryTileMap) {
    if (!me?.id || me?.x == null || me?.y == null || !Array.isArray(deliveryTileMap) || deliveryTileMap.length === 0) {
        return;
    }

    const bestOption = generateBestPickupOptions({ parcels, me, deliveryTileMap });
    if (bestOption) {
        agent.push(bestOption);
    }
    const deliveryOption = generateDeliveryOptions({ parcels, me, deliveryTileMap });
    if (deliveryOption) {
        agent.push(deliveryOption);
    }
};

function samePredicateInQueue(queue, predicate) {
    return queue.find((i) => i.predicate.join(' ') === predicate.join(' '));
}

const STOPPED_INTENTION = 'stopped intention';
const PREEMPTED_INTENTION = 'preempted intention';
const STOPPED_PLAN = 'stopped';
const STOP_REASON_PREEMPTION = 'preemption';

function createStoppedIntentionError(predicate, stopReason) {
    if (stopReason === STOP_REASON_PREEMPTION) {
        return [PREEMPTED_INTENTION, ...predicate];
    }

    return [STOPPED_INTENTION, ...predicate];
}

function isStoppedPlanError(error) {
    return Array.isArray(error) && error[0] === STOPPED_PLAN;
}

function isPreemptedIntentionError(error) {
    return Array.isArray(error) && error[0] === PREEMPTED_INTENTION;
}

class Intention {
    #currentPlan;
    #stopped = false;
    #parent;
    #predicate;
    #started = false;
    #planLibrary;
    #stopReason = null;

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

    stop(reason = null) {
        this.#stopped = true;
        this.#stopReason = reason;
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
                throw createStoppedIntentionError(this.predicate, this.#stopReason);
            }

            if (planClass.isApplicableTo(...this.predicate)) {
                this.#currentPlan = new planClass(this.#parent, {
                    createSubIntention: (predicate) => new Intention(this, predicate, this.#planLibrary)
                });

                this.log('achieving intention', ...this.predicate, 'with plan', planClass.name);

                try {
                    const planResult = await this.#currentPlan.execute(...this.predicate);
                    this.log('successful intention', ...this.predicate, 'with plan', planClass.name, 'with result:', planResult);
                    return planResult;
                } catch (error) {
                    if (this.stopped || isStoppedPlanError(error)) {
                        const stopError = createStoppedIntentionError(this.predicate, this.#stopReason);
                        this.log(stopError[0], ...this.predicate, 'with plan', planClass.name);
                        throw stopError;
                    }

                    this.log('failed intention', ...this.predicate, 'with plan', planClass.name, 'with error:', error);
                }
            }
        }

        if (this.stopped) {
            throw createStoppedIntentionError(this.predicate, this.#stopReason);
        }

        throw ['no plan satisfied the intention', ...this.predicate];
    }
}

export class IntentionRevision {
    #intentionQueue = [];
    #currentIntention = null;
    #parcels;
    #planLibrary;
    #me;
    #deliveryTileMap;

    constructor({ parcels, planLibrary, me, deliveryTileMap = [] }) {
        this.#parcels = parcels;
        this.#planLibrary = planLibrary;
        this.#me = me;
        this.#deliveryTileMap = deliveryTileMap;
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
        const nearest = nearestDeliveryTileAt({ x, y }, this.#deliveryTileMap);
        const routeEstimatedDistance = distance({ x, y }, this.#me) + (nearest ? nearest.distance : nearestDeliveryDistance({ x, y }, this.#deliveryTileMap));
        let estimatedParcelLoss = 0;
        for (const parcel of MyParcels) {
            estimatedParcelLoss += Math.min(parcel.reward, routeEstimatedDistance * DISTANCE_FACTOR); //euristica
        }
        return (total + newParcel.reward - routeEstimatedDistance * DISTANCE_FACTOR - estimatedParcelLoss);
    }

    else if (action === 'explore') {
        return EXPLORATION_INCENTIVE;
    }

    else {
        return 0;
    }
}

    sortQueueByScore() {
        const runningIntention = this.#currentIntention;

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

        this.log('Queue sorted by score', validIntentions.map((entry) => ({
            predicate: entry.intention.predicate,
            score: entry.score
        })));

        const bestIntention = this.intention_queue[0];
        if (
            runningIntention && //preemption solo se c'è un'intenzione in esecuzione
            bestIntention && //preemption solo se c'è un'intenzione valida in coda
            runningIntention !== bestIntention //preemption solo se l'intenzione migliore in coda è diversa da quella in esecuzione
        ) {
            this.log(
                'Preemption: stopping the current job and loading the higher-score one'
            );
            runningIntention.stop(STOP_REASON_PREEMPTION);
        }
    }

    async loop() {
        while (true) {
            if (this.intention_queue.length > 0) {

                const intention = this.intention_queue[0];
                const [action] = intention.predicate;

                //Checking validity before committing
                if (action === 'go_pick_up') {
                    const parcelId = intention.predicate[3];
                    const parcel = this.#parcels.get(parcelId);
                    if (!parcel || parcel.carriedBy) {
                        console.log('Skipping intention because it is no longer valid', intention.predicate);
                        this.removeIntention(intention);
                        await new Promise((res) => setImmediate(res));
                        continue;
                    }
                }
                if (action === 'go_drop_off') {
                    const allParcels = Array.from(this.#parcels.values());
                    const myParcels = allParcels.find((p) => p.carriedBy === this.#me.id);
                    if (!myParcels) {
                        console.log('Skipping intention because it is no longer valid', intention.predicate);
                        this.removeIntention(intention);
                        await new Promise((res) => setImmediate(res));
                        continue;
                    }
                }


                this.#currentIntention = intention;
                let keepIntentionInQueue = false;

                await intention.achieve().catch((error) => {
                    const wasPreempted = isPreemptedIntentionError(error);

                    // Se l'intenzione e stata preemptata, la rigenero per mantenerla in coda.
                    if (wasPreempted) {
                        const index = this.intention_queue.indexOf(intention);
                        if (index !== -1) {
                            this.intention_queue.splice(index, 1, this.createIntention(intention.predicate));
                            keepIntentionInQueue = true;
                        }
                    }
                }).finally(() => {
                    if (this.#currentIntention === intention) {
                        this.#currentIntention = null;
                    }
                });

                if (!keepIntentionInQueue) {
                    this.removeIntention(intention);
                }
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

    removeIntention(intention) {
        const index = this.intention_queue.indexOf(intention);
        if (index !== -1) {
            this.intention_queue.splice(index, 1);
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
