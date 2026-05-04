import 'dotenv/config';
import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk/client';
import { createPlanLibrary } from './plan.js';
import {
    optionsGeneration,
    IntentionRevisionRevise
} from './intention_revision.js';
import { updateSpawnVisitCount, updateTilesPerSecond, buildDeliveryTileMap, buildSpawnTileMap } from './utils.js';

const socket = DjsConnect();

const me = { id: null, name: null, x: null, y: null, score: null };
const parcels = new Map();
const crates = new Map();
const agents = new Map();

let deliveryTiles = [];
let spawnTiles = [];
let map = [];
let deliveryTileMap = [];
let spawnTileMap = [];
let raggio_sensing;

socket.onConfig((config) => {
    raggio_sensing = config.GAME.player.observation_distance;
});

socket.onMap((width, height, tiles) => {
    map.length = 0;
    spawnTiles.length = 0;
    deliveryTiles.length = 0;

    for (let y = 0; y <= height; y++) {
        map.push(Array(width + 1).fill(0));
    }

    for (const tile of tiles) {
        map[tile.y][tile.x] = tile.type;
    }

    deliveryTiles = tiles.filter((tile) => tile.type == 2);

    spawnTiles.push(
        ...tiles
            .filter((tile) => tile.type == 1)
            .map(t => ({ ...t, visits: 0 }))
    );

    deliveryTileMap = buildDeliveryTileMap(width, height, tiles, deliveryTiles);
    spawnTileMap = buildSpawnTileMap(width, height, tiles, spawnTiles);

    if (myAgent) {
        myAgent.setDeliveryTileMap(deliveryTileMap);
        myAgent.setSpawnTileMap(spawnTileMap);
    }

    console.log('map ready');
});

socket.onSensing((sensing) => {
    for (const parcel of sensing.parcels) {
        parcels.set(parcel.id, parcel);
    }

    for (const crate of sensing.crates) {
        crates.set(crate.id, crate);
    }

    if (Array.isArray(sensing.agents)) {
        for (const agent of sensing.agents) {
            if (agent.id === me.id) continue;
            agents.set(agent.id, agent);
        }
        const sensedIdsAgents = new Set(sensing.agents.map((a) => a.id));
        for (const knownAgent of agents.values()) {
            if (!sensedIdsAgents.has(knownAgent.id)) {
                agents.delete(knownAgent.id);
            }
        }
    }

    const sensedIdsCrates = new Set(sensing.crates.map((crate) => crate.id));
    for (const knownCrate of crates.values()) {
        if (!sensedIdsCrates.has(knownCrate.id)) crates.delete(knownCrate.id);
    }

    const sensedIdsParcels = new Set(sensing.parcels.map((parcel) => parcel.id));
    for (const knownParcel of parcels.values()) {
        if (!sensedIdsParcels.has(knownParcel.id)) parcels.delete(knownParcel.id);
    }

    optionsGeneration(parcels, me, myAgent, deliveryTileMap, spawnTileMap);
});

socket.onYou(({ id, name, x, y, score }) => {
    me.id = id;
    me.name = name;
    me.x = x;
    me.y = y;
    me.score = score;
    updateSpawnVisitCount(me, spawnTiles, raggio_sensing);
    updateTilesPerSecond(x, y);
    optionsGeneration(parcels, me, myAgent, deliveryTileMap, spawnTileMap);
});

const planLibrary = createPlanLibrary({ socket, me, spawnTiles, map, crates, parcels });
const myAgent = new IntentionRevisionRevise({ parcels, planLibrary, me, deliveryTileMap, spawnTileMap });

myAgent.loop();