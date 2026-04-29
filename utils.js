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

export function updateSpawnVisitCount(me, spawnTiles) {
    for (const tile of spawnTiles) {
        if (tile.x === me.x && tile.y === me.y) {
            tile.visits++;
        }
    }
}

function getSortedSpawnTiles(spawnTiles, me) {
    const sorted = [];

    for (const tile of spawnTiles) {
        sorted.push({
            dist: distance(tile, me),
            x: tile.x,
            y: tile.y,
            visits: tile.visits
        });
    }

    sorted.sort((a, b) => a.dist - b.dist);
    return sorted;
}

export function findCellToExplore(spawnTiles, me) {
    const candidates = getSortedSpawnTiles(spawnTiles, me)
        .filter(t => !(t.x === me.x && t.y === me.y));

    const maxDist = Math.max(...spawnTiles.map(t => distance(t, me)));
    const maxVisits = Math.max(...spawnTiles.map(t => t.visits));
    const weight = maxVisits > 0 ? maxDist / maxVisits : 1;

    candidates.sort((a, b) =>
        (a.dist + a.visits * weight) - (b.dist + b.visits * weight)
    );

    return candidates[0];
}