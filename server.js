// Secret Code server: serves the static frontend and runs the single shared room over Socket.IO.
// All state lives in memory.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { Room } from './src/room.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createServer({ room = new Room(), tickMs = 2000 } = {}) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, players: room.players.size, phase: room.phase });
  });

  app.use(
    express.static(path.join(__dirname, 'public'), {
      setHeaders(res, filePath) {
        // Always pick up a fresh deploy; files are tiny.
        if (/\.(html|js|css)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );

  const server = http.createServer(app);
  const io = new Server(server, {
    maxHttpBufferSize: 10_000,
    pingInterval: 10_000,
    pingTimeout: 8_000,
  });

  // ---- broadcasting -------------------------------------------------------

  const helloSockets = () => [...io.of('/').sockets.values()].filter((s) => s.data.hello);
  const watcherCount = () => helloSockets().filter((s) => !s.data.playerId).length;

  function sendState(socket) {
    socket.emit('state', room.viewFor(socket.data.playerId, { watchers: watcherCount() }));
  }

  let pending = false;
  function broadcast() {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      for (const s of helloSockets()) sendState(s);
    });
  }
  room.onChange = broadcast;

  // ---- helpers ------------------------------------------------------------

  function attach(socket, player) {
    // Only one live connection per player: an older tab/socket is told it was replaced.
    if (player.socketId && player.socketId !== socket.id) {
      const old = io.of('/').sockets.get(player.socketId);
      if (old) {
        old.data.playerId = null;
        old.emit('replaced');
      }
    }
    player.socketId = socket.id;
    socket.data.playerId = player.id;
    room.setConnected(player.id, true);
    broadcast();
  }

  const youOf = (p) => ({ id: p.id, name: p.name });
  const asObject = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});

  io.on('connection', (socket) => {
    socket.data.playerId = null;
    socket.data.hello = false;

    // Register a handler with payload/ack validation and error isolation.
    const on = (event, handler) => {
      socket.on(event, (payload, ack) => {
        if (typeof payload === 'function') [payload, ack] = [undefined, payload];
        const reply = typeof ack === 'function' ? ack : () => {};
        try {
          reply(handler(asObject(payload)) ?? { ok: true });
        } catch (err) {
          console.error(`Error handling "${event}":`, err);
          reply({ ok: false, code: 'server-error', error: 'Something went wrong. Please try again.' });
        }
      });
    };

    const me = () => (socket.data.playerId ? room.players.get(socket.data.playerId) : null);
    const needPlayer = () => ({ ok: false, code: 'not-player', error: 'Join the game first.' });

    // First message from every client. Restores an existing player if the token is valid.
    on('hello', ({ token, takeover }) => {
      socket.data.hello = true;
      const player = room.playerByToken(token);
      const previous = me();
      if (previous && previous !== player) {
        // This socket switches identity: release the one it had.
        socket.data.playerId = null;
        if (previous.socketId === socket.id) {
          previous.socketId = null;
          room.setConnected(previous.id, false);
        }
      }
      if (player) {
        const liveOther =
          player.socketId && player.socketId !== socket.id && io.of('/').sockets.get(player.socketId)?.connected;
        if (liveOther && takeover !== true) {
          // Same browser, new tab, while the original tab is still open: treat as a new visitor.
          sendState(socket);
          broadcast();
          return { ok: true, you: null, code: 'in-use', name: player.name };
        }
        attach(socket, player);
        sendState(socket);
        return { ok: true, you: youOf(player) };
      }
      sendState(socket);
      broadcast();
      return { ok: true, you: null };
    });

    on('join', ({ name }) => {
      if (!socket.data.hello) return { ok: false, code: 'no-hello', error: 'Still connecting…' };
      if (me()) return { ok: false, code: 'already-joined', error: 'You have already joined.' };
      const res = room.addPlayer(name);
      if (!res.ok) return res;
      attach(socket, res.player);
      return { ok: true, token: res.player.token, you: youOf(res.player) };
    });

    on('rename', ({ name }) => {
      const p = me();
      return p ? room.rename(p.id, name) : needPlayer();
    });

    on('leave', () => {
      const p = me();
      if (!p) return needPlayer();
      const res = room.removePlayer(p.id);
      if (res.ok) {
        socket.data.playerId = null;
        broadcast();
      }
      return res;
    });

    on('start', () => {
      const p = me();
      return p ? room.startRound(p.id) : needPlayer();
    });

    on('submit', ({ cards }) => {
      const p = me();
      return p ? room.submit(p.id, cards) : needPlayer();
    });

    on('endRound', () => {
      const p = me();
      return p ? room.endRound(p.id) : needPlayer();
    });

    on('resetGame', () => {
      const p = me();
      return p ? room.resetGame(p.id) : needPlayer();
    });

    socket.on('disconnect', () => {
      const p = me();
      if (p && p.socketId === socket.id) {
        p.socketId = null;
        room.setConnected(p.id, false);
      }
      broadcast();
    });
  });

  const timer = setInterval(() => room.tick(), tickMs);
  timer.unref();

  return {
    app,
    server,
    io,
    room,
    close() {
      clearInterval(timer);
      return new Promise((resolve) => io.close(() => resolve()));
    },
  };
}

// Run directly: `node server.js`
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.PORT) || 3000;
  const { server, close } = createServer();
  server.listen(port, '0.0.0.0', () => {
    console.log(`Secret Code listening on http://localhost:${port}`);
  });
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, async () => {
      await close();
      process.exit(0);
    });
  }
}
