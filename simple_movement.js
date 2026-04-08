import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";
import dotenv from "dotenv";
dotenv.config();

const socket = DjsConnect();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function moveInCircle(stepDelayMs = 250) {
    const directions = ['up', 'right', 'down', 'left'];
    let direction = directions.shift();
    while (true) {
        const moved = await socket.emitMove(direction);
        if (!moved) {
            // If blocked, wait and retry on next loop.
            console.log(`Blocked on ${direction}, retrying with another direction...`);
            directions.push(direction);
            direction = directions.shift();
            continue;
        }
        const tileType = tileTypeByCoord.get(`${moved.x},${moved.y}`);
        if (tileType === "1") await socket.emitPickup();
        if (tileType === "2") await socket.emitPutdown();

    await sleep(stepDelayMs);
    }
}

let movementStarted = false;

const tileTypeByCoord = new Map();

socket.on('tile', (tile) => {
  tileTypeByCoord.set(`${tile.x},${tile.y}`, tile.type);
});

socket.on('you', ({ id, name, x, y, score }) => {
    console.log('Agent stats:', { id, name, x, y, score });
});

socket.on('connect', async () => {
    if (movementStarted) return;
    try {
        movementStarted = true;
        console.log('Connected. Agent ready. Starting circle movement...');
        await moveInCircle();
    } catch (err) {
        console.error(err.message);
        socket.disconnect();
        process.exit(1);
    }
});