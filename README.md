# WebSocket Chat — A Checkpoint-Based Learning Project

An open-source, fully Dockerized project for learning WebSockets by building a
real-time chat application in small, runnable steps. Each checkpoint adds one
new concept on top of the last, so you can run and understand the code before
moving forward.

**Stack:** Node.js + `ws` (server), plain HTML/JS (client), Redis (pub/sub),
Nginx (reverse proxy / load balancer) — all orchestrated with Docker Compose.

---

## How to use this repo

Work through the checkpoints in order. For each one:

1. Copy/overwrite the listed files into your project folder.
2. Run `docker compose up --build`.
3. Open the app in your browser and try the suggested experiments.
4. Read through the changed files — each section below explains *what*
   changed and *why*.

```
ws-chat/
├── docker-compose.yml
├── server/
│   ├── Dockerfile
│   ├── package.json
│   └── index.js
├── client/
│   └── index.html
└── nginx/                # added in Checkpoint 5
    └── nginx.conf
```

---

## Checkpoint 1 — Bare WebSocket Echo Server

**Goal:** see the WebSocket handshake and full-duplex messaging in their
simplest possible form.

- `server/index.js` — a ~25 line server using the `ws` library. On
  `connection` it sends a welcome message; on every `message` it echoes the
  text straight back with a timestamp.
- `client/index.html` — plain browser `WebSocket` API (`new WebSocket()`,
  `onopen`, `onmessage`, `onclose`) with a minimal chat-log UI.
- `docker-compose.yml` — two containers: the Node WS server (port 8080) and
  Nginx serving the static client (port 8081).

**Run:** `docker compose up --build` → open `http://localhost:8081`, type a
message, see it echoed back. Open two tabs — notice they're fully isolated
from each other; that gap is closed next.

**Concepts:** WebSocket handshake, full-duplex communication (unlike HTTP
request/response), Dockerizing a Node process, basic `docker-compose`.

---

## Checkpoint 2 — Broadcast Chat

**Goal:** turn "echo" into real multi-user chat.

- `server/index.js` — now keeps a `Set` of all connected sockets. A
  `broadcast()` helper sends a payload to every client, not just the sender.
  Join/leave events are also broadcast as `system` messages.
- `client/index.html` — labels each message with the sender's short id.

**Run:** open 2–3 tabs at `http://localhost:8081` — messages from any tab
now appear in all of them, with join/leave notifications.

**Concepts:** maintaining server-side connection state, broadcasting vs.
one-to-one messaging.

---

## Checkpoint 3 — Usernames & a JSON Message Protocol

**Goal:** replace raw text messages with a structured, typed protocol, and
let users pick real names.

- `server/index.js` — `clients` becomes a `Map` (socket → username). The
  server now parses incoming JSON and switches on a `type` field: `'join'`
  (validates and registers a username) and `'chat'` (broadcasts under that
  username). Messages sent before joining are ignored.
- `client/index.html` — adds a "pick a username" screen shown before the
  chat UI; all messages are now sent as JSON (`{type, ...}`) instead of raw
  strings.

**Run:** join from multiple tabs with different usernames; try joining with
a name that's already taken to see the error path.

**Concepts:** designing a simple application-level protocol on top of raw
WebSocket frames, basic input validation.

---

## Checkpoint 4 — Chat Rooms

**Goal:** scope broadcasts to a "room" instead of the entire server.

- `server/index.js` — `clients` map now stores `{ username, room }`. A new
  `broadcastToRoom(room, payload)` helper filters by room before sending.
  Username uniqueness is checked per-room, so the same name can exist in
  different rooms.
- `client/index.html` — join screen adds a room field (default `general`);
  the chat header shows which room you're in.

**Run:** join some tabs into `general` and others into `random` — messages
and online counts stay scoped to each room.

**Concepts:** partitioning broadcast scope, modeling more complex
server-side state.

---

## Checkpoint 5 — Horizontal Scaling with Redis + Nginx

**Goal:** the "production-shaped" step — go from one server process to
multiple, using Redis pub/sub so clients on different instances still see
each other's messages.

- **3 WebSocket server instances** (`ws-server-1/2/3`), each with its own
  in-memory set of connections — none of them "sees" all clients anymore.
- **Redis** is the shared broadcast layer. Instead of broadcasting directly,
  each instance **publishes** chat/system events to a Redis channel; every
  instance is **subscribed** to that channel and relays the message to its
  own local clients. This is what makes it work regardless of which
  instance a given client landed on.
- **Nginx** is the single public entry point (port 8081): it load-balances
  new WebSocket connections across the 3 backend instances (`/ws`) and
  serves the static client (`/`).
- `server/index.js` — added `SERVER_ID` (so logs/UI show which container
  handled an event), `publishToRoom()` (writes to Redis instead of
  broadcasting locally), and a subscriber callback that relays incoming
  Redis messages to local sockets in that room.
- `nginx/nginx.conf` — new file; proxies `/ws` to an `upstream` of the 3
  server containers with the `Upgrade`/`Connection` headers required for
  WebSocket proxying.
- `client/index.html` — connects to `ws://<host>:8081/ws` (through Nginx)
  and displays a `[server-X]` tag on each event so you can see the load
  balancing happening live.

**Run:** open several tabs, join the same room, and watch different tabs
get tagged with different server instances — yet everyone still sees every
message. Confirm the pub/sub fan-out directly:
```bash
docker compose logs -f ws-server-1 ws-server-2 ws-server-3
```
Send a message from a tab on `server-1` and watch `server-2`/`server-3` log
it too.

**Concepts:** why in-memory broadcast doesn't scale horizontally, pub/sub as
a fan-out mechanism, WebSocket-aware reverse proxying/load balancing.

**Known limitation (left as an exercise):** username uniqueness is currently
checked per-instance only, so two people could join the same room with the
same name if Nginx routes them to different servers. Fixing this means
tracking usernames in Redis rather than in each instance's local memory.

---

## Where to go from here

Natural next steps if you want to keep extending the project:

- **Persistence** — store chat history in Postgres or Redis so messages
  survive server restarts and new joiners can see recent history.
- **Auth** — replace free-text usernames with real authentication (JWT,
  sessions) so identities can't be spoofed.
- **Cross-instance username uniqueness** — move the username registry into
  Redis (see the Checkpoint 5 limitation above).
- **TLS** — terminate `wss://` (secure WebSockets) at Nginx for production
  use.

---

## License

This project is released under the MIT License — free to use, modify, and
share.
