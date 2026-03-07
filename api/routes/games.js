const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { gameLimiter } = require('../middleware/security');
const { query, getClient } = require('../config/db');

const HOUSE_CUT = 0.20; // 20%

// ── Helper: descontar apuesta y registrar ─────────────────────
async function placeBet(client, userId, amount, game) {
    const userRes = await client.query(
        'UPDATE users SET balance = balance - $1 WHERE id = $2 AND balance >= $1 RETURNING balance',
        [amount, userId]
    );
    if (userRes.rows.length === 0) throw new Error('Saldo insuficiente');
    const newBalance = parseFloat(userRes.rows[0].balance);
    await client.query(
        `INSERT INTO transactions (user_id, type, amount, balance_after, description, status, game)
         VALUES ($1, 'bet', $2, $3, $4, 'approved', $5)`,
        [userId, amount, newBalance, `Apuesta ${game}`, game]
    );
    return newBalance;
}

// ── Helper: acreditar premio ──────────────────────────────────
async function awardPrize(client, userId, grossAmount, game) {
    const commission = Math.round(grossAmount * HOUSE_CUT * 100) / 100;
    const prize = Math.round((grossAmount - commission) * 100) / 100;

    // Registrar comisión
    await client.query(
        `INSERT INTO transactions (user_id, type, amount, description, status, game)
         VALUES ($1, 'commission', $2, $3, 'approved', $4)`,
        [userId, commission, `Comisión casa ${game}`, game]
    );

    // Acreditar premio neto
    const userRes = await client.query(
        'UPDATE users SET balance = balance + $1 WHERE id = $2 RETURNING balance',
        [prize, userId]
    );
    const newBalance = parseFloat(userRes.rows[0].balance);
    await client.query(
        `INSERT INTO transactions (user_id, type, amount, balance_after, description, status, game)
         VALUES ($1, 'prize', $2, $3, $4, 'approved', $5)`,
        [userId, prize, newBalance, `Premio ${game}`, game]
    );

    return { prize, commission, newBalance };
}

// ══════════════════════════════════════════════════════════════
// BLACKJACK
// ══════════════════════════════════════════════════════════════
function makeDeck() {
    const suits = ['♠','♥','♦','♣'];
    const ranks = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
    const deck = [];
    for (const s of suits) for (const r of ranks) deck.push({ r, s });
    // Fisher-Yates shuffle
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function bjValue(cards) {
    let total = 0, aces = 0;
    for (const c of cards) {
        if (c.r === 'A') { aces++; total += 11; }
        else if (['J','Q','K'].includes(c.r)) total += 10;
        else total += parseInt(c.r);
    }
    while (total > 21 && aces > 0) { total -= 10; aces--; }
    return total;
}

// Guardar sesiones BJ en memoria (no necesitan persistencia)
const bjSessions = new Map();

router.post('/blackjack/deal', requireAuth, gameLimiter, async (req, res) => {
    const { bet } = req.body;
    const amount = parseFloat(bet);
    if (!amount || amount < 5 || amount > 10000) {
        return res.status(400).json({ error: 'Apuesta inválida (mín $5, máx $10.000)' });
    }

    const client = await getClient();
    try {
        await client.query('BEGIN');
        await placeBet(client, req.user.id, amount, 'blackjack');
        await client.query('COMMIT');

        const deck = makeDeck();
        const playerCards = [deck.pop(), deck.pop()];
        const dealerCards = [deck.pop(), deck.pop()];
        const sessionId = `bj_${req.user.id}_${Date.now()}`;

        bjSessions.set(sessionId, { deck, playerCards, dealerCards, bet: amount, userId: req.user.id, doubled: false });
        setTimeout(() => bjSessions.delete(sessionId), 5 * 60 * 1000); // expire in 5min

        const playerVal = bjValue(playerCards);
        const isBlackjack = playerVal === 21;

        res.json({
            sessionId,
            playerCards,
            dealerCard: dealerCards[0],
            playerValue: playerVal,
            blackjack: isBlackjack
        });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: err.message || 'Error al iniciar juego' });
    } finally {
        client.release();
    }
});

router.post('/blackjack/hit', requireAuth, gameLimiter, async (req, res) => {
    const { sessionId } = req.body;
    const session = bjSessions.get(sessionId);
    if (!session || session.userId !== req.user.id) {
        return res.status(400).json({ error: 'Sesión inválida' });
    }

    session.playerCards.push(session.deck.pop());
    const val = bjValue(session.playerCards);

    res.json({ playerCards: session.playerCards, playerValue: val, bust: val > 21 });
});

router.post('/blackjack/stand', requireAuth, gameLimiter, async (req, res) => {
    const { sessionId } = req.body;
    const session = bjSessions.get(sessionId);
    if (!session || session.userId !== req.user.id) {
        return res.status(400).json({ error: 'Sesión inválida' });
    }
    await resolveBJ(session, req.user.id, res);
    bjSessions.delete(sessionId);
});

