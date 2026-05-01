import 'dotenv/config';
import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk/client';
import { createPlanLibrary } from './plan.js';
import {
    optionsGeneration,
    IntentionRevisionQueue,
    IntentionRevisionReplace,
    IntentionRevisionRevise
} from './intention_revision.js';
import { updateSpawnVisitCount } from './utils.js';

const socket = DjsConnect();

/**
 * @type {{id:string|null, name:string|null, x:number|null, y:number|null, score:number|null}}
 */
const me = { id: null, name: null, x: null, y: null, score: null };

/**
 * @type {Map<string, {id: string, carriedBy?: string, x:number, y:number, reward:number}>}
 */
const parcels = new Map();
const crates = new Map();

let deliveryTiles = [];
let spawnTiles = [];
let map = [];
let raggio_sensing;

socket.onConfig((config) => {
    raggio_sensing = config.GAME.player.observation_distance;
});

socket.onYou(({ id, name, x, y, score }) => {
    me.id = id;
    me.name = name;
    me.x = x;
    me.y = y;
    me.score = score;
    updateSpawnVisitCount(me, spawnTiles, raggio_sensing);
    optionsGeneration(parcels, me, myAgent, deliveryTiles);
});

socket.onMap((width, height, tiles) => {
    // resetto map, spawnTiles e deliveryTiles
    map.length = 0;
    spawnTiles.length = 0;
    deliveryTiles.length = 0;

    // creo la matrice map con dimensioni height x width
    for (let y = 0; y <= height; y++) {
        map.push(Array(width + 1).fill(0));
    }

    // riempio la matrice con i type ricevuti
    for (const tile of tiles) {
        map[tile.y][tile.x] = tile.type;
    }

    // filtro i tile di delivery
    deliveryTiles = tiles.filter((tile) => tile.type == 2);

    // filtro i tile di spawn e aggiungo la proprietà visits
    spawnTiles.push(
        ...tiles
            .filter((tile) => tile.type == 1)
            .map(t => ({ ...t, visits: 0 }))
    );
});

socket.onSensing((sensing) => {
    for (const parcel of sensing.parcels) {
        parcels.set(parcel.id, parcel);
    }

    for (const crate of sensing.crates) {
        crates.set(crate.id, crate);
    }

    // Rimuovo i crate che non sono più visibili
    const sensedIdsCrates = new Set(sensing.crates.map((crate) => crate.id));
    for (const knownCrate of crates.values()) {
        if (!sensedIdsCrates.has(knownCrate.id)) {
            crates.delete(knownCrate.id);
        }
    }

    // Rimuovo i parcels che non sono più visibili
    const sensedIdsParcels = new Set(sensing.parcels.map((parcel) => parcel.id));
    for (const knownParcel of parcels.values()) {
        if (!sensedIdsParcels.has(knownParcel.id)) {
            parcels.delete(knownParcel.id);
        }
    }

    optionsGeneration(parcels, me, myAgent, deliveryTiles);
});

const planLibrary = createPlanLibrary({ socket, me, spawnTiles, map, crates });

// const myAgent = new IntentionRevisionReplace({ parcels, planLibrary, me, deliveryTiles });
const myAgent = new IntentionRevisionRevise({ parcels, planLibrary, me, deliveryTiles });

myAgent.loop();


