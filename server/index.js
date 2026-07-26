const WebSocket = require('ws');
const { createClient } = require('redis');

const PORT = process.env.PORT || 8080;
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const SERVER_ID = process.env.SERVER_ID || 'unknown';
const STREAM_KEY = 'chat-stream';
const STREAM_MAXLEN = 5000;
const HISTORY_LIMIT = 50;

const wss = new WebSocket.Server({ port: PORT });

const clients = new Map();

const redisClient = createClient({ url: REDIS_URL });
const streamReader = createClient({ url: REDIS_URL });

let lastStreamId = '0';

function relayToLocalRoom(room, payload) {
    const data = JSON.stringify(payload);
    for (const [socket, info] of clients.entries()) {
        if (info.room === room && socket.readyState === WebSocket.OPEN) {
            socket.send(data);
        }
    }
}

async function appendToStream(room, payload) {
    await redisClient.xAdd(
        STREAM_KEY,
        '*',
        { data: JSON.stringify({ ...payload, room }) },
        { TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: STREAM_MAXLEN } }
    );
}

function usernameSetKey(room) {
    return `room:${room}:usernames`;
}

async function runStreamReader() {
    const latest = await redisClient.xRevRange(STREAM_KEY, '+', '-', { COUNT: 1 });
    lastStreamId = latest.length > 0 ? latest[0].id : '0';
    console.log(`[${SERVER_ID}] Stream reader starting after ID ${lastStreamId}`);

    for (; ;) {
        try {
            const result = await streamReader.xRead(
                { key: STREAM_KEY, id: lastStreamId },
                { BLOCK: 0, COUNT: 100 }
            );
            if (!result) continue;

            for (const stream of result) {
                for (const entry of stream.messages) {
                    lastStreamId = entry.id;
                    const payload = JSON.parse(entry.message.data);
                    relayToLocalRoom(payload.room, payload);
                }
            }
        } catch (err) {
            console.error(`[${SERVER_ID}] Stream reader error:`, err.message);
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
    }
}

function roomMemberCountLocal(room) {
    let count = 0;
    for (const info of clients.values()) if (info.room === room) count++;
    return count;
}

async function fetchHistoryUpTo(room, upToId) {
    if (upToId === '0') return [];
    const entries = await redisClient.xRange(STREAM_KEY, '-', upToId);
    return entries
        .map((e) => JSON.parse(e.message.data))
        .filter((p) => p.room === room && p.type === 'chat')
        .slice(-HISTORY_LIMIT);
}

async function start() {
    await redisClient.connect();
    await streamReader.connect();

    runStreamReader();

    console.log(`[${SERVER_ID}] Connected to Redis. WebSocket server on port ${PORT}`);

    wss.on('connection', (ws) => {
        console.log(`[${SERVER_ID}] New socket opened, awaiting join message...`);

        ws.on('message', async (raw) => {
            let data;
            try {
                data = JSON.parse(raw.toString());
            } catch {
                return;
            }

            if (data.type === 'join') {
                const username = (data.username || '').trim().slice(0, 20);
                const room = (data.room || 'general').trim().toLowerCase().slice(0, 20) || 'general';

                if (!username) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Username cannot be empty.' }));
                    return;
                }

                const claimed = await redisClient.sAdd(usernameSetKey(room), username);
                if (claimed === 0) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: `Username "${username}" is already taken in #${room}. Pick another.`
                    }));
                    return;
                }

                clients.set(ws, { username, room });
                const snapshotId = lastStreamId;

                console.log(`[${SERVER_ID}] ${username} joined #${room} (local count: ${roomMemberCountLocal(room)})`);
                ws.send(JSON.stringify({ type: 'joined', username, room, server: SERVER_ID }));

                const history = await fetchHistoryUpTo(room, snapshotId);
                if (history.length > 0) {
                    ws.send(JSON.stringify({ type: 'history', messages: history }));
                }

                await appendToStream(room, {
                    type: 'system',
                    message: `${username} joined #${room} (handled by ${SERVER_ID})`,
                    timestamp: new Date().toISOString()
                });
                return;
            }

            if (data.type === 'chat') {
                const info = clients.get(ws);
                if (!info) return;

                const text = (data.message || '').toString().slice(0, 500);
                if (!text) return;

                console.log(`[${SERVER_ID}] [#${info.room}] ${info.username}: ${text}`);
                await appendToStream(info.room, {
                    type: 'chat',
                    from: info.username,
                    message: text,
                    server: SERVER_ID,
                    timestamp: new Date().toISOString()
                });
            }
        });

        ws.on('close', async () => {
            const info = clients.get(ws);
            if (info) {
                clients.delete(ws);
                await redisClient.sRem(usernameSetKey(info.room), info.username);
                console.log(`[${SERVER_ID}] ${info.username} left #${info.room}`);
                await appendToStream(info.room, {
                    type: 'system',
                    message: `${info.username} left #${info.room} (was on ${SERVER_ID})`,
                    timestamp: new Date().toISOString()
                });
            }
        });

        ws.on('error', (err) => {
            console.error(`[${SERVER_ID}] Error:`, err.message);
        });
    });
}

start().catch((err) => {
    console.error(`[${SERVER_ID}] Failed to start:`, err);
    process.exit(1);
});