router.post('/blackjack/double', requireAuth, gameLimiter, async (req, res) => {
    const { sessionId } = req.body;
    const session = bjSessions.get(sessionId);
    if (!session || session.userId !== req.user.id) {
        return res.status(400).json({ error: 'Sesión inválida' });
    }
    if (session.playerCards.length !== 2) {
        return res.status(400).json({ error: 'Solo podés doblar con 2 cartas' });
    }

    const client = await getClient();
    try {
        await client.query('BEGIN');
        await placeBet(client, req.user.id, session.bet, 'blackjack');
        await client.query('COMMIT');
        session.bet *= 2;
        session.doubled = true;
    } catch (err) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: err.message });
    } finally {
        client.release();
    }

    session.playerCards.push(session.deck.pop());
    await resolveBJ(session, req.user.id, res);
    bjSessions.delete(sessionId);
});

async function resolveBJ(session, userId, res) {
    while (bjValue(session.dealerCards) < 17) session.dealerCards.push(session.deck.pop());

    const pv = bjValue(session.playerCards);
    const dv = bjValue(session.dealerCards);
    const pot = session.bet * 2;

    let result, prize = 0, commission = 0, newBalance = 0;

    const client = await getClient();
    try {
        await client.query('BEGIN');
        if (pv > 21) {
            result = 'bust';
            // Casa se queda todo - registrar comisión
            await client.query(
                `INSERT INTO transactions (user_id, type, amount, description, status, game)
                 VALUES ($1, 'commission', $2, 'Comisión blackjack (bust)', 'approved', 'blackjack')`,
                [userId, session.bet]
            );
            const userRes = await client.query('SELECT balance FROM users WHERE id = $1', [userId]);
            newBalance = parseFloat(userRes.rows[0].balance);
        } else if (dv > 21 || pv > dv) {
            result = 'win';
            const awarded = await awardPrize(client, userId, pot, 'blackjack');
            prize = awarded.prize; commission = awarded.commission; newBalance = awarded.newBalance;
        } else if (pv === dv) {
            result = 'draw';
            // Devolver apuesta sin comisión
            const userRes = await client.query(
                'UPDATE users SET balance = balance + $1 WHERE id = $2 RETURNING balance',
                [session.bet, userId]
            );
            newBalance = parseFloat(userRes.rows[0].balance);
        } else {
            result = 'loss';
            await client.query(
                `INSERT INTO transactions (user_id, type, amount, description, status, game)
                 VALUES ($1, 'commission', $2, 'Comisión blackjack (loss)', 'approved', 'blackjack')`,
                [userId, session.bet]
            );
            const userRes = await client.query('SELECT balance FROM users WHERE id = $1', [userId]);
            newBalance = parseFloat(userRes.rows[0].balance);
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }

    res.json({
        result,
        playerCards: session.playerCards, playerValue: pv,
        dealerCards: session.dealerCards, dealerValue: dv,
        prize, commission, newBalance
    });
}

// ══════════════════════════════════════════════════════════════
// TRUCO (vs CPU)
// ══════════════════════════════════════════════════════════════
const TRUCO_VALUES = {
    '1♠':14,'1♣':13,'7♠':12,'7♥':11,
    '3':10,'2':9,'1':8,'12':7,'11':6,'10':5,'7':4,'6':3,'5':2,'4':1
};

function trucoCardVal(c) {
    return TRUCO_VALUES[c.r + c.s] || TRUCO_VALUES[c.r] || 0;
}

function makeSpanishDeck() {
    const suits = ['♠','♥','♦','♣'];
    const ranks = ['1','2','3','4','5','6','7','10','11','12'];
    const deck = [];
    for (const s of suits) for (const r of ranks) deck.push({ r, s });
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

const trucoSessions = new Map();

router.post('/truco/start', requireAuth, gameLimiter, async (req, res) => {
    const { bet } = req.body;
    const amount = parseFloat(bet);
    if (!amount || amount < 5 || amount > 10000) {
        return res.status(400).json({ error: 'Apuesta inválida' });
    }

    const client = await getClient();
    try {
        await client.query('BEGIN');
        await placeBet(client, req.user.id, amount, 'truco');
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: err.message });
    } finally {
        client.release();
    }

    const deck = makeSpanishDeck();
    const playerHand = [deck.pop(), deck.pop(), deck.pop()];
    const cpuHand    = [deck.pop(), deck.pop(), deck.pop()];
    const sessionId  = `truco_${req.user.id}_${Date.now()}`;

    trucoSessions.set(sessionId, {
        playerHand, cpuHand, bet: amount, userId: req.user.id,
        playerPts: 0, cpuPts: 0, round: 0,
        playerPlayed: [], cpuPlayed: [], trucoCalled: false
    });
    setTimeout(() => trucoSessions.delete(sessionId), 10 * 60 * 1000);

    res.json({ sessionId, playerHand });
});

