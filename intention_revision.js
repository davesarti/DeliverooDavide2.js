import { distance, EXPLORATION_INCENTIVE, PARCEL_DECAY, DROP_DISINCENTIVE, FAILED_INTENTION_RETRY_MS, getTilesPerSecond } from './utils.js';

function distance_factor() {
    const tilesPerSec = getTilesPerSecond();
    if (!tilesPerSec || tilesPerSec <= 0) {
        return 0;
    }
    return PARCEL_DECAY / tilesPerSec;
}

function pickupRouteDistance({ parcel, me, deliveryTileMap, spawnTileMap }) {
    const nearest = nearestDeliveryTileAt({ x: parcel.x, y: parcel.y }, deliveryTileMap);
    if (!nearest) {
        return null;
    }

    const pickupDistance = spawnMapDistance(spawnTileMap, { x: me.x, y: me.y }, { x: parcel.x, y: parcel.y })
        ?? distance({ x: parcel.x, y: parcel.y }, { x: me.x, y: me.y });

    return pickupDistance + nearest.distance;
}

function nearestDeliveryTileAt({ x, y }, deliveryTileMap) {
    const row = deliveryTileMap?.[Math.round(y)];
    const mappedEntries = row?.[Math.round(x)];

    if (!Array.isArray(mappedEntries) || mappedEntries.length === 0) {
        return null;
    }

    let best = null;
    for (const entry of mappedEntries) {
        if (!Number.isFinite(entry.distance)) {
            continue;
        }
        if (!best || entry.distance < best.distance) {
            best = entry;
        }
    }

    if (!best) {
        return null;
    }

    return { tile: { x: best.deliveryX, y: best.deliveryY }, distance: best.distance };
}

function spawnMapDistance(spawnTileMap, from, target) {
    const fromRow = spawnTileMap?.[Math.round(from.y)];
    const fromEntries = fromRow?.[Math.round(from.x)];

    if (!Array.isArray(fromEntries)) {
        return null;
    }

    const entry = fromEntries.find(
        (candidate) => candidate.spawnX === Math.round(target.x) && candidate.spawnY === Math.round(target.y)
    );

    if (!entry || !Number.isFinite(entry.distance)) {
        return null;
    }

    return entry.distance;
}

function deliveryMapDistance(deliveryTileMap, from, target) {
    const fromRow = deliveryTileMap?.[Math.round(from.y)];
    const fromEntries = fromRow?.[Math.round(from.x)];

    if (!Array.isArray(fromEntries)) {
        return null;
    }

    const entry = fromEntries.find(
        (candidate) => candidate.deliveryX === Math.round(target.x) && candidate.deliveryY === Math.round(target.y)
    );

    if (!entry || !Number.isFinite(entry.distance)) {
        return null;
    }

    return entry.distance;
}

function generatePickupOptions({ parcels, me, deliveryTileMap, spawnTileMap }) {
    if (!Array.isArray(deliveryTileMap) || deliveryTileMap.length === 0) {
        return null;
    }

    const pickupOptions = [];
    for (const parcel of parcels.values()) {
        if (parcel.carriedBy) {
            continue;
        }
        const routeDistance = pickupRouteDistance({ parcel, me, deliveryTileMap, spawnTileMap });
        if (routeDistance == null) {
            continue;
        }

        const currentScore = parcel.reward - routeDistance * distance_factor();
        if (currentScore > 0) {
            pickupOptions.push(
                ['go_pick_up', parcel.x, parcel.y, parcel.id]
            );
        }
    }

    return pickupOptions;
}

