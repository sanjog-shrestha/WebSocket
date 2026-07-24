# WebSocket Chat

A real-time chat application built with Node.js, WebSockets, Redis, and
Nginx, fully containerized with Docker. Supports usernames, chat rooms, and
horizontal scaling across multiple server instances.

## Features

- Real-time messaging over WebSockets (full-duplex, no polling)
- Usernames and join/leave notifications
- Chat rooms — messages are scoped to the room you're in
- Horizontally scaled: 3 backend server instances behind an Nginx load
  balancer, kept in sync via Redis pub/sub
- Everything runs in Docker — no local Node or Redis install needed

## Architecture

```
Browser ──▶ Nginx (port 8081) ──▶ ws-server-1 ┐
                                  ws-server-2 ├──▶ Redis (pub/sub)
                                  ws-server-3 ┘
```

- **Nginx** serves the static client and load-balances incoming WebSocket
  connections across the three server instances.
- **ws-server-1/2/3** are identical Node.js processes. Each only holds
  connections it's directly handling.
- **Redis** is the shared broadcast layer: when any server receives a chat
  message, it publishes it to a Redis channel. All three servers are
  subscribed, so a message from a client on `ws-server-1` still reaches a
  client connected to `ws-server-2` or `ws-server-3`.

## Project structure

```
ws-chat/
├── docker-compose.yml
├── server/
│   ├── Dockerfile
│   ├── package.json
│   └── index.js
├── client/
│   └── index.html
└── nginx/
    └── nginx.conf
```

## Running it

```bash
docker compose up --build
```

Then open **http://localhost:8081**, enter a username and a room name, and
start chatting. Open multiple tabs (or share the link with someone on your
network) to see messages sync in real time — including across the load
balanced server instances.

To stop everything:

```bash
docker compose down
```

## How it works

**Joining:** the client sends a `{ type: 'join', username, room }` message
over the socket. The server validates the username, registers the
connection, and confirms with `{ type: 'joined', ... }`.

**Chatting:** messages are sent as `{ type: 'chat', message }`. The
receiving server instance doesn't broadcast locally — it publishes the
message to Redis. Every server instance (including itself) is subscribed
to that channel and relays the message to whichever of its own clients are
in the matching room.

**Rooms:** each connection is tagged with a room name on join. Broadcasts
are always filtered by room, so `#general` and `#random` never see each
other's messages.

**Load balancing:** Nginx proxies `/ws` to an `upstream` of the three
server containers using the `Upgrade`/`Connection` headers WebSockets
require, distributing new connections round-robin.

## Known limitations

- Username uniqueness is only checked per-server-instance, not globally —
  two people could join the same room with the same name if Nginx routes
  them to different instances. Fixing this would mean tracking usernames
  in Redis instead of each instance's local memory.
- No message history/persistence — chat history is lost on refresh or
  server restart.
- No authentication — usernames are free-text and not verified.

## Possible extensions

- Persist chat history to Postgres or Redis so it survives restarts and
  new joiners can see recent messages.
- Add real authentication (JWT or sessions) instead of free-text usernames.
- Move username tracking into Redis for cross-instance uniqueness.
- Terminate TLS (`wss://`) at Nginx for production use.

## License

MIT — free to use, modify, and share.