router.post('/truco/play-card', requireAuth, gameLimiter, async (req, res) => {
    const { sessionId, cardIndex } = req.body;
    const session = trucoSessions.get(sessionId);
    if (!session || session.userId !== req.user.id) {
        return res.status(400).json({ error: 'Sesión inválida' });
    }

    const playerCard = session.playerHand[cardIndex];
    if (!playerCard || session.playerPlayed.some(p => p.r === playerCard.r && p.s === playerCard.s)) {
        return res.status(400).json({ error: 'Carta inválida o ya jugada' });
    }

    // CPU elige carta aleatoria
    const available = session.cpuHand.filter(c => !session.cpuPlayed.some(p => p.r === c.r && p.s === c.s));
    const cpuCard = available[Math.floor(Math.random() * available.length)];

    session.playerPlayed.push(playerCard);
    session.cpuPlayed.push(cpuCard);

    const pv = trucoCardVal(playerCard);
    const cv = trucoCardVal(cpuCard);

    if (pv > cv) session.playerPts++;
    else if (cv > pv) session.cpuPts++;

    session.round++;

    const gameOver = session.playerPts >= 2 || session.cpuPts >= 2 || session.round === 3;
    let result = null, prize = 0, newBalance = 0;

    if (gameOver) {
        const pot = session.bet * 2 * (session.trucoCalled ? 1.5 : 1);
        const client = await getClient();
        try {
            await client.query('BEGIN');
            if (session.playerPts > session.cpuPts) {
                result = 'win';
                const awarded = await awardPrize(client, req.user.id, pot, 'truco');
                prize = awarded.prize; newBalance = awarded.newBalance;
            } else if (session.cpuPts > session.playerPts) {
                result = 'loss';
                await client.query(
                    `INSERT INTO transactions (user_id, type, amount, description, status, game)
                     VALUES ($1, 'commission', $2, 'Comisión truco (loss)', 'approved', 'truco')`,
                    [req.user.id, session.bet]
                );
                const userRes = await client.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
                newBalance = parseFloat(userRes.rows[0].balance);
            } else {
                result = 'draw';
                const userRes = await client.query(
                    'UPDATE users SET balance = balance + $1 WHERE id = $2 RETURNING balance',
                    [session.bet, req.user.id]
                );
                newBalance = parseFloat(userRes.rows[0].balance);
            }
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
        } finally {
            client.release();
        }
        trucoSessions.delete(sessionId);
    }

    res.json({
        playerCard, cpuCard,
        playerValue: pv, cpuValue: cv,
        playerPts: session.playerPts, cpuPts: session.cpuPts,
        round: session.round, gameOver, result, prize, newBalance
    });
});

router.post('/truco/fold', requireAuth, gameLimiter, async (req, res) => {
    const { sessionId } = req.body;
    const session = trucoSessions.get(sessionId);
    if (!session || session.userId !== req.user.id) {
        return res.status(400).json({ error: 'Sesión inválida' });
    }
    trucoSessions.delete(sessionId);
    const client = await getClient();
    try {
        await client.query('BEGIN');
        await client.query(
            `INSERT INTO transactions (user_id, type, amount, description, status, game)
             VALUES ($1, 'commission', $2, 'Truco: jugador se fue al mazo', 'approved', 'truco')`,
            [req.user.id, session.bet]
        );
        const userRes = await client.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
        await client.query('COMMIT');
        res.json({ result: 'fold', newBalance: parseFloat(userRes.rows[0].balance) });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'Error interno' });
    } finally {
        client.release();
    }
});

// ══════════════════════════════════════════════════════════════
// JACKPOT (slots)
// ══════════════════════════════════════════════════════════════
const SYMBOLS = ['🍋','🍒','⭐','🔔','7️⃣','💎','🃏','🍀'];

