const http = require("http");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT || 8080);
const ROLE_ORDER = ["chalky", "sphere"];
const SELF_PING_URL = process.env.SELF_PING_URL || process.env.RENDER_EXTERNAL_URL || "https://chalkysbasics.onrender.com";
const SELF_PING_INTERVAL_MS = 10_000;
const rooms = new Map();

const server = http.createServer((request, response) => {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(
    JSON.stringify({
      ok: true,
      service: "chalkys-basics-multiplayer",
      rooms: Array.from(rooms.entries()).map(([roomId, room]) => ({
        roomId,
        players: room.players.map((player) => ({
          id: player.id,
          role: player.role,
          connected: player.socket.readyState === WebSocket.OPEN,
        })),
      })),
    })
  );
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (socket) => {
  const client = {
    id: cryptoRandomId(),
    roomId: null,
    role: null,
    state: {
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
    },
    socket,
  };

  socket.on("message", (rawMessage) => {
    let message;

    try {
      message = JSON.parse(rawMessage.toString());
    } catch (error) {
      send(socket, { type: "error", message: "Invalid JSON payload." });
      return;
    }

    if (!message || typeof message.type !== "string") {
      send(socket, { type: "error", message: "Missing message type." });
      return;
    }

    if (message.type === "join") {
      handleJoin(client, message);
      return;
    }

    if (message.type === "state") {
      handleState(client, message);
      return;
    }

    send(socket, { type: "error", message: `Unsupported message type: ${message.type}` });
  });

  socket.on("close", () => {
    removeClient(client);
  });

  socket.on("error", () => {
    removeClient(client);
  });
});

function handleJoin(client, message) {
  const roomId = normalizeRoomId(message.room);
  const room = getOrCreateRoom(roomId);

  if (client.roomId && client.roomId !== roomId) {
    removeClient(client);
  }

  if (room.players.some((player) => player.id === client.id)) {
    send(client.socket, {
      type: "welcome",
      id: client.id,
      role: client.role,
      room: client.roomId,
    });
    broadcastState(room);
    return;
  }

  const role = findAvailableRole(room);
  if (!role) {
    send(client.socket, {
      type: "error",
      message: `Room "${roomId}" already has both players.`,
    });
    client.socket.close(1008, "Room full");
    return;
  }

  client.roomId = roomId;
  client.role = role;
  room.players.push(client);

  send(client.socket, {
    type: "welcome",
    id: client.id,
    role: client.role,
    room: client.roomId,
  });

  broadcastState(room);
}

function handleState(client, message) {
  if (!client.roomId || !client.role) {
    send(client.socket, { type: "error", message: "Join a room before sending state." });
    return;
  }

  client.state = {
    x: numberOrZero(message.x),
    y: numberOrZero(message.y),
    z: numberOrZero(message.z),
    yaw: numberOrZero(message.yaw),
  };

  const room = rooms.get(client.roomId);
  if (!room) {
    return;
  }

  broadcastState(room);
}

function broadcastState(room) {
  const payload = {
    type: "state",
    players: room.players.map((player) => ({
      id: player.id,
      role: player.role,
      x: player.state.x,
      y: player.state.y,
      z: player.state.z,
      yaw: player.state.yaw,
    })),
  };

  for (const player of room.players) {
    send(player.socket, payload);
  }
}

function removeClient(client) {
  if (!client.roomId) {
    return;
  }

  const room = rooms.get(client.roomId);
  if (!room) {
    client.roomId = null;
    client.role = null;
    return;
  }

  room.players = room.players.filter((player) => player.id !== client.id);
  if (room.players.length === 0) {
    rooms.delete(client.roomId);
  } else {
    broadcastState(room);
  }

  client.roomId = null;
  client.role = null;
}

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      players: [],
    });
  }

  return rooms.get(roomId);
}

function findAvailableRole(room) {
  for (const role of ROLE_ORDER) {
    if (!room.players.some((player) => player.role === role)) {
      return role;
    }
  }

  return null;
}

function normalizeRoomId(value) {
  const roomId = typeof value === "string" ? value.trim() : "";
  return roomId || "chalky-test";
}

function numberOrZero(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function send(socket, payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify(payload));
}

function cryptoRandomId() {
  return Math.random().toString(36).slice(2, 10);
}

function startSelfPingLoop() {
  if (!SELF_PING_URL || SELF_PING_URL.includes("localhost") || SELF_PING_URL.includes("127.0.0.1")) {
    return;
  }

  setInterval(async () => {
    try {
      const response = await fetch(SELF_PING_URL, { method: "GET" });
      console.log(`Self-ping ${SELF_PING_URL} -> ${response.status}`);
    } catch (error) {
      console.error(`Self-ping failed for ${SELF_PING_URL}: ${error.message}`);
    }
  }, SELF_PING_INTERVAL_MS);
}

server.listen(PORT, () => {
  console.log(`Chalky's Basics multiplayer server listening on port ${PORT}`);
  console.log(`Self-ping target: ${SELF_PING_URL}`);
  startSelfPingLoop();
});
