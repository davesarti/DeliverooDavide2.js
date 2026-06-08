import { canEnterTile, DIRECTIONS } from "../utils/mapUtils.js";

export function buildDeliveryDistanceMap(width, height, tiles, deliveryTiles) {
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

            for (const { dx, dy, move } of DIRECTIONS) {
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

export function buildSpawnDistanceMap(width, height, tiles, spawnTiles) {
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

            for (const { dx, dy, move } of DIRECTIONS) {
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

export function buildGrid(width, height, tiles) {
  const grid = Array.from({ length: height + 1 }, () =>
    Array(width + 1).fill(0)
  );

  for (const tile of tiles) {
    grid[tile.y][tile.x] = tile.type;
  }

  return grid;
}


