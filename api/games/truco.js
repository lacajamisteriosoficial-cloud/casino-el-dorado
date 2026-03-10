// ══════════════════════════════════════════════════════════════
// TRUCO ARGENTINO — Lógica P2P (1v1 y 2v2)
// ══════════════════════════════════════════════════════════════

// Mazo español (40 cartas, sin 8, 9, jokers)
const PALOS = ['espada', 'basto', 'copa', 'oro'];
const NUMEROS = [1, 2, 3, 4, 5, 6, 7, 10, 11, 12];

// Jerarquía de fuerza para el Truco (orden descendente de poder)
// 1e=1, 1b=2, 7e=3, 7o=4, 3=5, 2=6, 1(c/o)=7, 12=8, 11=9, 10=10, 6=11, 5=12, 4=13
const TRUCO_ORDER = [
  { n:1, p:'espada', v:1 },
  { n:1, p:'basto',  v:2 },
  { n:7, p:'espada', v:3 },
  { n:7, p:'oro',    v:4 },
  { n:3, p:'*',      v:5 },
  { n:2, p:'*',      v:6 },
  { n:1, p:'copa',   v:7 },
  { n:1, p:'oro',    v:7 },
  { n:12,p:'*',      v:8 },
  { n:11,p:'*',      v:9 },
  { n:10,p:'*',      v:10},
  { n:6, p:'*',      v:11},
  { n:5, p:'*',      v:12},
  { n:4, p:'*',      v:13},
];

// Valor para Envido (los 10,11,12 valen 0; resto val nominal)
function envidoVal(num) { return num >= 10 ? 0 : num; }

function trucoPoder(carta) {
  const entry = TRUCO_ORDER.find(e => e.n === carta.n && (e.p === carta.p || e.p === '*'));
  return entry ? entry.v : 99;
}

