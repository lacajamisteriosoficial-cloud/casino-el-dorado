// ══════════════════════════════════════════════
// EL 21 — Lógica del juego P2P
// ══════════════════════════════════════════════

const SUITS = ['♠','♥','♦','♣'];
const RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];

function createDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ r, s });
  return shuffle(deck);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function cardValue(card) {
  if (['J','Q','K'].includes(card.r)) return 10;
  if (card.r === 'A') return 11; // se ajusta después
  return parseInt(card.r);
}

function handValue(cards) {
  let total = 0, aces = 0;
  for (const c of cards) {
    const v = cardValue(c);
    total += v;
    if (c.r === 'A') aces++;
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

// Niveles de mesa
const LEVELS = {
  500:  { entry: 500,  pot: 400,  commission: 100 },
  1000: { entry: 1000, pot: 800,  commission: 200 },
  5000: { entry: 5000, pot: 4000, commission: 1000 },
};

const MIN_PLAYERS = 3;
const MAX_PLAYERS = 6;
const TURN_TIMEOUT = 30000; // 30 segundos por turno

// Mesas activas en memoria: { tableId -> tableState }
const tables = new Map();

function getOrCreateTable(level) {
  // Buscar mesa con espacio en nivel pedido
  for (const [id, t] of tables) {
    if (t.level === level && t.status === 'waiting' && t.players.length < MAX_PLAYERS) {
      return t;
    }
  }
  // Crear nueva mesa
  const id = `t21_${level}_${Date.now()}`;
  const table = {
    id, level,
    entry: LEVELS[level].entry,
    pot: 0,
    commission: 0,
    players: [],   // { id, username, socketId, cards, value, status, bet }
    deck: [],
    currentTurn: 0,
    status: 'waiting', // waiting | playing | finished
    winner: null,
    startTimer: null,
    turnTimer: null,
    createdAt: Date.now(),
  };
  tables.set(id, table);
  return table;
}

function getTableById(id) { return tables.get(id); }

function getTablesInfo() {
  const result = { 500: [], 1000: [], 5000: [] };
  for (const t of tables.values()) {
    if (t.status !== 'finished') {
      result[t.level].push({
        id: t.id, players: t.players.length,
        max: MAX_PLAYERS, min: MIN_PLAYERS, status: t.status
      });
    }
  }
  return result;
}

function startGame(table) {
  table.status = 'playing';
  table.deck = createDeck();
  table.pot = 0;
  table.commission = 0;

  const levelCfg = LEVELS[table.level];
  for (const p of table.players) {
    p.cards = [table.deck.pop(), table.deck.pop()];
    p.value = handValue(p.cards);
    p.status = 'playing'; // playing | stood | bust
    table.pot += levelCfg.pot;
    table.commission += levelCfg.commission;
  }

  table.currentTurn = 0;
  // Saltar jugadores ya bustados (no debería pasar con 2 cartas)
  return table;
}

function hit(table, playerId) {
  const p = table.players[table.currentTurn];
  if (!p || p.id !== playerId) return { error: 'No es tu turno' };
  if (p.status !== 'playing') return { error: 'Ya terminaste tu turno' };

  const card = table.deck.pop();
  p.cards.push(card);
  p.value = handValue(p.cards);

  if (p.value > 21) {
    p.status = 'bust';
    return { card, value: p.value, bust: true, nextTurn: advanceTurn(table) };
  }
  if (p.value === 21) {
    p.status = 'stood';
    return { card, value: p.value, bust: false, stood: true, nextTurn: advanceTurn(table) };
  }
  return { card, value: p.value, bust: false };
}

function stand(table, playerId) {
  const p = table.players[table.currentTurn];
  if (!p || p.id !== playerId) return { error: 'No es tu turno' };
  p.status = 'stood';
  return { nextTurn: advanceTurn(table) };
}

function advanceTurn(table) {
  // Buscar próximo jugador que siga 'playing'
  let next = table.currentTurn + 1;
  while (next < table.players.length && table.players[next].status !== 'playing') next++;

  if (next >= table.players.length) {
    // Todos terminaron — calcular ganador
    table.status = 'finished';
    return { finished: true, result: calcWinner(table) };
  }
  table.currentTurn = next;
  return { finished: false, currentTurn: next, currentPlayer: table.players[next].username };
}

function calcWinner(table) {
  const alive = table.players.filter(p => p.status !== 'bust');
  if (alive.length === 0) {
    // Todos se pasaron — nadie gana, se devuelve la apuesta (sin comisión)
    table.winner = null;
    return { type: 'allBust', prize: 0, winners: [] };
  }

  const maxVal = Math.max(...alive.map(p => p.value));
  const winners = alive.filter(p => p.value === maxVal);

  const prize = Math.floor(table.pot / winners.length);
  table.winner = winners.map(w => w.id);

  return {
    type: winners.length > 1 ? 'draw' : 'win',
    prize,
    winners: winners.map(w => ({ id: w.id, username: w.username, value: w.value })),
    allPlayers: table.players.map(p => ({ id: p.id, username: p.username, value: p.value, status: p.status, cards: p.cards }))
  };
}

function removeTable(id) { tables.delete(id); }

module.exports = { getOrCreateTable, getTableById, getTablesInfo, startGame, hit, stand, removeTable, MIN_PLAYERS, MAX_PLAYERS, TURN_TIMEOUT, LEVELS };
