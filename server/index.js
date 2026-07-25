const WebSocket = require('ws');
const { createClient } = require('redis');

const PORT = process.env.PORT || 8080;
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const SERVER_ID = process.env.SERVER_ID || 'unknown';
const CHANNEL = 'chat-messages';

const wss = new WebSocket.Server({ port: PORT });

// Sockets connected to THIS instance only: ws -> { username, room }
const clients = new Map();

// Redis requires two separate connections: one for publishing,
// one dedicated to subscribing (a client in subscribe mode can't
// run other commands).
const publisher = createClient({ url: REDIS_URL });
const subscriber = createClient({ url: REDIS_URL });

// Send a payload to every LOCAL client in a given room.
function relayToLocalRoom(room, payload) {
    const data = JSON.stringify(payload);
    for (const [socket, info] of clients.entries()) {
        if (info.room === room && socket.readyState === WebSocket.OPEN) {
            socket.send(data);
        }
    }
}

// Instead of broadcasting directly, publish to Redis. EVERY instance
// (including this one) will receive it via the subscriber callback below	 
// and relay it to its own local clients.
function publishToRoom(room, payload) {
    publisher.publish(CHANNEL, JSON.stringify({ ...payload, room }));
}

function roomMemberCountLocal(room) {
    let count = 0;
    for (const info of clients.values()) if (info.room === room) count++;
    return count;
}

// Redis key holding the set of usernames currently active in a room,	 
// shared by every server instance. SADD is atomic, so two instances	 
// racing to claim the same name at the same time can't both win.
function usernameSetKey(room) {
    return `room:${room}:usernames`;
}

async function start() {
    await publisher.connect();
    await subscriber.connect();

    await subscriber.subscribe(CHANNEL, (rawMessage) => {
        const payload = JSON.parse(rawMessage);
        relayToLocalRoom(payload.room, payload);
    });

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

                // Atomically claim the username in this room across ALL instances.	 
                // sAdd returns the number of NEW members added: 1 if we won the	 
                // claim, 0 if someone (on any instance) already holds it.
                const claimed = await publisher.sAdd(usernameSetKey(room), username);

                if (claimed === 0) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: `Username "${username}" is already taken in #${room}. Pick another.`
                    }));
                    return;
                }

                clients.set(ws, { username, room });
                console.log(`[${SERVER_ID}] ${username} joined #${room} (local count: ${roomMemberCountLocal(room)})`);

                ws.send(JSON.stringify({ type: 'joined', username, room, server: SERVER_ID }));

                publishToRoom(room, {
                    type: 'system',
                    message: `${username} joined #${room} (handled by ${SERVER_ID})`,
                    timestamp: new Date().toISOString()
                });
                return;
            }

            if (data.type === 'chat') {
                const info = clients.get(ws);
                if (!info) return; // hasn't joined yet

                const text = (data.message || '').toString().slice(0, 500);
                if (!text) return;

                console.log(`[${SERVER_ID}] [#${info.room}] ${info.username}: ${text}`);
                publishToRoom(info.room, {
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
                // Free the username so someone else (on any instance) can take it.
                await publisher.sRem(usernameSetKey(info.room), info.username);
                console.log(`[${SERVER_ID}] ${info.username} left #${info.room}`);
                publishToRoom(info.room, {
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