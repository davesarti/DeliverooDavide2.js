export const DISTANCE_FACTOR = 0.0; // Fattore di penalizzazione per la distanza, da calibrare
const MAX_HEAT = 100; // Valore massimo di "calore" per una cella di spawn

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

export function updateSpawnVisitCount(me, spawnTiles, raggio_sensing) {
    for (const tile of spawnTiles) {
        const manhattanDist = Math.abs(tile.x - me.x) + Math.abs(tile.y - me.y);
        if (manhattanDist <= raggio_sensing) {
            // Tile dentro il rombo di sensing → raffredda
            tile.visits = 0;
        } else {
            // Tile fuori dal sensing → scalda
            if (tile.visits < MAX_HEAT) {
                tile.visits++;
            }
        }
    }
}

export function findCellToExplore(spawnTiles, me) {
    // Escludi la cella corrente
    const candidates = spawnTiles.filter(t => !(t.x === me.x && t.y === me.y));

    if (candidates.length === 0) return null;

    const maxVisits = Math.max(...candidates.map(t => t.visits));
    const maxDist = Math.max(...candidates.map(t => distance({ x: t.x, y: t.y }, me))) || 1;

    // Score: calore normalizzato + vicinanza normalizzata
    candidates.sort((a, b) => {
        const scoreA = (a.visits / maxVisits) + (1 - distance({ x: a.x, y: a.y }, me) / maxDist);
        const scoreB = (b.visits / maxVisits) + (1 - distance({ x: b.x, y: b.y }, me) / maxDist);
        return scoreB - scoreA; // ordine decrescente: score alto = preferibile
    });

    return candidates[0];
}