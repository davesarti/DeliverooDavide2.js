export const EXPLORATION_INCENTIVE = 0.01; // Incentivo per l'esplorazione, da calibrare
let tiles_per_sec = 10.0;
export const PARCEL_DECAY = 1;
export const DROP_DISINCENTIVE = 0; // Penalità per il rilascio di un pacco, da calibrare
export const AGENT_AVOID_RADIUS = 5;
export const AGENT_AVOID_WEIGHT = 100;
export const BASE_STEP_COST = 1;
export const MIN_EDGE_COST = 0.1;
export const PARCEL_REWARD_DISCOUNT = 0.2;
export const MAX_CONSECUTIVE_WAITS = 50;
export const HEAT_UPDATE_MS = 100;
export const ASTAR_WAIT_MS = 15;
export const FAILED_INTENTION_RETRY_MS = 3000;

const MOVING_WINDOW_MS = 10000;

const movementStats = {
    lastX: null,
    lastY: null,
    lastTimeMs: null,
    samples: [],
    lastReportMs: 0
};

export function updateTilesPerSecond (x, y) {
    const nowMs = Date.now();

    if (movementStats.lastTimeMs === null) {
        movementStats.lastX = x;
        movementStats.lastY = y;
        movementStats.lastTimeMs = nowMs;
        return;
    }

    const dx = Math.abs(x - movementStats.lastX);
    const dy = Math.abs(y - movementStats.lastY);
    const movedTiles = dx + dy;
    movementStats.samples.push({ timeMs: nowMs, tiles: movedTiles });

    const cutoffMs = nowMs - MOVING_WINDOW_MS;
    while (movementStats.samples.length > 0 && movementStats.samples[0].timeMs < cutoffMs) {
        movementStats.samples.shift();
    }

    if (nowMs - movementStats.lastReportMs >= 1000 && movementStats.samples.length > 0) {
        const windowTiles = movementStats.samples.reduce((sum, s) => sum + s.tiles, 0);
        const windowDurationMs = Math.max(nowMs - movementStats.samples[0].timeMs, 1);
        const tilesPerSecond = windowTiles / (windowDurationMs / 1000);
        tiles_per_sec = Number(tilesPerSecond.toFixed(2));
        movementStats.lastReportMs = nowMs;
    }

    movementStats.lastX = x;
    movementStats.lastY = y;
    movementStats.lastTimeMs = nowMs;
};

export function getTilesPerSecond() {
    return tiles_per_sec;
}

const directions = [
    { dx: 1, dy: 0, move: 'right' },
    { dx: -1, dy: 0, move: 'left' },
    { dx: 0, dy: 1, move: 'up' },
    { dx: 0, dy: -1, move: 'down' }
];
export const DISTANCE_FACTOR = 0.0; // Fattore di penalizzazione per la distanza, da calibrare

export function distance({ x: x1, y: y1 }, { x: x2, y: y2 }) {
    const dx = Math.abs(Math.round(x1) - Math.round(x2));
    const dy = Math.abs(Math.round(y1) - Math.round(y2));
    return dx + dy;
}

export function nearestDeliveryDistance({ x, y }, deliveryTiles) {
    let bestDistance = Number.MAX_VALUE;
    let tile = null;
    for (const deliveryTile of deliveryTiles) {
        const currentDistance = distance({ x: deliveryTile.x, y: deliveryTile.y }, { x, y });
        if (currentDistance < bestDistance) {
            bestDistance = currentDistance;
            tile = deliveryTile;
        }
    }
    return [bestDistance, tile];
}

function gaussianWeight(d, sigma) {
    return Math.exp(-(d * d) / (2 * sigma * sigma));
}

export function updateSpawnVisitCount(me, spawnTiles, raggio_sensing) {
    if (raggio_sensing === undefined) return;

    const sigma = raggio_sensing / 2;

    for (const tile of spawnTiles) {
        const manhattanDist = Math.abs(tile.x - me.x) + Math.abs(tile.y - me.y);
        if (manhattanDist === 0) {
            // Se siamo sulla tile, raffredda drasticamente
            tile.visits = 0;
            continue;
        }
        const f = gaussianWeight(manhattanDist, sigma);
        const current = tile.visits ?? 0;
        if (manhattanDist <= raggio_sensing) {
            // Raffredda proporzionalmente alla vicinanza
            tile.visits = Math.max(0, current - f);
        } else {
            // Riscalda proporzionalmente alla lontananza
            tile.visits = current + (1 - f);
        }
    }
}

