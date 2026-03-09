// ══════════════════════════════════════════════
// Socket.io handler — El 21 P2P
// ══════════════════════════════════════════════
const jwt = require('jsonwebtoken');
const { query } = require('../config/db');
const el21 = require('./el21');

module.exports = function setupSockets(io) {

  // Auth middleware para sockets
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('No autorizado'));
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.user = decoded;
      next();
    } catch (e) {
      next(new Error('Token inválido'));
    }
  });

  io.on('connection', (socket) => {
    console.log(`Socket conectado: ${socket.user.username}`);

    // ── Pedir lista de mesas ──────────────────────────────────
    socket.on('el21:getTables', () => {
      socket.emit('el21:tables', el21.getTablesInfo());
    });

    // ── Unirse a una mesa ─────────────────────────────────────
    socket.on('el21:join', async ({ level }) => {
      if (![500, 1000, 5000].includes(level)) return socket.emit('el21:error', 'Nivel inválido');

      const userId = socket.user.id;
      const username = socket.user.username;

      // Verificar que no esté ya en una mesa
      for (const [id, t] of el21.getTableById ? [] : []) {
        if (t.players.find(p => p.id === userId)) {
          return socket.emit('el21:error', 'Ya estás en una mesa');
        }
      }

      // Verificar saldo
      try {
        const res = await query('SELECT balance FROM users WHERE id = $1', [userId]);
        if (!res.rows.length) return socket.emit('el21:error', 'Usuario no encontrado');
        const balance = parseFloat(res.rows[0].balance);
        const entry = el21.LEVELS[level].entry;
        if (balance < entry) return socket.emit('el21:error', `Saldo insuficiente. Necesitás $${entry}`);

        // Descontar entrada
        await query('BEGIN');
        await query('UPDATE users SET balance = balance - $1 WHERE id = $2', [entry, userId]);
        await query(`INSERT INTO transactions (user_id, type, amount, description, status)
                     VALUES ($1, 'bet', $2, $3, 'approved')`,
                    [userId, entry, `Entrada El 21 — Mesa $${level}`]);
        await query('COMMIT');

      } catch (e) {
        await query('ROLLBACK').catch(() => {});
        return socket.emit('el21:error', 'Error al procesar pago');
      }

      const table = el21.getOrCreateTable(level);
      socket.join(table.id);

      table.players.push({
        id: userId, username, socketId: socket.id,
        cards: [], value: 0, status: 'waiting', bet: el21.LEVELS[level].entry
      });

      socket.tableId = table.id;

      // Notificar a todos en la mesa
      io.to(table.id).emit('el21:playerJoined', {
        tableId: table.id,
        players: table.players.map(p => ({ id: p.id, username: p.username, status: p.status })),
        level: table.level,
        needed: Math.max(0, el21.MIN_PLAYERS - table.players.length)
      });

      socket.emit('el21:joined', { tableId: table.id, level: table.level, entry: el21.LEVELS[level].entry });

      // Si hay suficientes jugadores, iniciar cuenta regresiva
      if (table.players.length >= el21.MIN_PLAYERS && table.status === 'waiting') {
        // Esperar 10 segundos para que se unan más jugadores
        if (table.startTimer) clearTimeout(table.startTimer);
        table.startTimer = setTimeout(() => {
          if (table.status === 'waiting' && table.players.length >= el21.MIN_PLAYERS) {
            const started = el21.startGame(table);
            io.to(table.id).emit('el21:gameStart', {
              tableId: table.id,
              pot: table.pot,
              commission: table.commission,
              players: table.players.map(p => ({
                id: p.id, username: p.username,
                cards: p.id === table.players[0].id ? p.cards : p.cards, // todos ven sus cartas
                value: p.value
              })),
              currentTurn: 0,
              currentPlayer: table.players[0].username
            });
            // Enviar cartas privadas a cada jugador
            for (const p of table.players) {
              const playerSocket = io.sockets.sockets.get(p.socketId);
              if (playerSocket) playerSocket.emit('el21:yourCards', { cards: p.cards, value: p.value });
            }
            startTurnTimer(io, table);
          }
        }, 10000);

        io.to(table.id).emit('el21:countdown', { seconds: 10, players: table.players.length });
      }
    });

    // ── Pedir carta ───────────────────────────────────────────
    socket.on('el21:hit', () => {
      const table = el21.getTableById(socket.tableId);
      if (!table || table.status !== 'playing') return;

      clearTurnTimer(table);
      const result = el21.hit(table, socket.user.id);
      if (result.error) return socket.emit('el21:error', result.error);

      io.to(table.id).emit('el21:hit', {
        playerId: socket.user.id,
        username: socket.user.username,
        card: result.card,
        value: result.value,
        bust: result.bust
      });

      if (result.nextTurn?.finished) {
        handleGameEnd(io, table, result.nextTurn.result);
      } else if (result.bust || result.stood) {
        if (result.nextTurn) {
          io.to(table.id).emit('el21:turnChange', {
            currentTurn: result.nextTurn.currentTurn,
            currentPlayer: result.nextTurn.currentPlayer
          });
          startTurnTimer(io, table);
        }
      } else {
        startTurnTimer(io, table);
      }
    });

    // ── Plantarse ─────────────────────────────────────────────
    socket.on('el21:stand', () => {
      const table = el21.getTableById(socket.tableId);
      if (!table || table.status !== 'playing') return;

      clearTurnTimer(table);
      const result = el21.stand(table, socket.user.id);
      if (result.error) return socket.emit('el21:error', result.error);

      io.to(table.id).emit('el21:stood', { playerId: socket.user.id, username: socket.user.username });

      if (result.nextTurn?.finished) {
        handleGameEnd(io, table, result.nextTurn.result);
      } else {
        io.to(table.id).emit('el21:turnChange', {
          currentTurn: result.nextTurn.currentTurn,
          currentPlayer: result.nextTurn.currentPlayer
        });
        startTurnTimer(io, table);
      }
    });

    // ── Desconexión ───────────────────────────────────────────
    socket.on('disconnect', () => {
      const table = el21.getTableById(socket.tableId);
      if (!table) return;

      if (table.status === 'waiting') {
        // Devolver entrada y sacar de la mesa
        const idx = table.players.findIndex(p => p.socketId === socket.id);
        if (idx !== -1) {
          const p = table.players[idx];
          query('UPDATE users SET balance = balance + $1 WHERE id = $2', [p.bet, p.id]).catch(() => {});
          table.players.splice(idx, 1);
          if (table.players.length === 0) {
            if (table.startTimer) clearTimeout(table.startTimer);
            el21.removeTable(table.id);
          } else {
            io.to(table.id).emit('el21:playerLeft', { username: p.username, players: table.players.length });
          }
        }
      } else if (table.status === 'playing') {
        // Marcar como plantado automáticamente
        const p = table.players.find(p => p.socketId === socket.id);
        if (p && p.status === 'playing') {
          p.status = 'stood';
          const idx = table.players.indexOf(p);
          if (idx === table.currentTurn) {
            clearTurnTimer(table);
            const result = { nextTurn: advanceAfterDisconnect(table) };
            if (result.nextTurn?.finished) {
              handleGameEnd(io, table, result.nextTurn.result);
            } else if (result.nextTurn) {
              io.to(table.id).emit('el21:turnChange', {
                currentTurn: result.nextTurn.currentTurn,
                currentPlayer: result.nextTurn.currentPlayer
              });
              startTurnTimer(io, table);
            }
          }
        }
      }
    });
  });

  // ── Helpers ───────────────────────────────────────────────────
  function startTurnTimer(io, table) {
    clearTurnTimer(table);
    table.turnTimer = setTimeout(() => {
      // Auto-plantarse si se acaba el tiempo
      const p = table.players[table.currentTurn];
      if (p && p.status === 'playing') {
        p.status = 'stood';
        io.to(table.id).emit('el21:autoStand', { username: p.username });
        const nextTurn = advanceAfterDisconnect(table);
        if (nextTurn?.finished) {
          handleGameEnd(io, table, nextTurn.result);
        } else if (nextTurn) {
          io.to(table.id).emit('el21:turnChange', { currentTurn: nextTurn.currentTurn, currentPlayer: nextTurn.currentPlayer });
          startTurnTimer(io, table);
        }
      }
    }, el21.TURN_TIMEOUT);
    io.to(table.id).emit('el21:timerStart', { seconds: el21.TURN_TIMEOUT / 1000 });
  }

  function clearTurnTimer(table) {
    if (table.turnTimer) { clearTimeout(table.turnTimer); table.turnTimer = null; }
  }

  function advanceAfterDisconnect(table) {
    let next = table.currentTurn + 1;
    while (next < table.players.length && table.players[next].status !== 'playing') next++;
    if (next >= table.players.length) {
      table.status = 'finished';
      const { calcWinner } = require('./el21');
      // Inline calc
      const alive = table.players.filter(p => p.status !== 'bust');
      if (alive.length === 0) return { finished: true, result: { type: 'allBust', prize: 0, winners: [] } };
      const maxVal = Math.max(...alive.map(p => p.value));
      const winners = alive.filter(p => p.value === maxVal);
      const prize = Math.floor(table.pot / winners.length);
      table.winner = winners.map(w => w.id);
      return { finished: true, result: { type: winners.length > 1 ? 'draw' : 'win', prize, winners: winners.map(w => ({ id: w.id, username: w.username, value: w.value })), allPlayers: table.players.map(p => ({ id: p.id, username: p.username, value: p.value, status: p.status, cards: p.cards })) } };
    }
    table.currentTurn = next;
    return { finished: false, currentTurn: next, currentPlayer: table.players[next].username };
  }

  async function handleGameEnd(io, table, result) {
    clearTurnTimer(table);
    table.status = 'finished';

    // Acreditar premios
    try {
      await query('BEGIN');
      if (result.type !== 'allBust' && result.winners.length > 0) {
        for (const w of result.winners) {
          await query('UPDATE users SET balance = balance + $1 WHERE id = $2', [result.prize, w.id]);
          await query(`INSERT INTO transactions (user_id, type, amount, description, status)
                       VALUES ($1, 'prize', $2, $3, 'approved')`,
                      [w.id, result.prize, `Premio El 21 — Mesa $${table.level}`]);
        }
      } else if (result.type === 'allBust') {
        // Devolver todo (sin comisión)
        for (const p of table.players) {
          await query('UPDATE users SET balance = balance + $1 WHERE id = $2', [p.bet, p.id]);
        }
      }
      // Guardar sesión
      await query(`INSERT INTO game_sessions (game, status, pot, commission, prize, metadata, finished_at)
                   VALUES ('el21', 'finished', $1, $2, $3, $4, NOW())`,
                  [table.pot, table.commission, result.prize || 0, JSON.stringify({ level: table.level, players: table.players.length, result: result.type })]);
      await query('COMMIT');
    } catch (e) {
      await query('ROLLBACK').catch(() => {});
      console.error('Error acreditando premios El 21:', e);
    }

    io.to(table.id).emit('el21:gameEnd', {
      result: result.type,
      winners: result.winners,
      prize: result.prize,
      allPlayers: result.allPlayers,
      pot: table.pot
    });

    // Limpiar mesa después de 30 segundos
    setTimeout(() => el21.removeTable(table.id), 30000);
  }
};
