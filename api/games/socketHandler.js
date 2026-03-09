const jwt = require('jsonwebtoken');
const { query } = require('../config/db');
const el21 = require('./el21');
const poker = require('./poker');

module.exports = function setupSockets(io) {

  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('No autorizado'));
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.user = decoded;
      next();
    } catch (e) { next(new Error('Token inválido')); }
  });

  io.on('connection', (socket) => {
    console.log(`Socket: ${socket.user.username}`);

    // ════════════════════════════════════════
    // EL 21
    // ════════════════════════════════════════
    socket.on('el21:getTables', () => socket.emit('el21:tables', el21.getTablesInfo()));

    socket.on('el21:join', async ({ level }) => {
      if (![500,1000,5000].includes(level)) return socket.emit('el21:error','Nivel inválido');
      const { id: userId, username } = socket.user;
      try {
        const res = await query('SELECT balance FROM users WHERE id = $1', [userId]);
        if (!res.rows.length) return socket.emit('el21:error','Usuario no encontrado');
        const balance = parseFloat(res.rows[0].balance);
        const entry = el21.LEVELS[level].entry;
        if (balance < entry) return socket.emit('el21:error',`Saldo insuficiente. Necesitás $${entry}`);
        await query('BEGIN');
        await query('UPDATE users SET balance = balance - $1 WHERE id = $2', [entry, userId]);
        await query(`INSERT INTO transactions (user_id,type,amount,description,status) VALUES ($1,'bet',$2,$3,'approved')`, [userId, entry, `Entrada El 21 $${level}`]);
        await query('COMMIT');
      } catch(e) { await query('ROLLBACK').catch(()=>{}); return socket.emit('el21:error','Error al procesar pago'); }

      const table = el21.getOrCreateTable(level);
      socket.join(table.id);
      table.players.push({ id:userId, username, socketId:socket.id, cards:[], value:0, status:'waiting', bet:el21.LEVELS[level].entry });
      socket.tableId = table.id; socket.gameType = 'el21';

      io.to(table.id).emit('el21:playerJoined', { tableId:table.id, players:table.players.map(p=>({id:p.id,username:p.username})), level:table.level, needed:Math.max(0,el21.MIN_PLAYERS-table.players.length) });
      socket.emit('el21:joined', { tableId:table.id, level:table.level, entry:el21.LEVELS[level].entry });

      if (table.players.length >= el21.MIN_PLAYERS && table.status === 'waiting') {
        if (table.startTimer) clearTimeout(table.startTimer);
        io.to(table.id).emit('el21:countdown', { seconds:10, players:table.players.length });
        table.startTimer = setTimeout(() => {
          if (table.status === 'waiting' && table.players.length >= el21.MIN_PLAYERS) {
            el21.startGame(table);
            io.to(table.id).emit('el21:gameStart', { tableId:table.id, pot:table.pot, commission:table.commission, players:table.players.map(p=>({id:p.id,username:p.username,value:p.value})), currentTurn:0, currentPlayer:table.players[0].username });
            for (const p of table.players) {
              const ps = io.sockets.sockets.get(p.socketId);
              if (ps) ps.emit('el21:yourCards', { cards:p.cards, value:p.value });
            }
            startTurnTimer21(io, table);
          }
        }, 10000);
      }
    });

    socket.on('el21:hit', () => {
      if (socket.gameType !== 'el21') return;
      const table = el21.getTableById(socket.tableId);
      if (!table || table.status !== 'playing') return;
      clearTurnTimer(table);
      const result = el21.hit(table, socket.user.id);
      if (result.error) return socket.emit('el21:error', result.error);
      io.to(table.id).emit('el21:hit', { playerId:socket.user.id, username:socket.user.username, card:result.card, value:result.value, bust:result.bust });
      if (result.nextTurn?.finished) { handleEl21End(io, table, result.nextTurn.result); }
      else if ((result.bust || result.stood) && result.nextTurn) {
        io.to(table.id).emit('el21:turnChange', { currentTurn:result.nextTurn.currentTurn, currentPlayer:result.nextTurn.currentPlayer });
        startTurnTimer21(io, table);
      } else { startTurnTimer21(io, table); }
    });

    socket.on('el21:stand', () => {
      if (socket.gameType !== 'el21') return;
      const table = el21.getTableById(socket.tableId);
      if (!table || table.status !== 'playing') return;
      clearTurnTimer(table);
      const result = el21.stand(table, socket.user.id);
      if (result.error) return socket.emit('el21:error', result.error);
      io.to(table.id).emit('el21:stood', { playerId:socket.user.id, username:socket.user.username });
      if (result.nextTurn?.finished) { handleEl21End(io, table, result.nextTurn.result); }
      else { io.to(table.id).emit('el21:turnChange', { currentTurn:result.nextTurn.currentTurn, currentPlayer:result.nextTurn.currentPlayer }); startTurnTimer21(io, table); }
    });

    // ════════════════════════════════════════
    // POKER
    // ════════════════════════════════════════
    socket.on('poker:getTables', () => socket.emit('poker:tables', poker.getTablesInfo()));

    socket.on('poker:join', async ({ level }) => {
      if (![500,1000,5000].includes(level)) return socket.emit('poker:error','Nivel inválido');
      const { id: userId, username } = socket.user;
      try {
        const res = await query('SELECT balance FROM users WHERE id = $1', [userId]);
        if (!res.rows.length) return socket.emit('poker:error','Usuario no encontrado');
        const balance = parseFloat(res.rows[0].balance);
        const entry = poker.LEVELS[level].entry;
        if (balance < entry) return socket.emit('poker:error',`Saldo insuficiente. Necesitás $${entry}`);
        await query('BEGIN');
        await query('UPDATE users SET balance = balance - $1 WHERE id = $2', [entry, userId]);
        await query(`INSERT INTO transactions (user_id,type,amount,description,status) VALUES ($1,'bet',$2,$3,'approved')`, [userId, entry, `Entrada Poker $${level}`]);
        await query('COMMIT');
      } catch(e) { await query('ROLLBACK').catch(()=>{}); return socket.emit('poker:error','Error al procesar pago'); }

      const table = poker.getOrCreateTable(level);
      socket.join(table.id);
      table.players.push({ id:userId, username, socketId:socket.id, holeCards:[], status:'waiting', folded:false, bet:poker.LEVELS[level].entry });
      socket.tableId = table.id; socket.gameType = 'poker';

      io.to(table.id).emit('poker:playerJoined', { tableId:table.id, players:table.players.map(p=>({id:p.id,username:p.username})), level:table.level, needed:Math.max(0,poker.MIN_PLAYERS-table.players.length) });
      socket.emit('poker:joined', { tableId:table.id, level:table.level, entry:poker.LEVELS[level].entry });

      if (table.players.length >= poker.MIN_PLAYERS && table.status === 'waiting') {
        if (table.startTimer) clearTimeout(table.startTimer);
        io.to(table.id).emit('poker:countdown', { seconds:10, players:table.players.length });
        table.startTimer = setTimeout(() => {
          if (table.status === 'waiting' && table.players.length >= poker.MIN_PLAYERS) {
            poker.startGame(table);
            io.to(table.id).emit('poker:gameStart', {
              tableId:table.id, pot:table.pot, street:'preflop',
              players:table.players.map(p=>({id:p.id,username:p.username,folded:false})),
              community:[], currentTurn:table.currentTurn,
              currentPlayer:table.players[table.currentTurn].username
            });
            for (const p of table.players) {
              const ps = io.sockets.sockets.get(p.socketId);
              if (ps) ps.emit('poker:yourCards', { holeCards:p.holeCards });
            }
            startActionTimer(io, table);
          }
        }, 10000);
      }
    });

    socket.on('poker:fold', () => {
      if (socket.gameType !== 'poker') return;
      const table = poker.getTableById(socket.tableId);
      if (!table || table.status !== 'playing') return;
      clearTurnTimer(table);
      const result = poker.fold(table, socket.user.id);
      if (result.error) return socket.emit('poker:error', result.error);
      io.to(table.id).emit('poker:fold', { playerId:socket.user.id, username:socket.user.username });
      handlePokerNext(io, table, result.next);
    });

    socket.on('poker:check', () => {
      if (socket.gameType !== 'poker') return;
      const table = poker.getTableById(socket.tableId);
      if (!table || table.status !== 'playing') return;
      clearTurnTimer(table);
      const result = poker.check(table, socket.user.id);
      if (result.error) return socket.emit('poker:error', result.error);
      io.to(table.id).emit('poker:check', { playerId:socket.user.id, username:socket.user.username });
      handlePokerNext(io, table, result.next);
    });

    // ── Desconexión ───────────────────────────────────────────
    socket.on('disconnect', () => {
      const table = socket.gameType === 'poker'
        ? poker.getTableById(socket.tableId)
        : el21.getTableById(socket.tableId);
      if (!table) return;

      if (table.status === 'waiting') {
        const idx = table.players.findIndex(p => p.socketId === socket.id);
        if (idx !== -1) {
          const p = table.players[idx];
          const entry = (socket.gameType === 'poker' ? poker : el21).LEVELS[table.level].entry;
          query('UPDATE users SET balance = balance + $1 WHERE id = $2', [entry, p.id]).catch(()=>{});
          table.players.splice(idx, 1);
          if (table.players.length === 0) {
            if (table.startTimer) clearTimeout(table.startTimer);
            (socket.gameType === 'poker' ? poker : el21).removeTable(table.id);
          } else {
            io.to(table.id).emit(`${socket.gameType}:playerLeft`, { username:p.username });
          }
        }
      } else if (table.status === 'playing' && socket.gameType === 'poker') {
        const p = table.players.find(p => p.socketId === socket.id);
        if (p && !p.folded && table.players[table.currentTurn]?.id === p.id) {
          clearTurnTimer(table);
          const result = poker.fold(table, p.id);
          io.to(table.id).emit('poker:fold', { playerId:p.id, username:p.username });
          if (result.next) handlePokerNext(io, table, result.next);
        }
      }
    });
  });

  // ── Helpers El 21 ─────────────────────────────────────────────
  function startTurnTimer21(io, table) {
    clearTurnTimer(table);
    const secs = el21.TURN_TIMEOUT / 1000;
    io.to(table.id).emit('el21:timerStart', { seconds: secs });
    table.turnTimer = setTimeout(() => {
      const p = table.players[table.currentTurn];
      if (p && p.status === 'playing') {
        p.status = 'stood';
        io.to(table.id).emit('el21:autoStand', { username:p.username });
        let next = table.currentTurn + 1;
        while (next < table.players.length && table.players[next].status !== 'playing') next++;
        if (next >= table.players.length) { table.status='finished'; handleEl21End(io, table, calcEl21Winner(table)); }
        else { table.currentTurn=next; io.to(table.id).emit('el21:turnChange',{currentTurn:next,currentPlayer:table.players[next].username}); startTurnTimer21(io,table); }
      }
    }, el21.TURN_TIMEOUT);
  }

  function calcEl21Winner(table) {
    const alive = table.players.filter(p => p.status !== 'bust');
    if (!alive.length) return { type:'allBust', prize:0, winners:[] };
    const maxVal = Math.max(...alive.map(p=>p.value));
    const winners = alive.filter(p=>p.value===maxVal);
    const prize = Math.floor(table.pot / winners.length);
    table.winner = winners.map(w=>w.id);
    return { type:winners.length>1?'draw':'win', prize, winners:winners.map(w=>({id:w.id,username:w.username,value:w.value})), allPlayers:table.players.map(p=>({id:p.id,username:p.username,value:p.value,status:p.status,cards:p.cards})) };
  }

  async function handleEl21End(io, table, result) {
    clearTurnTimer(table);
    table.status = 'finished';
    try {
      await query('BEGIN');
      if (result.type !== 'allBust' && result.winners?.length) {
        for (const w of result.winners) {
          await query('UPDATE users SET balance = balance + $1 WHERE id = $2', [result.prize, w.id]);
          await query(`INSERT INTO transactions (user_id,type,amount,description,status) VALUES ($1,'prize',$2,$3,'approved')`, [w.id, result.prize, `Premio El 21 $${table.level}`]);
        }
      } else if (result.type === 'allBust') {
        for (const p of table.players) await query('UPDATE users SET balance = balance + $1 WHERE id = $2', [p.bet, p.id]);
      }
      await query(`INSERT INTO game_sessions (game,status,pot,commission,prize,metadata,finished_at) VALUES ('el21','finished',$1,$2,$3,$4,NOW())`, [table.pot, table.commission, result.prize||0, JSON.stringify({level:table.level,players:table.players.length,result:result.type})]);
      await query('COMMIT');
    } catch(e) { await query('ROLLBACK').catch(()=>{}); }
    io.to(table.id).emit('el21:gameEnd', { result:result.type, winners:result.winners, prize:result.prize, allPlayers:result.allPlayers, pot:table.pot });
    setTimeout(() => el21.removeTable(table.id), 30000);
  }

  // ── Helpers Poker ─────────────────────────────────────────────
  function startActionTimer(io, table) {
    clearTurnTimer(table);
    io.to(table.id).emit('poker:timerStart', { seconds: poker.ACTION_TIMEOUT/1000 });
    table.turnTimer = setTimeout(() => {
      const p = table.players[table.currentTurn];
      if (p && !p.folded) {
        io.to(table.id).emit('poker:fold', { playerId:p.id, username:p.username, auto:true });
        const result = poker.fold(table, p.id);
        if (result.next) handlePokerNext(io, table, result.next);
      }
    }, poker.ACTION_TIMEOUT);
  }

  function handlePokerNext(io, table, next) {
    if (next.finished) {
      handlePokerEnd(io, table, next.result);
    } else if (next.newStreet) {
      io.to(table.id).emit('poker:newStreet', { street:next.newStreet, community:next.community, currentTurn:next.currentTurn, currentPlayer:next.currentPlayer });
      startActionTimer(io, table);
    } else {
      io.to(table.id).emit('poker:turnChange', { currentTurn:next.currentTurn, currentPlayer:next.currentPlayer, street:next.street });
      startActionTimer(io, table);
    }
  }

  async function handlePokerEnd(io, table, result) {
    clearTurnTimer(table);
    table.status = 'finished';
    try {
      await query('BEGIN');
      for (const w of result.winners) {
        await query('UPDATE users SET balance = balance + $1 WHERE id = $2', [w.prize, w.id]);
        await query(`INSERT INTO transactions (user_id,type,amount,description,status) VALUES ($1,'prize',$2,$3,'approved')`, [w.id, w.prize, `Premio Poker $${table.level}`]);
      }
      await query(`INSERT INTO game_sessions (game,status,pot,commission,prize,metadata,finished_at) VALUES ('poker','finished',$1,$2,$3,$4,NOW())`, [table.pot, table.commission, result.prize||0, JSON.stringify({level:table.level,players:table.players.length,result:result.type})]);
      await query('COMMIT');
    } catch(e) { await query('ROLLBACK').catch(()=>{}); }
    io.to(table.id).emit('poker:gameEnd', { result:result.type, winners:result.winners, prize:result.prize, allPlayers:result.allPlayers, community:result.community, pot:table.pot });
    setTimeout(() => poker.removeTable(table.id), 30000);
  }

  function clearTurnTimer(table) {
    if (table?.turnTimer) { clearTimeout(table.turnTimer); table.turnTimer = null; }
  }
};
