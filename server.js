const http = require("http");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT || 8080);
const ROLE_ORDER = ["chalky", "sphere"];
const SELF_PING_URL = process.env.SELF_PING_URL || process.env.RENDER_EXTERNAL_URL || "https://chalkysbasics.onrender.com";
const SELF_PING_INTERVAL_MS = 10_000;
const RESERVATION_TTL_MS = 120_000;
const rooms = new Map();

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  if (request.method === "GET" && requestUrl.pathname === "/room-status") {
    const roomId = normalizeRoomId(requestUrl.searchParams.get("room"));
    const roomStatus = buildRoomStatus(roomId);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(roomStatus));
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/reserve") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      let message;

      try {
        message = body ? JSON.parse(body) : {};
      } catch (error) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: false, message: "Invalid JSON payload." }));
        return;
      }

      const reservationResponse = reserveSlot(message);
      response.writeHead(reservationResponse.ok ? 200 : 409, { "Content-Type": "application/json" });
      response.end(JSON.stringify(reservationResponse));
    });
    return;
  }

  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(
    JSON.stringify({
      ok: true,
      service: "chalkys-basics-multiplayer",
      rooms: Array.from(rooms.entries()).map(([roomId, room]) => ({
        roomId,
        ...buildRoomStatus(roomId),
        players: room.players.map((player) => ({
          id: player.id,
          role: player.role,
          connected: player.socket.readyState === WebSocket.OPEN,
        })),
      })),
    })
  );
});

function buildRoomStatus(roomId) {
  const room = rooms.get(roomId);
  if (!room) {
    return {
      roomId,
      connectedPlayerCount: 0,
      reservedPlayerCount: 0,
      ready: false,
    };
  }

  cleanupRoom(room);
  const connectedPlayerCount = room.players.filter((player) => player.socket.readyState === WebSocket.OPEN).length;
  const reservedPlayerCount = connectedPlayerCount + room.reservations.length;
  return {
    ok: true,
    roomId,
    connectedPlayerCount,
    reservedPlayerCount,
    ready: reservedPlayerCount >= ROLE_ORDER.length,
  };
}

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

    if (message.type === "catch") {
      handleCatch(client, message);
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
  cleanupRoom(room);

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

  const reservation = takeReservation(room, message.reservationId);
  const role = reservation ? reservation.role : findAvailableRole(room);
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

function handleCatch(client, message) {
  if (!client.roomId || !client.role) {
    send(client.socket, { type: "error", message: "Join a room before sending catch events." });
    return;
  }

  if (client.role !== "chalky") {
    send(client.socket, { type: "error", message: "Only Chalky can catch the kid." });
    return;
  }

  const room = rooms.get(client.roomId);
  if (!room) {
    return;
  }

  const payload = {
    type: "caught",
    room: client.roomId,
    by: client.role,
    caughtRole: "sphere",
  };

  for (const player of room.players) {
    send(player.socket, payload);
  }
}

function broadcastState(room) {
  cleanupRoom(room);
  const payload = {
    type: "state",
    room: room.roomId,
    playerCount: room.players.length,
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
      roomId,
      players: [],
      reservations: [],
    });
  }

  return rooms.get(roomId);
}

function findAvailableRole(room) {
  cleanupRoom(room);
  const occupiedRoles = new Set();

  for (const player of room.players) {
    occupiedRoles.add(player.role);
  }

  for (const reservation of room.reservations) {
    occupiedRoles.add(reservation.role);
  }

  for (const role of ROLE_ORDER) {
    if (!occupiedRoles.has(role)) {
      return role;
    }
  }

  return null;
}

function reserveSlot(message) {
  const roomId = normalizeRoomId(message && message.room);
  const room = getOrCreateRoom(roomId);
  cleanupRoom(room);

  const role = findAvailableRole(room);
  if (!role) {
    return {
      ok: false,
      message: `Room "${roomId}" is full.`,
      room: roomId,
    };
  }

  const reservationId = cryptoRandomId();
  room.reservations.push({
    id: reservationId,
    role,
    expiresAt: Date.now() + RESERVATION_TTL_MS,
  });

  const roomStatus = buildRoomStatus(roomId);
  return {
    ok: true,
    reservationId,
    role,
    room: roomId,
    reservedPlayerCount: roomStatus.reservedPlayerCount,
  };
}

function takeReservation(room, reservationId) {
  if (!room || !reservationId) {
    return null;
  }

  cleanupRoom(room);
  const reservationIndex = room.reservations.findIndex((reservation) => reservation.id === reservationId);
  if (reservationIndex < 0) {
    return null;
  }

  const [reservation] = room.reservations.splice(reservationIndex, 1);
  return reservation || null;
}

function cleanupRoom(room) {
  if (!room || !Array.isArray(room.reservations)) {
    return;
  }

  const now = Date.now();
  room.reservations = room.reservations.filter((reservation) => reservation && reservation.expiresAt > now);
}

function normalizeRoomId(value) {
  const source = typeof value === "string" ? value.trim().toLowerCase() : "";
  let normalized = "";
  let lastCharacterWasSeparator = false;

  for (const character of source) {
    if ((character >= "a" && character <= "z") || (character >= "0" && character <= "9")) {
      normalized += character;
      lastCharacterWasSeparator = false;
      continue;
    }

    const isSeparator = character === "-" || character === "_" || /\s/.test(character);
    if (isSeparator && !lastCharacterWasSeparator) {
      normalized += "-";
      lastCharacterWasSeparator = true;
    }
  }

  normalized = normalized.replace(/^-+|-+$/g, "");
  return normalized || "chalky-test";
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