router.post('/jackpot/spin', requireAuth, gameLimiter, async (req, res) => {
    const { bet } = req.body;
    const amount = parseFloat(bet);
    if (!amount || amount < 5 || amount > 10000) {
        return res.status(400).json({ error: 'Apuesta inválida' });
    }

    // Simular N jugadores (1 a 5 CPUs)
    const numCPU = Math.floor(Math.random() * 5) + 1;
    const totalPot = amount * (numCPU + 1);

    const client = await getClient();
    try {
        await client.query('BEGIN');
        await placeBet(client, req.user.id, amount, 'jackpot');
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: err.message });
    } finally {
        client.release();
    }

    const winChance = 1 / (numCPU + 1);
    const won = Math.random() < winChance;

    let s1, s2, s3;
    if (won) {
        const sym = SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
        s1 = s2 = s3 = sym;
    } else {
        do {
            s1 = SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
            s2 = SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
            s3 = SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
        } while (s1 === s2 && s2 === s3);
    }

    let prize = 0, newBalance = 0;
    const client2 = await getClient();
    try {
        await client2.query('BEGIN');
        if (won) {
            const awarded = await awardPrize(client2, req.user.id, totalPot, 'jackpot');
            prize = awarded.prize; newBalance = awarded.newBalance;
        } else {
            await client2.query(
                `INSERT INTO transactions (user_id, type, amount, description, status, game)
                 VALUES ($1, 'commission', $2, 'Comisión jackpot (loss)', 'approved', 'jackpot')`,
                [req.user.id, amount]
            );
            const userRes = await client2.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
            newBalance = parseFloat(userRes.rows[0].balance);
        }
        await client2.query('COMMIT');
    } catch (err) {
        await client2.query('ROLLBACK');
    } finally {
        client2.release();
    }

    res.json({
        reels: [s1, s2, s3],
        won, prize, newBalance,
        pot: totalPot, numPlayers: numCPU + 1
    });
});

// ══════════════════════════════════════════════════════════════
// LUDO (vs CPU)
// ══════════════════════════════════════════════════════════════
const ludoSessions = new Map();

router.post('/ludo/start', requireAuth, gameLimiter, async (req, res) => {
    const { bet } = req.body;
    const amount = parseFloat(bet);
    if (!amount || amount < 5 || amount > 10000) {
        return res.status(400).json({ error: 'Apuesta inválida' });
    }

    const client = await getClient();
    try {
        await client.query('BEGIN');
        await placeBet(client, req.user.id, amount, 'ludo');
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: err.message });
    } finally {
        client.release();
    }

    const numCPU = 2;
    const sessionId = `ludo_${req.user.id}_${Date.now()}`;
    ludoSessions.set(sessionId, {
        userId: req.user.id, bet: amount,
        positions: { player: 0, cpu1: 0, cpu2: 0 },
        turn: 'player', finished: null,
        numCPU, totalPot: amount * (numCPU + 1)
    });
    setTimeout(() => ludoSessions.delete(sessionId), 30 * 60 * 1000);

    res.json({ sessionId, numCPU, pot: amount * (numCPU + 1) });
});

router.post('/ludo/roll', requireAuth, gameLimiter, async (req, res) => {
    const { sessionId } = req.body;
    const session = ludoSessions.get(sessionId);
    if (!session || session.userId !== req.user.id || session.finished) {
        return res.status(400).json({ error: 'Sesión inválida o juego terminado' });
    }
    if (session.turn !== 'player') {
        return res.status(400).json({ error: 'No es tu turno' });
    }

    const dice = Math.ceil(Math.random() * 6);
    session.positions.player = Math.min(57, session.positions.player + dice);

    if (session.positions.player >= 57) {
        return await finalizeLudo(session, 'player', req.user.id, res);
    }

    // CPUs juegan automáticamente
    const cpuResults = [];
    for (const cpu of ['cpu1', 'cpu2']) {
        const cpuDice = Math.ceil(Math.random() * 6);
        session.positions[cpu] = Math.min(57, session.positions[cpu] + cpuDice);
        cpuResults.push({ name: cpu, dice: cpuDice, pos: session.positions[cpu] });
        if (session.positions[cpu] >= 57) {
            return await finalizeLudo(session, cpu, req.user.id, res, { playerDice: dice, cpuResults });
        }
    }

    res.json({
        playerDice: dice,
        positions: session.positions,
        cpuResults,
        finished: false
    });
});

async function finalizeLudo(session, winner, userId, res, extra = {}) {
    ludoSessions.delete(`ludo_${userId}_${Date.now()}`);
    const pot = session.totalPot;
    let prize = 0, newBalance = 0;

    const client = await getClient();
    try {
        await client.query('BEGIN');
        if (winner === 'player') {
            const awarded = await awardPrize(client, userId, pot, 'ludo');
            prize = awarded.prize; newBalance = awarded.newBalance;
        } else {
            await client.query(
                `INSERT INTO transactions (user_id, type, amount, description, status, game)
                 VALUES ($1, 'commission', $2, 'Comisión ludo (loss)', 'approved', 'ludo')`,
                [userId, session.bet]
            );
            const userRes = await client.query('SELECT balance FROM users WHERE id = $1', [userId]);
            newBalance = parseFloat(userRes.rows[0].balance);
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
    } finally {
        client.release();
    }

    res.json({
        ...extra,
        positions: session.positions,
        finished: true,
        winner,
        prize, newBalance
    });
}

module.exports = router;