function createDeck() {
  const deck = [];
  for (const p of PALOS) for (const n of NUMEROS) deck.push({ n, p });
  return shuffle([...deck]);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── Niveles de mesa ────────────────────────────────────────────
const LEVELS = {
  500:  { entry: 500,  prize: 400,  commission: 100 },
  1000: { entry: 1000, prize: 800,  commission: 200 },
  5000: { entry: 5000, prize: 4000, commission: 1000 },
};

// ── Mesas ──────────────────────────────────────────────────────
const tables = new Map();

function getOrCreateTable(level, mode) {
  // mode: '1v1' o '2v2'
  const maxP = mode === '2v2' ? 4 : 2;
  for (const [id, t] of tables) {
    if (t.level === level && t.mode === mode && t.status === 'waiting' && t.players.length < maxP) return t;
  }
  const id = `ttr_${level}_${mode}_${Date.now()}`;
  const table = {
    id, level, mode,
    entry: LEVELS[level].entry,
    players: [],       // { id, username, socketId, team, hand, playedCards, tantoGanados }
    status: 'waiting', // waiting|playing|finished
    startTimer: null,
    // Estado de partida
    deck: [],
    round: 0,          // ronda dentro de la mano (0,1,2)
    playedThisRound: [], // { playerId, carta }
    roundWins: { A:[], B:[] }, // arrays de ronda ganadas por equipo
    // Tanto (puntos de la partida, primero en llegar a 15)
    tanto: { A: 0, B: 0 },
    // Truco
    trucoState: null,  // null | { caller, callerTeam, level:'truco'|'retruco'|'vale4', status:'called'|'accepted'|'refused' }
    trucoPoints: 1,    // puntos en juego por esta mano de truco
    // Envido
    envidoState: null, // null | { caller, callerTeam, level:'envido'|'envido-envido'|'real-envido'|'falta-envido', status:'called'|'accepted'|'refused' }
    envidoPoints: 2,   // puntos en juego por envido
    envidoResolved: false,
    // Turno
    currentTurn: 0,    // índice en players[]
    handFirst: 0,      // quién empieza la mano (rota)
    createdAt: Date.now(),
  };
  tables.set(id, table);
  return table;
}

function getTableById(id) { return tables.get(id); }

function getTablesInfo() {
  const result = { 500:{}, 1000:{}, 5000:{} };
  for (const lvl of [500,1000,5000]) {
    result[lvl] = { '1v1':[], '2v2':[] };
    for (const t of tables.values()) {
      if (t.level === lvl && t.status !== 'finished') {
        result[lvl][t.mode].push({ id:t.id, players:t.players.length, max: t.mode==='2v2'?4:2, status:t.status });
      }
    }
  }
  return result;
}

// ── Inicio de mano ─────────────────────────────────────────────
function dealHand(table) {
  table.deck = createDeck();
  table.round = 0;
  table.playedThisRound = [];
  table.roundWins = { A: [], B: [] };
  table.trucoState = null;
  table.trucoPoints = 1;
  table.envidoState = null;
  table.envidoPoints = 2;
  table.envidoResolved = false;

  for (const p of table.players) {
    p.hand = [table.deck.pop(), table.deck.pop(), table.deck.pop()];
    p.playedCards = [];
  }

  // El turno empieza en handFirst
  table.currentTurn = table.handFirst;
}

// ── Jugar carta ────────────────────────────────────────────────
function playCard(table, playerId, cardIndex) {
  const p = table.players[table.currentTurn];
  if (!p || p.id !== playerId) return { error: 'No es tu turno' };
  if (cardIndex < 0 || cardIndex >= p.hand.length) return { error: 'Carta inválida' };

  // Verificar que no haya un canto pendiente sin resolver
  if (table.trucoState?.status === 'called') return { error: 'Hay un Truco sin responder' };
  if (table.envidoState?.status === 'called') return { error: 'Hay un Envido sin responder' };

  const carta = p.hand[cardIndex];
  p.playedCards.push(carta);
  p.hand.splice(cardIndex, 1);
  table.playedThisRound.push({ playerId, carta, username: p.username, team: p.team });

  const result = { carta, username: p.username, playerId, team: p.team };

  // ¿Jugaron todos en esta ronda?
  const activePlayers = table.players; // todos juegan
  if (table.playedThisRound.length === activePlayers.length) {
    const roundResult = resolveRound(table);
    result.roundOver = true;
    result.roundResult = roundResult;

    // ¿Terminó la mano?
    const handResult = checkHandOver(table);
    if (handResult) {
      result.handOver = true;
      result.handResult = handResult;
      const gameOver = applyTantos(table, handResult);
      result.tanto = { ...table.tanto };
      if (gameOver) {
        result.gameOver = true;
        result.winner = gameOver;
      } else {
        // Preparar siguiente mano
        table.handFirst = (table.handFirst + 1) % table.players.length;
        dealHand(table);
        result.newHand = true;
        result.newCards = table.players.map(p => ({ id: p.id, handCount: p.hand.length }));
      }
    } else {
      // Siguiente ronda
      table.round++;
      table.playedThisRound = [];
      // El ganador de la ronda tira primero
      const winner = roundResult.winner;
      if (winner === 'parda') {
        // empate: sigue el mismo order (handFirst avanza)
        table.currentTurn = nextPlayerAfter(table, table.currentTurn);
      } else {
        const winnerIdx = table.players.findIndex(p => p.team === winner);
        table.currentTurn = winnerIdx >= 0 ? winnerIdx : 0;
      }
      result.nextTurn = table.currentTurn;
      result.nextPlayer = table.players[table.currentTurn]?.username;
    }
  } else {
    // Siguiente jugador
    table.currentTurn = nextPlayerAfter(table, table.currentTurn);
    result.roundOver = false;
    result.nextTurn = table.currentTurn;
    result.nextPlayer = table.players[table.currentTurn]?.username;
  }

  return result;
}

function nextPlayerAfter(table, idx) {
  return (idx + 1) % table.players.length;
}

function resolveRound(table) {
  const played = table.playedThisRound;
  // Comparar por poder (menor número = más fuerte)
  let best = null;
  let bestPoder = 999;
  let parda = false;

  for (const entry of played) {
    const poder = trucoPoder(entry.carta);
    if (poder < bestPoder) {
      bestPoder = poder;
      best = entry;
      parda = false;
    } else if (poder === bestPoder) {
      parda = true;
    }
  }

  let roundWinner;
  if (parda) {
    roundWinner = 'parda';
  } else {
    roundWinner = best.team;
    table.roundWins[best.team].push(table.round);
  }

  return {
    winner: roundWinner,
    played: played.map(e => ({ playerId: e.playerId, username: e.username, carta: e.carta, poder: trucoPoder(e.carta) })),
    round: table.round,
  };
}

function checkHandOver(table) {
  const wA = table.roundWins.A.length;
  const wB = table.roundWins.B.length;
  const totalRounds = table.round + 1; // ya se procesó

  // Ganó 2 rondas
  if (wA >= 2) return { winner: 'A', reason: 'rounds' };
  if (wB >= 2) return { winner: 'B', reason: 'rounds' };

  // Se jugaron 3 rondas y hay empate
  if (totalRounds >= 3) {
    if (wA === wB) return { winner: 'A', reason: 'parda-first' }; // gana quien empezó
    return { winner: wA > wB ? 'A' : 'B', reason: 'rounds' };
  }

  // 1ra ronda: si una tiene 1 y la otra 0, continúa
  return null;
}

function applyTantos(table, handResult) {
  table.tanto[handResult.winner] += table.trucoPoints;
  if (!table.envidoResolved) {
    // Envido no cantado: no sumar nada
  }
  // Ganar con 15+
  if (table.tanto.A >= 15) return 'A';
  if (table.tanto.B >= 15) return 'B';
  return null;
}

// ── Truco ──────────────────────────────────────────────────────
const TRUCO_LEVELS = ['truco', 'retruco', 'vale4'];
const TRUCO_PTS    = { truco:2, retruco:3, vale4:4 };

function callTruco(table, playerId, level) {
  const p = table.players.find(x => x.id === playerId);
  if (!p) return { error: 'Jugador no encontrado' };

  // Verificar que sea su turno o que al menos pueda cantar
  const cur = table.trucoState;
  if (cur) {
    if (cur.status === 'called') return { error: 'Ya hay un Truco pendiente' };
    if (cur.status === 'accepted') {
      // Puede subir: retruco después de truco, vale4 después de retruco
      const nextIdx = TRUCO_LEVELS.indexOf(cur.level) + 1;
      if (nextIdx >= TRUCO_LEVELS.length) return { error: 'No se puede subir más' };
      if (p.team === cur.callerTeam) return { error: 'No podés re-cantar tu propio truco' };
      level = TRUCO_LEVELS[nextIdx];
    }
  } else {
    level = 'truco';
  }

  table.trucoState = { caller: playerId, callerUsername: p.username, callerTeam: p.team, level, status: 'called' };
  return { ok: true, caller: p.username, level, team: p.team };
}

function respondTruco(table, playerId, accept) {
  if (!table.trucoState || table.trucoState.status !== 'called') return { error: 'No hay Truco pendiente' };
  const p = table.players.find(x => x.id === playerId);
  if (!p) return { error: 'Jugador no encontrado' };
  if (p.team === table.trucoState.callerTeam) return { error: 'No podés responder tu propio canto' };

  if (accept) {
    table.trucoState.status = 'accepted';
    table.trucoPoints = TRUCO_PTS[table.trucoState.level];
    return { ok: true, accepted: true, level: table.trucoState.level, points: table.trucoPoints };
  } else {
    // Rechazó: gana quien cantó
    table.trucoState.status = 'refused';
    const pts = TRUCO_PTS[table.trucoState.level] - 1;
    table.tanto[table.trucoState.callerTeam] += pts;
    return { ok: true, accepted: false, winner: table.trucoState.callerTeam, points: pts };
  }
}

// ── Envido ──────────────────────────────────────────────────────
const ENVIDO_LEVELS = ['envido','envido-envido','real-envido','falta-envido'];
const ENVIDO_PTS    = { 'envido':2, 'envido-envido':4, 'real-envido':3, 'falta-envido':999 };

function callEnvido(table, playerId, level) {
  if (table.envidoResolved) return { error: 'El envido ya se resolvió' };
  if (table.round > 0) return { error: 'El envido solo se puede cantar en la primera ronda' };
  const p = table.players.find(x => x.id === playerId);
  if (!p) return { error: 'Jugador no encontrado' };

  const cur = table.envidoState;
  if (cur) {
    if (cur.status === 'called') return { error: 'Ya hay un Envido pendiente' };
    const nextIdx = ENVIDO_LEVELS.indexOf(level);
    const curIdx  = ENVIDO_LEVELS.indexOf(cur.level);
    if (nextIdx <= curIdx) return { error: 'Debés subir el nivel del envido' };
  }

  level = level || 'envido';
  table.envidoState = { caller: playerId, callerUsername: p.username, callerTeam: p.team, level, status: 'called' };
  table.envidoPoints = ENVIDO_PTS[level];
  return { ok: true, caller: p.username, level, team: p.team };
}

function respondEnvido(table, playerId, accept) {
  if (!table.envidoState || table.envidoState.status !== 'called') return { error: 'No hay Envido pendiente' };
  const p = table.players.find(x => x.id === playerId);
  if (!p) return { error: 'Jugador no encontrado' };
  if (p.team === table.envidoState.callerTeam) return { error: 'No podés responder tu propio canto' };

  if (accept) {
    table.envidoState.status = 'accepted';
    // Calcular puntos de envido para cada jugador
    const scores = table.players.map(pl => ({ id: pl.id, username: pl.username, team: pl.team, pts: calcEnvido(pl.hand) }));
    // Equipo con más puntos gana
    const teamA = scores.filter(s => s.team === 'A');
    const teamB = scores.filter(s => s.team === 'B');
    const maxA  = Math.max(...teamA.map(s => s.pts));
    const maxB  = Math.max(...teamB.map(s => s.pts));
    let winTeam = maxA >= maxB ? 'A' : 'B'; // empate gana el que canta (caller)
    if (maxA === maxB) winTeam = table.envidoState.callerTeam;
    const pts = table.envidoPoints === 999
      ? (15 - table.tanto[winTeam === 'A' ? 'B' : 'A'])  // falta envido
      : table.envidoPoints;
    table.tanto[winTeam] += pts;
    table.envidoResolved = true;
    return { ok: true, accepted: true, scores, winTeam, pts };
  } else {
    table.envidoState.status = 'refused';
    const pts = 1;
    table.tanto[table.envidoState.callerTeam] += pts;
    table.envidoResolved = true;
    return { ok: true, accepted: false, winner: table.envidoState.callerTeam, pts };
  }
}

function calcEnvido(hand) {
  // Máximo entre todos los palos: si hay 2+ del mismo palo → 20 + suma de los 2 más altos
  const porPalo = {};
  for (const c of hand) {
    if (!porPalo[c.p]) porPalo[c.p] = [];
    porPalo[c.p].push(envidoVal(c.n));
  }
  let max = 0;
  for (const vals of Object.values(porPalo)) {
    let score;
    if (vals.length === 1) score = vals[0];
    else { vals.sort((a,b)=>b-a); score = 20 + vals[0] + vals[1]; }
    if (score > max) max = score;
  }
  return max;
}

// ── Irse al mazo ───────────────────────────────────────────────
function irseAlMazo(table, playerId) {
  const p = table.players.find(x => x.id === playerId);
  if (!p) return { error: 'Jugador no encontrado' };
  const loserTeam = p.team;
  const winTeam   = loserTeam === 'A' ? 'B' : 'A';
  table.tanto[winTeam] += 1;
  return { ok: true, winner: winTeam, loser: loserTeam, loserName: p.username };
}

function removeTable(id) { tables.delete(id); }

module.exports = {
  getOrCreateTable, getTableById, getTablesInfo, dealHand,
  playCard, callTruco, respondTruco, callEnvido, respondEnvido,
  irseAlMazo, removeTable, LEVELS,
};
