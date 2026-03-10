const jwt    = require('jsonwebtoken');
const { query } = require('../config/db');
const el21   = require('./el21');
const poker  = require('./poker');
const truco  = require('./truco');

module.exports = function setupSockets(io) {

  // Auth middleware
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('No autorizado'));
    try { socket.user = jwt.verify(token, process.env.JWT_SECRET); next(); }
    catch(e) { next(new Error('Token inválido')); }
  });

  io.on('connection', (socket) => {
    const { id: userId, username } = socket.user;

    // ════════════════════════════════════════════
    // EL 21
    // ════════════════════════════════════════════
    socket.on('el21:getTables', () => socket.emit('el21:tables', el21.getTablesInfo()));

    socket.on('el21:join', async ({ level }) => {
      if (![500,1000,5000].includes(level)) return socket.emit('el21:error','Nivel inválido');
      try {
        const res = await query('SELECT balance FROM users WHERE id=$1',[userId]);
        if (!res.rows.length) return socket.emit('el21:error','Usuario no encontrado');
        const balance = parseFloat(res.rows[0].balance);
        const entry = el21.LEVELS[level].entry;
        if (balance < entry) return socket.emit('el21:error',`Saldo insuficiente. Necesitás $${entry}`);
        await query('BEGIN');
        await query('UPDATE users SET balance=balance-$1 WHERE id=$2',[entry,userId]);
        await query(`INSERT INTO transactions(user_id,type,amount,description,status)VALUES($1,'bet',$2,$3,'approved')`,[userId,entry,`Entrada El 21 $${level}`]);
        await query('COMMIT');
      } catch(e){ await query('ROLLBACK').catch(()=>{}); return socket.emit('el21:error','Error al procesar pago'); }

      const table = el21.getOrCreateTable(level);
      socket.join(table.id);
      table.players.push({ id:userId, username, socketId:socket.id, cards:[], value:0, status:'waiting', bet:el21.LEVELS[level].entry });
      socket.tableId = table.id; socket.gameType = 'el21';

      io.to(table.id).emit('el21:playerJoined',{ tableId:table.id, players:table.players.map(p=>({id:p.id,username:p.username})), level:table.level, needed:Math.max(0,el21.MIN_PLAYERS-table.players.length) });
      socket.emit('el21:joined',{ tableId:table.id, level:table.level, entry:el21.LEVELS[level].entry });

      if (table.players.length>=el21.MIN_PLAYERS && table.status==='waiting') {
        if (table.startTimer) clearTimeout(table.startTimer);
        io.to(table.id).emit('el21:countdown',{seconds:10,players:table.players.length});
        table.startTimer = setTimeout(()=>{
          if (table.status==='waiting' && table.players.length>=el21.MIN_PLAYERS) {
            el21.startGame(table);
            io.to(table.id).emit('el21:gameStart',{ tableId:table.id, pot:table.pot, commission:table.commission, players:table.players.map(p=>({id:p.id,username:p.username,value:p.value})), currentTurn:0, currentPlayer:table.players[0].username });
            for (const p of table.players) { const s=io.sockets.sockets.get(p.socketId); if(s) s.emit('el21:yourCards',{cards:p.cards,value:p.value}); }
            startTurnTimer21(io,table);
          }
        },10000);
      }
    });

    socket.on('el21:hit', ()=>{
      if (socket.gameType!=='el21') return;
      const table = el21.getTableById(socket.tableId);
      if (!table||table.status!=='playing') return;
      clearTurnTimer(table);
      const result = el21.hit(table, userId);
      if (result.error) return socket.emit('el21:error',result.error);
      io.to(table.id).emit('el21:hit',{playerId:userId,username,card:result.card,value:result.value,bust:result.bust});
      if (result.nextTurn?.finished) handleEl21End(io,table,result.nextTurn.result);
      else { if(result.nextTurn){io.to(table.id).emit('el21:turnChange',{currentTurn:result.nextTurn.currentTurn,currentPlayer:result.nextTurn.currentPlayer});startTurnTimer21(io,table);} }
    });

    socket.on('el21:stand', ()=>{
      if (socket.gameType!=='el21') return;
      const table = el21.getTableById(socket.tableId);
      if (!table||table.status!=='playing') return;
      clearTurnTimer(table);
      const result = el21.stand(table, userId);
      if (result.error) return socket.emit('el21:error',result.error);
      io.to(table.id).emit('el21:stood',{playerId:userId,username});
      if (result.nextTurn?.finished) handleEl21End(io,table,result.nextTurn.result);
      else { io.to(table.id).emit('el21:turnChange',{currentTurn:result.nextTurn.currentTurn,currentPlayer:result.nextTurn.currentPlayer});startTurnTimer21(io,table); }
    });

    // ════════════════════════════════════════════
    // POKER
    // ════════════════════════════════════════════
    socket.on('poker:getTables', () => socket.emit('poker:tables', poker.getTablesInfo()));

    socket.on('poker:join', async ({ level }) => {
      if (![500,1000,5000].includes(level)) return socket.emit('poker:error','Nivel inválido');
      try {
        const res = await query('SELECT balance FROM users WHERE id=$1',[userId]);
        if (!res.rows.length) return socket.emit('poker:error','Usuario no encontrado');
        const balance = parseFloat(res.rows[0].balance);
        const entry = poker.LEVELS[level].entry;
        if (balance < entry) return socket.emit('poker:error',`Saldo insuficiente. Necesitás $${entry}`);
        await query('BEGIN');
        await query('UPDATE users SET balance=balance-$1 WHERE id=$2',[entry,userId]);
        await query(`INSERT INTO transactions(user_id,type,amount,description,status)VALUES($1,'bet',$2,$3,'approved')`,[userId,entry,`Entrada Poker $${level}`]);
        await query('COMMIT');
      } catch(e){ await query('ROLLBACK').catch(()=>{}); return socket.emit('poker:error','Error al procesar pago'); }

      const table = poker.getOrCreateTable(level);
      socket.join(table.id);
      table.players.push({ id:userId, username, socketId:socket.id, hand:[], status:'waiting', bet:0 });
      socket.tableId = table.id; socket.gameType = 'poker';

      io.to(table.id).emit('poker:playerJoined',{ tableId:table.id, players:table.players.map(p=>({id:p.id,username:p.username})), level:table.level, needed:Math.max(0,poker.MIN_PLAYERS-table.players.length) });
      socket.emit('poker:joined',{ tableId:table.id, level:table.level, entry:poker.LEVELS[level].entry });

      if (table.players.length>=poker.MIN_PLAYERS && table.status==='waiting') {
        if (table.startTimer) clearTimeout(table.startTimer);
        io.to(table.id).emit('poker:countdown',{seconds:15,players:table.players.length});
        table.startTimer = setTimeout(()=>{
          if (table.status==='waiting' && table.players.length>=poker.MIN_PLAYERS) {
            poker.startGame(table);
            for (const p of table.players) { const s=io.sockets.sockets.get(p.socketId); if(s) s.emit('poker:yourHand',{hand:p.hand}); }
            io.to(table.id).emit('poker:gameStart',{ tableId:table.id, pot:table.pot, commission:table.commission, players:table.players.map(p=>({id:p.id,username:p.username,status:p.status})), community:[], phase:'preflop', currentTurn:table.currentTurn, currentPlayer:table.players[table.currentTurn].username });
            startTurnTimerPoker(io,table);
          }
        },15000);
      }
    });

    socket.on('poker:action', ({ action, amount }) => {
      if (socket.gameType!=='poker') return;
      const table = poker.getTableById(socket.tableId);
      if (!table||table.status!=='playing') return;
      clearTurnTimer(table);
      const result = poker.playerAction(table, userId, action, amount);
      if (result.error) return socket.emit('poker:error',result.error);
      io.to(table.id).emit('poker:action',{playerId:userId,username,action,amount:amount||0});
      if (result.nextTurn?.finished) handlePokerEnd(io,table,result.nextTurn.result);
      else { const nt=result.nextTurn; io.to(table.id).emit('poker:turnChange',{currentTurn:nt.currentTurn,currentPlayer:nt.currentPlayer,phase:nt.phase,community:nt.community||table.community,minBet:table.minBet}); startTurnTimerPoker(io,table); }
    });

    // ════════════════════════════════════════════
    // TRUCO
    // ════════════════════════════════════════════
    socket.on('truco:getTables', () => socket.emit('truco:tables', truco.getTablesInfo()));

    socket.on('truco:join', async ({ level, mode }) => {
      if (![500,1000,5000].includes(level)) return socket.emit('truco:error','Nivel inválido');
      if (!['1v1','2v2'].includes(mode)) return socket.emit('truco:error','Modo inválido');
      try {
        const res = await query('SELECT balance FROM users WHERE id=$1',[userId]);
        if (!res.rows.length) return socket.emit('truco:error','Usuario no encontrado');
        const balance = parseFloat(res.rows[0].balance);
        const entry = truco.LEVELS[level].entry;
        if (balance < entry) return socket.emit('truco:error',`Saldo insuficiente. Necesitás $${entry}`);
        await query('BEGIN');
        await query('UPDATE users SET balance=balance-$1 WHERE id=$2',[entry,userId]);
        await query(`INSERT INTO transactions(user_id,type,amount,description,status)VALUES($1,'bet',$2,$3,'approved')`,[userId,entry,`Entrada Truco ${mode} $${level}`]);
        await query('COMMIT');
      } catch(e){ await query('ROLLBACK').catch(()=>{}); return socket.emit('truco:error','Error al procesar pago'); }

      const table = truco.getOrCreateTable(level, mode);
      socket.join(table.id);
      const maxP = mode==='2v2' ? 4 : 2;
      // Asignar equipo: 1v1 → A/B alternado; 2v2 → A A B B
      const idx = table.players.length;
      const team = mode==='1v1' ? (idx===0?'A':'B') : (idx<2?'A':'B');
      table.players.push({ id:userId, username, socketId:socket.id, team, hand:[], playedCards:[], tantoGanados:0, bet:truco.LEVELS[level].entry });
      socket.tableId = table.id; socket.gameType = 'truco';

      io.to(table.id).emit('truco:playerJoined',{ tableId:table.id, players:table.players.map(p=>({id:p.id,username:p.username,team:p.team})), needed:Math.max(0,maxP-table.players.length), mode, level });
      socket.emit('truco:joined',{ tableId:table.id, level, mode, entry:truco.LEVELS[level].entry, team });

      if (table.players.length===maxP && table.status==='waiting') {
        if (table.startTimer) clearTimeout(table.startTimer);
        io.to(table.id).emit('truco:countdown',{seconds:10});
        table.startTimer = setTimeout(()=>{
          if (table.status==='waiting' && table.players.length===maxP) {
            table.status = 'playing';
            truco.dealHand(table);
            emitGameState(io, table, 'truco:gameStart');
          }
        },10000);
      }
    });

    socket.on('truco:playCard', ({ cardIndex }) => {
      if (socket.gameType!=='truco') return;
      const table = truco.getTableById(socket.tableId);
      if (!table||table.status!=='playing') return;
      const result = truco.playCard(table, userId, cardIndex);
      if (result.error) return socket.emit('truco:error', result.error);
      io.to(table.id).emit('truco:cardPlayed', {
        playerId: userId, username, team: result.team, carta: result.carta,
        nextTurn: result.nextTurn, nextPlayer: result.nextPlayer,
        roundOver: result.roundOver, roundResult: result.roundResult || null,
      });
      if (result.roundOver) {
        io.to(table.id).emit('truco:roundResult', result.roundResult);
      }
      if (result.handOver) {
        io.to(table.id).emit('truco:handOver', { handResult: result.handResult, tanto: result.tanto });
        if (result.gameOver) {
          handleTrucoEnd(io, table, result.gameOver);
        } else if (result.newHand) {
          // Repartir nueva mano — enviar cartas privadas
          for (const p of table.players) {
            const s = io.sockets.sockets.get(p.socketId);
            if (s) s.emit('truco:yourHand', { hand: p.hand });
          }
          io.to(table.id).emit('truco:newHand', {
            tanto: table.tanto,
            currentTurn: table.currentTurn,
            currentPlayer: table.players[table.currentTurn]?.username,
            players: table.players.map(p=>({id:p.id,username:p.username,team:p.team,handCount:p.hand.length})),
          });
        }
      }
    });

    socket.on('truco:callTruco', ({ level }) => {
      if (socket.gameType!=='truco') return;
      const table = truco.getTableById(socket.tableId);
      if (!table||table.status!=='playing') return;
      const result = truco.callTruco(table, userId, level);
      if (result.error) return socket.emit('truco:error', result.error);
      io.to(table.id).emit('truco:trucoCalled', { caller: username, callerTeam: result.team, level: result.level, callerPlayerId: userId });
    });

    socket.on('truco:respondTruco', ({ accept }) => {
      if (socket.gameType!=='truco') return;
      const table = truco.getTableById(socket.tableId);
      if (!table||table.status!=='playing') return;
      const result = truco.respondTruco(table, userId, accept);
      if (result.error) return socket.emit('truco:error', result.error);
      io.to(table.id).emit('truco:trucoResponse', { accepted: result.accepted, level: result.level, points: result.points, winner: result.winner });
      if (!result.accepted) {
        // Mano terminó por rechazo
        io.to(table.id).emit('truco:handOver', { handResult: { winner: result.winner, reason: 'truco-refused' }, tanto: table.tanto });
        const gameOver = table.tanto.A>=15?'A': table.tanto.B>=15?'B':null;
        if (gameOver) handleTrucoEnd(io, table, gameOver);
        else startNewHand(io, table);
      }
    });

    socket.on('truco:callEnvido', ({ level }) => {
      if (socket.gameType!=='truco') return;
      const table = truco.getTableById(socket.tableId);
      if (!table||table.status!=='playing') return;
      const result = truco.callEnvido(table, userId, level||'envido');
      if (result.error) return socket.emit('truco:error', result.error);
      io.to(table.id).emit('truco:envidoCalled', { caller: username, callerTeam: result.team, level: result.level, callerPlayerId: userId });
    });

    socket.on('truco:respondEnvido', ({ accept }) => {
      if (socket.gameType!=='truco') return;
      const table = truco.getTableById(socket.tableId);
      if (!table||table.status!=='playing') return;
      const result = truco.respondEnvido(table, userId, accept);
      if (result.error) return socket.emit('truco:error', result.error);
      io.to(table.id).emit('truco:envidoResponse', { accepted: result.accepted, scores: result.scores||null, winTeam: result.winTeam, pts: result.pts, winner: result.winner, tanto: table.tanto });
    });

    socket.on('truco:irseAlMazo', () => {
      if (socket.gameType!=='truco') return;
      const table = truco.getTableById(socket.tableId);
      if (!table||table.status!=='playing') return;
      const result = truco.irseAlMazo(table, userId);
      if (result.error) return socket.emit('truco:error', result.error);
      io.to(table.id).emit('truco:alMazo', { loserName: result.loserName, winner: result.winner, tanto: table.tanto });
      io.to(table.id).emit('truco:handOver', { handResult: { winner: result.winner, reason: 'al-mazo' }, tanto: table.tanto });
      const gameOver = table.tanto.A>=15?'A': table.tanto.B>=15?'B':null;
      if (gameOver) handleTrucoEnd(io, table, gameOver);
      else startNewHand(io, table);
    });

    // ── Desconexión ───────────────────────────────────────────
    socket.on('disconnect', () => {
      if (!socket.tableId || !socket.gameType) return;

      if (socket.gameType === 'truco') {
        const table = truco.getTableById(socket.tableId);
        if (!table) return;
        if (table.status === 'waiting') {
          const idx = table.players.findIndex(p=>p.socketId===socket.id);
          if (idx !== -1) {
            const p = table.players[idx];
            query('UPDATE users SET balance=balance+$1 WHERE id=$2',[p.bet,p.id]).catch(()=>{});
            table.players.splice(idx,1);
            if (table.players.length===0) { if(table.startTimer) clearTimeout(table.startTimer); truco.removeTable(table.id); }
            else io.to(table.id).emit('truco:playerLeft',{username,players:table.players.map(p=>({id:p.id,username:p.username,team:p.team}))});
          }
        } else {
          // En juego: el equipo contrario gana
          const p = table.players.find(p=>p.socketId===socket.id);
          if (p) {
            const winTeam = p.team==='A'?'B':'A';
            io.to(table.id).emit('truco:playerDisconnected',{username,winner:winTeam});
            handleTrucoEnd(io, table, winTeam);
          }
        }
      } else if (socket.gameType === 'poker') {
        const table = poker.getTableById(socket.tableId);
        if (!table) return;
        if (table.status==='waiting') {
          const idx = table.players.findIndex(p=>p.socketId===socket.id);
          if (idx!==-1) {
            const p = table.players[idx];
            query('UPDATE users SET balance=balance+$1 WHERE id=$2',[p.bet||poker.LEVELS[table.level].entry,p.id]).catch(()=>{});
            table.players.splice(idx,1);
            if(table.players.length===0){if(table.startTimer)clearTimeout(table.startTimer);poker.removeTable(table.id);}
          }
        } else if (table.status==='playing') {
          const p = table.players.find(p=>p.socketId===socket.id);
          if (p&&p.status==='active') {
            p.status='folded';
            const r=poker.playerAction(table,p.id,'fold');
            if(r.nextTurn?.finished) handlePokerEnd(io,table,r.nextTurn.result);
            else if(r.nextTurn){io.to(table.id).emit('poker:turnChange',{currentTurn:r.nextTurn.currentTurn,currentPlayer:r.nextTurn.currentPlayer,phase:r.nextTurn.phase,community:table.community,minBet:table.minBet});startTurnTimerPoker(io,table);}
          }
        }
      } else if (socket.gameType === 'el21') {
        const table = el21.getTableById(socket.tableId);
        if (!table||table.status!=='waiting') return;
        const idx = table.players.findIndex(p=>p.socketId===socket.id);
        if (idx!==-1) {
          const p = table.players[idx];
          query('UPDATE users SET balance=balance+$1 WHERE id=$2',[p.bet,p.id]).catch(()=>{});
          table.players.splice(idx,1);
          if(table.players.length===0){if(table.startTimer)clearTimeout(table.startTimer);el21.removeTable(table.id);}
          else io.to(table.id).emit('el21:playerLeft',{username,players:table.players.length});
        }
      }
    });
  });

  // ════════════════════════════════════════════
  // HELPERS
  // ════════════════════════════════════════════

  function emitGameState(io, table, event) {
    // Enviar cartas privadas a cada jugador
    for (const p of table.players) {
      const s = io.sockets.sockets.get(p.socketId);
      if (s) s.emit('truco:yourHand', { hand: p.hand });
    }
    io.to(table.id).emit(event, {
      tableId: table.id,
      tanto: table.tanto,
      mode: table.mode,
      level: table.level,
      players: table.players.map(p=>({ id:p.id, username:p.username, team:p.team, handCount:p.hand.length })),
      currentTurn: table.currentTurn,
      currentPlayer: table.players[table.currentTurn]?.username,
    });
  }

  function startNewHand(io, table) {
    table.handFirst = (table.handFirst + 1) % table.players.length;
    truco.dealHand(table);
    for (const p of table.players) {
      const s = io.sockets.sockets.get(p.socketId);
      if (s) s.emit('truco:yourHand', { hand: p.hand });
    }
    io.to(table.id).emit('truco:newHand', {
      tanto: table.tanto,
      currentTurn: table.currentTurn,
      currentPlayer: table.players[table.currentTurn]?.username,
      players: table.players.map(p=>({ id:p.id, username:p.username, team:p.team, handCount:p.hand.length })),
    });
  }

  async function handleTrucoEnd(io, table, winnerTeam) {
    table.status = 'finished';
    clearTurnTimer(table);
    const winners = table.players.filter(p=>p.team===winnerTeam);
    const prize = truco.LEVELS[table.level].prize;
    const perWinner = Math.floor(prize / winners.length);
    try {
      await query('BEGIN');
      for (const w of winners) {
        await query('UPDATE users SET balance=balance+$1 WHERE id=$2',[perWinner,w.id]);
        await query(`INSERT INTO transactions(user_id,type,amount,description,status)VALUES($1,'prize',$2,$3,'approved')`,[w.id,perWinner,`Premio Truco $${table.level}`]);
      }
      await query(`INSERT INTO game_sessions(game,status,pot,commission,prize,metadata,finished_at)VALUES('truco','finished',$1,$2,$3,$4,NOW())`,[
        table.players.length*truco.LEVELS[table.level].entry,
        table.players.length*truco.LEVELS[table.level].commission,
        prize,
        JSON.stringify({level:table.level,mode:table.mode,winnerTeam})
      ]);
      await query('COMMIT');
    } catch(e){ await query('ROLLBACK').catch(()=>{}); }
    io.to(table.id).emit('truco:gameEnd',{
      winnerTeam,
      winners: winners.map(w=>({id:w.id,username:w.username})),
      prize: perWinner,
      tanto: table.tanto,
      allPlayers: table.players.map(p=>({id:p.id,username:p.username,team:p.team})),
    });
    setTimeout(()=>truco.removeTable(table.id), 30000);
  }

  // ── Timers ────────────────────────────────────────────────────
  function startTurnTimer21(io,table) {
    clearTurnTimer(table);
    io.to(table.id).emit('el21:timerStart',{seconds:30});
    table.turnTimer = setTimeout(()=>{
      const p=table.players[table.currentTurn];
      if(p&&p.status==='playing'){
        io.to(table.id).emit('el21:autoStand',{username:p.username});
        const r=el21.stand(table,p.id);
        if(r.nextTurn?.finished) handleEl21End(io,table,r.nextTurn.result);
        else if(r.nextTurn){io.to(table.id).emit('el21:turnChange',{currentTurn:r.nextTurn.currentTurn,currentPlayer:r.nextTurn.currentPlayer});startTurnTimer21(io,table);}
      }
    },el21.TURN_TIMEOUT);
  }

  function startTurnTimerPoker(io,table) {
    clearTurnTimer(table);
    io.to(table.id).emit('poker:timerStart',{seconds:30});
    table.turnTimer = setTimeout(()=>{
      const p=table.players[table.currentTurn];
      if(p&&p.status==='active'){
        io.to(table.id).emit('poker:action',{playerId:p.id,username:p.username,action:'fold',amount:0});
        const r=poker.playerAction(table,p.id,'fold');
        if(r.nextTurn?.finished) handlePokerEnd(io,table,r.nextTurn.result);
        else if(r.nextTurn){io.to(table.id).emit('poker:turnChange',{currentTurn:r.nextTurn.currentTurn,currentPlayer:r.nextTurn.currentPlayer,phase:r.nextTurn.phase,community:table.community,minBet:table.minBet});startTurnTimerPoker(io,table);}
      }
    },poker.TURN_TIMEOUT);
  }

  function clearTurnTimer(table) {
    if(table.turnTimer){clearTimeout(table.turnTimer);table.turnTimer=null;}
  }

  async function handleEl21End(io,table,result) {
    clearTurnTimer(table); table.status='finished';
    try {
      await query('BEGIN');
      if(result.type!=='allBust'&&result.winners.length>0){
        for(const w of result.winners){
          await query('UPDATE users SET balance=balance+$1 WHERE id=$2',[result.prize,w.id]);
          await query(`INSERT INTO transactions(user_id,type,amount,description,status)VALUES($1,'prize',$2,$3,'approved')`,[w.id,result.prize,`Premio El 21 $${table.level}`]);
        }
      } else if(result.type==='allBust'){
        for(const p of table.players) await query('UPDATE users SET balance=balance+$1 WHERE id=$2',[p.bet,p.id]);
      }
      await query(`INSERT INTO game_sessions(game,status,pot,commission,prize,metadata,finished_at)VALUES('el21','finished',$1,$2,$3,$4,NOW())`,[table.pot,table.commission,result.prize||0,JSON.stringify({level:table.level,players:table.players.length,result:result.type})]);
      await query('COMMIT');
    } catch(e){await query('ROLLBACK').catch(()=>{}); }
    io.to(table.id).emit('el21:gameEnd',{result:result.type,winners:result.winners,prize:result.prize,allPlayers:result.allPlayers,pot:table.pot});
    setTimeout(()=>el21.removeTable(table.id),30000);
  }

  async function handlePokerEnd(io,table,result) {
    clearTurnTimer(table); table.status='finished';
    try {
      await query('BEGIN');
      for(const w of result.winners){
        await query('UPDATE users SET balance=balance+$1 WHERE id=$2',[result.prize,w.id]);
        await query(`INSERT INTO transactions(user_id,type,amount,description,status)VALUES($1,'prize',$2,$3,'approved')`,[w.id,result.prize,`Premio Poker $${table.level}`]);
      }
      await query(`INSERT INTO game_sessions(game,status,pot,commission,prize,metadata,finished_at)VALUES('poker','finished',$1,$2,$3,$4,NOW())`,[table.pot,table.commission,result.prize||0,JSON.stringify({level:table.level,players:table.players.length,result:result.type})]);
      await query('COMMIT');
    } catch(e){await query('ROLLBACK').catch(()=>{});}
    io.to(table.id).emit('poker:gameEnd',{result:result.type,winners:result.winners,prize:result.prize,allPlayers:result.allPlayers,pot:table.pot,community:table.community});
    setTimeout(()=>poker.removeTable(table.id),30000);
  }
};
