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

socket.onYou(({ id, name, x, y, score }) => {
    me.id = id;
    me.name = name;
    me.x = x;
    me.y = y;
    me.score = score;
    updateSpawnVisitCount(me, spawnTiles);
});

let deliveryTiles = [];
let spawnTiles = [];
let map = [];

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

    console.log('map ready');
});

socket.onSensing(async (sensing) => {
    for (const parcel of sensing.parcels) {
        parcels.set(parcel.id, parcel);
    }

    const sensedIds = new Set(sensing.parcels.map((parcel) => parcel.id));
    for (const knownParcel of parcels.values()) {
        if (!sensedIds.has(knownParcel.id)) {
            parcels.delete(knownParcel.id);
        }
    }
});

const planLibrary = createPlanLibrary({ socket, me, spawnTiles, map });

// const myAgent = new IntentionRevisionReplace({ parcels, planLibrary, me, deliveryTiles });
const myAgent = new IntentionRevisionRevise({ parcels, planLibrary, me, deliveryTiles });

// Before, optionsGeneration was in the main file and had access to parcels, me and myAgent
// Now that it's in intention_revision.js, I pass those objects to a constructor as arguments so it can generate the options

socket.onSensing((sensing) => {
    optionsGeneration(parcels, me, myAgent, deliveryTiles);
});
socket.onYou((sensing) => {
    optionsGeneration(parcels, me, myAgent, deliveryTiles);
});

myAgent.loop();


