export const EXPLORATION_INCENTIVE = 0.01; // Incentivo per l'esplorazione, da calibrare
let tiles_per_sec = 10.0;
export const PARCEL_DECAY = 1;
export const DROP_DISINCENTIVE = 0; // Penalità per il rilascio di un pacco, da calibrare

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
        const f = gaussianWeight(manhattanDist, sigma);

        if (manhattanDist <= raggio_sensing) {
            // Raffredda proporzionalmente alla vicinanza
            tile.visits = tile.visits * (1 - f);
        } else {
            // Riscalda proporzionalmente alla lontananza
            tile.visits = Math.max(1, tile.visits) * (1 + (1 - f));
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
    const W_HEAT = 0.9; // W_DIST = 1 - W_HEAT = 0.3

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

    // nearestDelivery stores, for each cell, the closest delivery tile and its distance.
    // The BFS starts from every delivery tile at once so the first visit is always the shortest path.
    const nearestDelivery = Array.from({ length: height + 1 }, () => Array(width + 1).fill(null));
    const visited = Array.from({ length: height + 1 }, () => Array(width + 1).fill(false));
    const queue = [];

    // Seed the queue with all delivery tiles as independent BFS sources.
    for (const deliveryTile of deliveryTiles) {
        visited[deliveryTile.y][deliveryTile.x] = true;
        nearestDelivery[deliveryTile.y][deliveryTile.x] = { tile: deliveryTile, distance: 0 };
        queue.push({ x: deliveryTile.x, y: deliveryTile.y, source: deliveryTile, distance: 0 });
    }

    let head = 0;
    while (head < queue.length) {
        const current = queue[head++];

        // Expand to the four adjacent cells, but only through tiles that can legally be entered.
        for (const { dx, dy, move } of directions) {
            const nextX = current.x + dx;
            const nextY = current.y + dy;

            const insideMap =
                nextX >= 0 && nextX < tileMap[0].length &&
                nextY >= 0 && nextY < tileMap.length;

            // Skip out-of-bounds cells, already visited cells, and blocked transitions.
            if (!insideMap) continue;
            if (visited[nextY][nextX]) continue;
            if (!canEnterTile(tileMap[nextY][nextX], move)) continue;

            visited[nextY][nextX] = true;
            // Record the delivery source that first reaches this cell, which is the nearest one.
            nearestDelivery[nextY][nextX] = { tile: current.source, distance: current.distance + 1 };
            queue.push({ x: nextX, y: nextY, source: current.source, distance: current.distance + 1 });
        }
    }

    return nearestDelivery;
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
