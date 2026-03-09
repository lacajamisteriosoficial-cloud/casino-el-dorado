// ══════════════════════════════════════════════
// POKER TEXAS HOLD'EM — Lógica P2P
// ══════════════════════════════════════════════

const SUITS = ['♠','♥','♦','♣'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RANK_VAL = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 };

const LEVELS = {
  500:  { entry:500,  pot:400,  commission:100 },
  1000: { entry:1000, pot:800,  commission:200 },
  5000: { entry:5000, pot:4000, commission:1000 },
};
const MIN_PLAYERS = 4;
const MAX_PLAYERS = 6;
const ACTION_TIMEOUT = 30000;

function createDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ r, s });
  return shuffle([...d]);
}
function shuffle(a) {
  for (let i = a.length-1; i>0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}

// ── Evaluación de manos ───────────────────────────────────────
function evalHand(cards) {
  // cards: array de 5-7 cartas, devuelve la mejor mano de 5
  const best = bestFive(cards);
  return { ...rankHand(best), cards: best };
}

function bestFive(cards) {
  if (cards.length === 5) return cards;
  let best = null, bestScore = -1;
  const combos = combinations(cards, 5);
  for (const combo of combos) {
    const score = rankHand(combo).score;
    if (score > bestScore) { bestScore = score; best = combo; }
  }
  return best;
}

function combinations(arr, k) {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const [first, ...rest] = arr;
  return [
    ...combinations(rest, k-1).map(c => [first, ...c]),
    ...combinations(rest, k)
  ];
}

function rankHand(cards) {
  const vals = cards.map(c => RANK_VAL[c.r]).sort((a,b) => b-a);
  const suits = cards.map(c => c.s);
  const isFlush = suits.every(s => s === suits[0]);
  const isStraight = checkStraight(vals);
  const groups = groupBy(vals);
  const counts = Object.values(groups).sort((a,b) => b-a);

  let rank, name, tiebreaker = vals;

  if (isFlush && isStraight) {
    rank = vals[0] === 14 ? 9 : 8;
    name = vals[0] === 14 ? 'Royal Flush' : 'Straight Flush';
  } else if (counts[0] === 4) {
    rank = 7; name = 'Póker';
    const quad = parseInt(keyOfCount(groups, 4));
    tiebreaker = [quad, ...vals.filter(v => v != quad)];
  } else if (counts[0] === 3 && counts[1] === 2) {
    rank = 6; name = 'Full House';
    const trip = parseInt(keyOfCount(groups, 3));
    const pair = parseInt(keyOfCount(groups, 2));
    tiebreaker = [trip, pair];
  } else if (isFlush) {
    rank = 5; name = 'Color';
  } else if (isStraight) {
    rank = 4; name = 'Escalera';
  } else if (counts[0] === 3) {
    rank = 3; name = 'Trío';
    const trip = parseInt(keyOfCount(groups, 3));
    tiebreaker = [trip, ...vals.filter(v => v != trip)];
  } else if (counts[0] === 2 && counts[1] === 2) {
    rank = 2; name = 'Doble Pareja';
    const pairs = Object.entries(groups).filter(([,v]) => v===2).map(([k]) => parseInt(k)).sort((a,b)=>b-a);
    const kicker = vals.find(v => !pairs.includes(v));
    tiebreaker = [...pairs, kicker];
  } else if (counts[0] === 2) {
    rank = 1; name = 'Pareja';
    const pair = parseInt(keyOfCount(groups, 2));
    tiebreaker = [pair, ...vals.filter(v => v != pair)];
  } else {
    rank = 0; name = 'Carta Alta';
  }

  const score = rank * 1e10 + tiebreaker.reduce((acc, v, i) => acc + v * Math.pow(100, 4-i), 0);
  return { rank, name, score, tiebreaker };
}

function checkStraight(sortedVals) {
  const uniq = [...new Set(sortedVals)];
  if (uniq.length < 5) return false;
  // Normal
  if (uniq[0] - uniq[4] === 4) return true;
  // As bajo: A-2-3-4-5
  if (uniq[0] === 14 && uniq[1] === 5 && uniq[2] === 4 && uniq[3] === 3 && uniq[4] === 2) return true;
  return false;
}

function groupBy(vals) {
  const g = {};
  for (const v of vals) g[v] = (g[v]||0) + 1;
  return g;
}
function keyOfCount(groups, count) {
  return Object.entries(groups).sort((a,b) => b[0]-a[0]).find(([,v]) => v===count)?.[0];
}

// ── Estado de mesas ───────────────────────────────────────────
const tables = new Map();

const STREETS = ['preflop','flop','turn','river','showdown'];

function getOrCreateTable(level) {
  for (const [,t] of tables) {
    if (t.level === level && t.status === 'waiting' && t.players.length < MAX_PLAYERS) return t;
  }
  const id = `tpk_${level}_${Date.now()}`;
  const table = {
    id, level,
    entry: LEVELS[level].entry,
    pot: 0, commission: 0,
    players: [], // { id, username, socketId, holeCards, chips, status, bet, folded, allIn }
    community: [],
    deck: [],
    street: 'waiting',
    currentTurn: 0,
    dealerIdx: 0,
    status: 'waiting',
    startTimer: null, actionTimer: null,
    createdAt: Date.now(),
  };
  tables.set(id, table);
  return table;
}

function getTableById(id) { return tables.get(id); }

function getTablesInfo() {
  const r = { 500:[], 1000:[], 5000:[] };
  for (const t of tables.values()) {
    if (t.status !== 'finished') {
      r[t.level].push({ id:t.id, players:t.players.length, max:MAX_PLAYERS, min:MIN_PLAYERS, status:t.status });
    }
  }
  return r;
}

function startGame(table) {
  table.status = 'playing';
  table.deck = createDeck();
  table.community = [];
  table.street = 'preflop';
  table.pot = 0; table.commission = 0;

  const cfg = LEVELS[table.level];
  for (const p of table.players) {
    p.holeCards = [table.deck.pop(), table.deck.pop()];
    p.status = 'playing';
    p.folded = false;
    p.allIn = false;
    p.bet = cfg.pot;
    p.chips = 0;
    table.pot += cfg.pot;
    table.commission += cfg.commission;
  }

  // Primer turno: jugador después del dealer
  table.currentTurn = (table.dealerIdx + 1) % table.players.length;
  return table;
}

function dealFlop(table) {
  table.community.push(table.deck.pop(), table.deck.pop(), table.deck.pop());
  table.street = 'flop';
  table.currentTurn = (table.dealerIdx + 1) % table.players.length;
  skipFolded(table);
}
function dealTurn(table) {
  table.community.push(table.deck.pop());
  table.street = 'turn';
  table.currentTurn = (table.dealerIdx + 1) % table.players.length;
  skipFolded(table);
}
function dealRiver(table) {
  table.community.push(table.deck.pop());
  table.street = 'river';
  table.currentTurn = (table.dealerIdx + 1) % table.players.length;
  skipFolded(table);
}

function skipFolded(table) {
  while (table.players[table.currentTurn]?.folded) {
    table.currentTurn = (table.currentTurn + 1) % table.players.length;
  }
}

function fold(table, playerId) {
  const p = table.players[table.currentTurn];
  if (!p || p.id !== playerId) return { error: 'No es tu turno' };
  p.folded = true;
  p.status = 'folded';
  return { ok: true, next: advanceTurnPoker(table) };
}

function check(table, playerId) {
  const p = table.players[table.currentTurn];
  if (!p || p.id !== playerId) return { error: 'No es tu turno' };
  return { ok: true, next: advanceTurnPoker(table) };
}

function advanceTurnPoker(table) {
  const activePlayers = table.players.filter(p => !p.folded);
  if (activePlayers.length === 1) {
    table.status = 'finished';
    table.street = 'showdown';
    return { finished: true, result: calcWinnerPoker(table) };
  }

  let next = (table.currentTurn + 1) % table.players.length;
  let loops = 0;
  while (table.players[next]?.folded && loops < table.players.length) {
    next = (next + 1) % table.players.length;
    loops++;
  }

  // Si volvemos al primer jugador de la ronda, pasamos a la siguiente calle
  if (next === table.dealerIdx % table.players.length || loops >= table.players.length - 1) {
    return nextStreet(table);
  }

  table.currentTurn = next;
  return { finished: false, currentTurn: next, currentPlayer: table.players[next].username, street: table.street };
}

function nextStreet(table) {
  if (table.street === 'preflop') { dealFlop(table); return { finished:false, newStreet:'flop', community:table.community, currentTurn:table.currentTurn, currentPlayer:table.players[table.currentTurn]?.username }; }
  if (table.street === 'flop')   { dealTurn(table); return { finished:false, newStreet:'turn', community:table.community, currentTurn:table.currentTurn, currentPlayer:table.players[table.currentTurn]?.username }; }
  if (table.street === 'turn')   { dealRiver(table); return { finished:false, newStreet:'river', community:table.community, currentTurn:table.currentTurn, currentPlayer:table.players[table.currentTurn]?.username }; }
  if (table.street === 'river')  {
    table.status = 'finished';
    table.street = 'showdown';
    return { finished:true, result: calcWinnerPoker(table) };
  }
}

function calcWinnerPoker(table) {
  const active = table.players.filter(p => !p.folded);
  if (active.length === 1) {
    return { type:'fold', winners:[active[0]], prize: table.pot, allPlayers: table.players.map(p => ({ ...p, handName: p.folded ? 'Fold' : '' })) };
  }

  // Evaluar manos
  const evaluated = active.map(p => {
    const allCards = [...p.holeCards, ...table.community];
    const hand = evalHand(allCards);
    return { ...p, hand, handName: hand.name, handScore: hand.score };
  });

  const maxScore = Math.max(...evaluated.map(e => e.handScore));
  const winners = evaluated.filter(e => e.handScore === maxScore);
  const prize = Math.floor(table.pot / winners.length);

  return {
    type: winners.length > 1 ? 'draw' : 'win',
    winners: winners.map(w => ({ id:w.id, username:w.username, handName:w.handName, prize })),
    prize,
    allPlayers: table.players.map(p => {
      const ev = evaluated.find(e => e.id === p.id);
      return { id:p.id, username:p.username, holeCards:p.holeCards, folded:p.folded, handName: ev?.handName || (p.folded?'Fold':''), handScore: ev?.handScore || 0 };
    }),
    community: table.community
  };
}

function removeTable(id) { tables.delete(id); }

module.exports = { getOrCreateTable, getTableById, getTablesInfo, startGame, fold, check, removeTable, MIN_PLAYERS, MAX_PLAYERS, ACTION_TIMEOUT, LEVELS };
