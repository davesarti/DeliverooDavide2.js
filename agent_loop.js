import 'dotenv/config';
import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk/client';
import { createPlanLibrary } from './plan.js';
import {
    optionsGeneration,
    IntentionRevisionQueue,
    IntentionRevisionReplace,
    IntentionRevisionRevise
} from './intention_revision.js';

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
});

let deliveryTiles = [];
let spawnTiles = [];

socket.onMap((width, height, tiles) => {
    deliveryTiles = tiles.filter((tile) => tile.type == 2);
    spawnTiles = tiles.filter((tile) => tile.type == 1);
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

const planLibrary = createPlanLibrary({ socket, me });

// const myAgent = new IntentionRevisionQueue({ parcels, planLibrary });
const myAgent = new IntentionRevisionReplace({ parcels, planLibrary, me });
// const myAgent = new IntentionRevisionRevise({ parcels, planLibrary });

// Before, optionsGeneration was in the main file and had access to parcels, me and myAgent
// Now that it's in intention_revision.js, I pass those objects to a constructor as arguments so it can generate the options

socket.onSensing((sensing) => {
    optionsGeneration(parcels, me, myAgent, deliveryTiles);
});
socket.onYou((sensing) => {
    optionsGeneration(parcels, me, myAgent, deliveryTiles);
});

myAgent.loop();