function generateDeliveryOptions({ parcels, me, deliveryTileMap }) {
    if (!Array.isArray(deliveryTileMap) || deliveryTileMap.length === 0) {
        return [];
    }

    if (!Array.from(parcels.values()).find((p) => p.carriedBy === me.id)) {
        return [];
    }

    const row = deliveryTileMap?.[Math.round(me.y)];
    const mappedEntries = row?.[Math.round(me.x)];

    if (!Array.isArray(mappedEntries) || mappedEntries.length === 0) {
        return [];
    }

    const options = [];
    const seen = new Set();

    for (const entry of mappedEntries) {
        if (!Number.isFinite(entry.distance)) {
            continue;
        }
        const key = `${entry.deliveryX},${entry.deliveryY}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        options.push(['go_drop_off', entry.deliveryX, entry.deliveryY]);
    }

    return options;
}

export function optionsGeneration(parcels, me, agent, deliveryTileMap, spawnTileMap) {
    if (!me?.id || me?.x == null || me?.y == null || !Array.isArray(deliveryTileMap) || deliveryTileMap.length === 0) {
        return;
    }

    const isFailedIntention = (predicate) =>
        typeof agent?.isPredicateInFailedPool === 'function' && agent.isPredicateInFailedPool(predicate);

    const pickupOptions = generatePickupOptions({ parcels, me, deliveryTileMap, spawnTileMap }) ?? [];
    for (const option of pickupOptions) {
        if (!isFailedIntention(option)) {
            agent.push(option);
        }
    }
    const deliveryOptions = generateDeliveryOptions({ parcels, me, deliveryTileMap });
    for (const option of deliveryOptions) {
        if (!isFailedIntention(option)) {
            agent.push(option);
        }
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

function isStoppedIntentionError(error) {
    return Array.isArray(error) && error[0] === STOPPED_INTENTION;
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
    #spawnTileMap;
    #failedIntentionPool = new Map();
    #failedIntentionRetryMs = FAILED_INTENTION_RETRY_MS;

    constructor({ parcels, planLibrary, me, deliveryTileMap = [], spawnTileMap = [] }) {
        this.#parcels = parcels;
        this.#planLibrary = planLibrary;
        this.#me = me;
        this.#deliveryTileMap = deliveryTileMap;
        this.#spawnTileMap = spawnTileMap;
    }

    setDeliveryTileMap(deliveryTileMap) {
        this.#deliveryTileMap = Array.isArray(deliveryTileMap) ? deliveryTileMap : []; //Carino generalizzarlo per tutti i campi
    }

    setSpawnTileMap(spawnTileMap) {
       this.#spawnTileMap = Array.isArray(spawnTileMap) ? spawnTileMap : [];
    }

    get intention_queue() {
        return this.#intentionQueue;
    }

    log(...args) {
        console.log(...args);
    }

    #predicateKey(predicate) {
        return predicate.join(' ');
    }

    isPredicateInFailedPool(predicate) {
        return this.#failedIntentionPool.has(this.#predicateKey(predicate));
    }

    #recordFailedIntention(predicate) {
        const key = this.#predicateKey(predicate);
        this.#failedIntentionPool.set(key, { predicate: [...predicate], addedAtMs: Date.now() });
    }

    #requeueFailedIntentions() {
        const now = Date.now();
        let requeued = false;

        for (const [key, entry] of this.#failedIntentionPool.entries()) {
            if (now - entry.addedAtMs < this.#failedIntentionRetryMs) {
                continue;
            }

            this.#failedIntentionPool.delete(key);

            if (this.#currentIntention && this.#predicateKey(this.#currentIntention.predicate) === key) {
                continue;
            }

            if (samePredicateInQueue(this.intention_queue, entry.predicate)) {
                continue;
            }

            this.intention_queue.push(this.createIntention(entry.predicate));
            requeued = true;
        }

        if (requeued) {
            this.sortQueueByScore();
        }
    }

    intentionScore(predicate) {
        let MyParcels = [...this.#parcels.values()].filter((p) => p.carriedBy === this.#me.id);
        let total = MyParcels.reduce((sum, p) => sum + p.reward, 0);
        let estimatedParcelLoss = 0;
        
        const action = predicate[0];
        if (action === 'go_drop_off') {
            const [, x, y] = predicate;
            const routeEstimatedDistance = deliveryMapDistance(
                this.#deliveryTileMap,
                { x: this.#me.x, y: this.#me.y },
                { x, y }
            );

            if (routeEstimatedDistance == null) {
                return -1;
            }
            for (const parcel of MyParcels) {
                estimatedParcelLoss += Math.min(parcel.reward, routeEstimatedDistance * distance_factor());
            }
            return (total - estimatedParcelLoss - DROP_DISINCENTIVE);
        }
        else if (action === 'go_pick_up') {

            const [, x, y, parcelId] = predicate;
            const newParcel = this.#parcels.get(parcelId);
            if (!newParcel) {
                return -1;
            }
            const routeEstimatedDistance = pickupRouteDistance({
                parcel: newParcel,
                me: this.#me,
                deliveryTileMap: this.#deliveryTileMap,
                spawnTileMap: this.#spawnTileMap
            });
            if (routeEstimatedDistance == null) {
                return -1;
            }
            if (MyParcels.length === 0) {
                return newParcel.reward - routeEstimatedDistance * distance_factor();
            } else {
                for (const parcel of MyParcels) {
                    estimatedParcelLoss += Math.min(parcel.reward, routeEstimatedDistance * distance_factor());
                }
            }
            return (total + newParcel.reward - routeEstimatedDistance * distance_factor() - estimatedParcelLoss);
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

        const validIntentions = scoredIntentions.filter((entry) => entry.score > 0);

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
            this.#requeueFailedIntentions();

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
                    const wasStopped = isStoppedIntentionError(error);

                    // Se l'intenzione e stata preemptata, la rigenero per mantenerla in coda.
                    if (wasPreempted) {
                        const index = this.intention_queue.indexOf(intention);
                        if (index !== -1) {
                            this.intention_queue.splice(index, 1, this.createIntention(intention.predicate));
                            keepIntentionInQueue = true;
                        }
                        return;
                    }

                    if (!wasStopped) {
                        this.#recordFailedIntention(intention.predicate);
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
        if (this.isPredicateInFailedPool(predicate)) {
            return;
        }
        if (samePredicateInQueue(this.intention_queue, predicate)) {
            return;
        }

        const intention = this.createIntention(predicate);
        this.intention_queue.push(intention);

        this.sortQueueByScore();
    }
}