export function findCellToExplore(spawnTiles, me) {
    // Escludi la cella corrente
    const candidates = spawnTiles.filter(t => !(t.x === me.x && t.y === me.y));

    if (candidates.length === 0) return null;

    const maxVisits = Math.max(...candidates.map(t => t.visits));
    const maxDist = Math.max(...candidates.map(t => distance({ x: t.x, y: t.y }, me))) || 1;

    // Score: calore normalizzato e pesato + vicinanza normalizzata e pesata
    const W_HEAT = 0.7; // W_DIST = 1 - W_HEAT = 0.3

    candidates.sort((a, b) => {
        const scoreA = W_HEAT * (a.visits / maxVisits) + (1 - W_HEAT) * (1 - distance({ x: a.x, y: a.y }, me) / maxDist);
        const scoreB = W_HEAT * (b.visits / maxVisits) + (1 - W_HEAT) * (1 - distance({ x: b.x, y: b.y }, me) / maxDist);
        return scoreB - scoreA;
    });

    return candidates[0];
}

export function canEnterTile(tileValue, move) {
    if (Number(tileValue) === 0) {
        return false;
    }

    if (tileValue == '↓' && move === 'up') return false;
    if (tileValue == '↑' && move === 'down') return false;
    if (tileValue == '→' && move === 'left') return false;
    if (tileValue == '←' && move === 'right') return false;

    return true;
}

export function buildDeliveryTileMap(width, height, tiles, deliveryTiles) {
    const tileMap = Array.from({ length: height + 1 }, () => Array(width + 1).fill(0));

    // Build a fast lookup grid with the raw tile type for every map position.
    for (const tile of tiles) {
        tileMap[tile.y][tile.x] = tile.type;
    }

    const deliveryTileMap = Array.from({ length: height + 1 }, (_, row) =>
        Array.from({ length: width + 1 }, (_, col) =>
            deliveryTiles.map((tile) => ({
                deliveryX: tile.x,
                deliveryY: tile.y,
                cellX: col,
                cellY: row,
                distance: Number.POSITIVE_INFINITY
            }))
        )
    );

    for (let i = 0; i < deliveryTiles.length; i++) {
        const deliveryTile = deliveryTiles[i];
        const visited = Array.from({ length: height + 1 }, () => Array(width + 1).fill(false));
        const queue = [];

        visited[deliveryTile.y][deliveryTile.x] = true;
        deliveryTileMap[deliveryTile.y][deliveryTile.x][i].distance = 0;
        queue.push({ x: deliveryTile.x, y: deliveryTile.y, distance: 0 });

        let head = 0;
        while (head < queue.length) {
            const current = queue[head++];

            for (const { dx, dy, move } of directions) {
                const nextX = current.x + dx;
                const nextY = current.y + dy;

                const insideMap =
                    nextX >= 0 && nextX < tileMap[0].length &&
                    nextY >= 0 && nextY < tileMap.length;

                if (!insideMap) continue;
                if (visited[nextY][nextX]) continue;
                if (!canEnterTile(tileMap[nextY][nextX], move)) continue;

                visited[nextY][nextX] = true;
                deliveryTileMap[nextY][nextX][i].distance = current.distance + 1;
                queue.push({ x: nextX, y: nextY, distance: current.distance + 1 });
            }
        }
    }

    return deliveryTileMap;
}

export function buildSpawnTileMap(width, height, tiles, spawnTiles) {
    const tileMap = Array.from({ length: height + 1 }, () => Array(width + 1).fill(0));

    for (const tile of tiles) {
        tileMap[tile.y][tile.x] = tile.type;
    }

    const spawnTileMap = Array.from({ length: height + 1 }, (_, row) =>
        Array.from({ length: width + 1 }, (_, col) =>
            spawnTiles.map((tile) => ({
                spawnX: tile.x,
                spawnY: tile.y,
                cellX: col,
                cellY: row,
                distance: Number.POSITIVE_INFINITY
            }))
        )
    );

    for (let i = 0; i < spawnTiles.length; i++) {
        const spawnTile = spawnTiles[i];
        const visited = Array.from({ length: height + 1 }, () => Array(width + 1).fill(false));
        const queue = [];

        visited[spawnTile.y][spawnTile.x] = true;
        spawnTileMap[spawnTile.y][spawnTile.x][i].distance = 0;
        queue.push({ x: spawnTile.x, y: spawnTile.y, distance: 0 });

        let head = 0;
        while (head < queue.length) {
            const current = queue[head++];

            for (const { dx, dy, move } of directions) {
                const nextX = current.x + dx;
                const nextY = current.y + dy;

                const insideMap =
                    nextX >= 0 && nextX < tileMap[0].length &&
                    nextY >= 0 && nextY < tileMap.length;

                if (!insideMap) continue;
                if (visited[nextY][nextX]) continue;
                if (!canEnterTile(tileMap[nextY][nextX], move)) continue;

                visited[nextY][nextX] = true;
                spawnTileMap[nextY][nextX][i].distance = current.distance + 1;
                queue.push({ x: nextX, y: nextY, distance: current.distance + 1 });
            }
        }
    }

    return spawnTileMap;
}
