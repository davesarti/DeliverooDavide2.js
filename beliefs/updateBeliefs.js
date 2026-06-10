import { updateSpawnStaleness, updateTilesPerSecond } from "../utils/mapUtils.js";
import {
  buildGrid,
  buildDeliveryDistanceMap,
  buildSpawnDistanceMap,
} from "./mapState.js";

/*
 * Collega gli eventi del socket allo stato interno dell'agente.
 */
export function setupBeliefUpdates(socket, bs) {

  // ==========================================
  // Configuration
  // ==========================================

  socket.onConfig((config) => {
    /*
     * Salva i parametri di gioco che servono alle altre parti dell'agente.
     */
    const gameConfig = config.GAME ?? config;

    bs.config.observationDistance =
      gameConfig.player?.observation_distance ?? null;
    bs.config.movementDuration =
      gameConfig.player?.movement_duration ?? null;
    bs.config.playerCapacity =
      gameConfig.player?.capacity ?? null;
    bs.config.parcelDecayingEvent =
      gameConfig.parcels?.decaying_event ?? null;
    bs.config.parcelGenerationEvent =
      gameConfig.parcels?.generation_event ?? null;
    bs.config.maxParcels =
      gameConfig.parcels?.max ?? null;
  });

  // ==========================================
  // Agent State
  // ==========================================

  let lastYou = null;

  socket.onYou(({ id, name, x, y, score }) => {
    /*
     * Aggiorna la posizione e il punteggio del nostro agente.
     */
    const current = `${id}|${x}|${y}|${score}`;
    if (current === lastYou) return;
    lastYou = current;

    bs.me.id = id;
    bs.me.name = name;
    bs.me.x = x;
    bs.me.y = y;
    bs.me.score = score;

    updateSpawnStaleness(
      bs.me,
      bs.map.spawnTiles,
      bs.config.observationDistance
    );

    updateTilesPerSecond(x, y);
  });

  // ==========================================
  // Map State
  // ==========================================

  socket.onMap((width, height, tiles) => {
    /*
     * Ricostruisce la mappa interna quando arriva la descrizione completa del livello.
     */
    bs.map.width = width;
    bs.map.height = height;
    bs.map.tiles = tiles;
    bs.map.grid = buildGrid(width, height, tiles);

    bs.map.deliveryTiles = tiles.filter((tile) => tile.type == 2);
    bs.map.spawnTiles = tiles
      .filter((tile) => tile.type == 1)
      .map((tile) => ({ ...tile, staleness: 0 }));

    bs.map.deliveryDistanceMap = buildDeliveryDistanceMap(
      width, height, tiles, bs.map.deliveryTiles
    );
    bs.map.spawnDistanceMap = buildSpawnDistanceMap(
      width, height, tiles, bs.map.spawnTiles
    );

    console.log(
      `[${bs.me.name ?? "agent"}] Map: ` +
      `${bs.map.spawnTiles.length} spawn, ` +
      `${bs.map.deliveryTiles.length} delivery`
    );
  });

  // ==========================================
  // Sensing
  // ==========================================

  socket.onSensing((sensing) => {
    /*
     * Allinea oggetti visibili e agenti osservati con l'ultimo sensing ricevuto.
     */
    for (const parcel of sensing.parcels ?? []) {
      bs.parcels.set(parcel.id, parcel);
    }

    for (const crate of sensing.crates ?? []) {
      bs.crates.set(crate.id, crate);
    }

    if (Array.isArray(sensing.agents)) {
      for (const agent of sensing.agents) {
        if (agent.id === bs.me.id) continue;
        bs.agents.set(agent.id, agent);
      }

      const sensedIds = new Set(sensing.agents.map((a) => a.id));
      for (const known of bs.agents.values()) {
        if (!sensedIds.has(known.id)) bs.agents.delete(known.id);
      }
    }

    const sensedCrates = new Set((sensing.crates ?? []).map((c) => c.id));
    for (const known of bs.crates.values()) {
      if (!sensedCrates.has(known.id)) bs.crates.delete(known.id);
    }

    const sensedParcels = new Set((sensing.parcels ?? []).map((p) => p.id));
    for (const known of bs.parcels.values()) {
      if (!sensedParcels.has(known.id)) bs.parcels.delete(known.id);
    }

    bs.onUpdate?.();
  });
}