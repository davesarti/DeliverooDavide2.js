export function distance({ x: x1, y: y1 }, { x: x2, y: y2 }) {
    const dx = Math.abs(Math.round(x1) - Math.round(x2));
    const dy = Math.abs(Math.round(y1) - Math.round(y2));
    return dx + dy;
}

export function updateSpawnVisitCount(me, spawnTiles) {
    for(let d_tile of spawnTiles){
        if(d_tile.x === me.x && d_tile.y === me.y) {
            d_tile.visite++;
        }
    }
}