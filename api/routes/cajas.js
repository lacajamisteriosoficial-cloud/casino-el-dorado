const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { query, getClient } = require('../config/db');
const path = require('path');
const fs = require('fs');

const HOUSE_CUT = 0.20;

// ── Estado en memoria (con persistencia en DB) ────────────────
const defaultConfig = {
    entryPrice: 500, extraPrice: 1000,
    minPlayers: 2, maxPlayers: 10,
    totalBoxes: 20, commissionPercent: 20,
    countdownTime: 3, alias: 'casino.eldorado.mp',
    closedMessage: 'Volvé pronto, el juego está pausado.',
    schedule: { enabled: false, openHour: 0, closeHour: 23 }
};

let gameState = {
    status: 'OPEN',
    players: [], boxes: {}, extraBoxes: {},
    jackpot: 0, roundFund: 0,
    countdownEnd: null, winner: null,
    winningBox: null, lastPrize: null,
    pendingTransfers: [], winnersHistory: [],
    config: { ...defaultConfig }
};

let timers = {};
let viewerConnections = [];
let adminViewerStreams = [];
let chatSessions = {};
let chatAdminStreams = [];
let chatPlayerStreams = {};

// Cargar estado desde DB al inicio
async function loadStateFromDB() {
    try {
        const result = await query('SELECT state_json, config_json FROM cajas_state ORDER BY id DESC LIMIT 1');
        if (result.rows.length > 0) {
            const saved = result.rows[0];
            const s = saved.state_json;
            const c = saved.config_json;
            gameState.jackpot = s.jackpot || 0;
            gameState.winnersHistory = s.winnersHistory || [];
            gameState.players = s.players || [];
            gameState.boxes = s.boxes || {};
            gameState.extraBoxes = s.extraBoxes || {};
            gameState.pendingTransfers = s.pendingTransfers || [];
            gameState.roundFund = s.roundFund || 0;
            gameState.status = s.status === 'OPEN' ? 'OPEN' : 'OPEN';
            if (c) gameState.config = { ...defaultConfig, ...c };
            console.log('✅ Estado Caja Misteriosa cargado desde DB');
        }
    } catch (e) {
        console.error('Error cargando estado cajas:', e.message);
    }
}

async function saveStateToDB() {
    try {
        const stateJson = {
            jackpot: gameState.jackpot,
            winnersHistory: gameState.winnersHistory,
            players: gameState.players,
            boxes: gameState.boxes,
            extraBoxes: gameState.extraBoxes,
            pendingTransfers: gameState.pendingTransfers,
            roundFund: gameState.roundFund,
            status: gameState.status
        };
        await query(
            `INSERT INTO cajas_state (state_json, config_json, updated_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (id) DO UPDATE SET state_json = $1, config_json = $2, updated_at = NOW()`,
            [JSON.stringify(stateJson), JSON.stringify(gameState.config)]
        );
    } catch (e) {
        console.error('Error guardando estado cajas:', e.message);
    }
}

// Cargar al iniciar
loadStateFromDB();

function isWithinSchedule() {
    if (!gameState.config.schedule?.enabled) return true;
    const hour = new Date().getHours();
    return hour >= gameState.config.schedule.openHour && hour < gameState.config.schedule.closeHour;
}

const BANNED_WORDS = [
    'puto','puta','hijo de puta','hdp','concha','pelotudo','boludo',
    'idiota','imbecil','estupido','mierda','forro','joder','coño',
    'fuck','shit','ass','bitch','bastard','dick','cunt'
];
function containsBannedWord(text) {
    const lower = text.toLowerCase().replace(/[^a-záéíóúüña-z0-9\s]/gi, '');
    return BANNED_WORDS.some(w => lower.includes(w));
}

// ── SSE: Viewers ──────────────────────────────────────────────
function broadcastViewerCount() {
    const count = viewerConnections.length;
    const payload = `data: ${JSON.stringify({ viewers: count })}\n\n`;
    [...adminViewerStreams, ...viewerConnections].forEach(r => { try { r.write(payload); } catch(e) {} });
}

router.get('/viewers/connect', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    viewerConnections.push(res);
    broadcastViewerCount();
    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch(e) {} }, 25000);
    req.on('close', () => {
        clearInterval(hb);
        viewerConnections = viewerConnections.filter(c => c !== res);
        broadcastViewerCount();
    });
});

router.get('/viewers/admin-stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ viewers: viewerConnections.length })}\n\n`);
    adminViewerStreams.push(res);
    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch(e) {} }, 25000);
    req.on('close', () => {
        clearInterval(hb);
        adminViewerStreams = adminViewerStreams.filter(c => c !== res);
    });
});

// ── Estado público ────────────────────────────────────────────
router.get('/state', (req, res) => {
    res.json({
        status: gameState.status,
        players: gameState.players,
        boxes: gameState.boxes,
        extraBoxes: gameState.extraBoxes,
        jackpot: gameState.jackpot,
        roundFund: gameState.roundFund,
        countdownEnd: gameState.countdownEnd,
        winner: gameState.winner,
        winningBox: gameState.winningBox,
        prize: gameState.lastPrize,
        config: gameState.config,
        pendingTransfers: gameState.pendingTransfers,
        inSchedule: isWithinSchedule(),
        winnersHistory: gameState.winnersHistory
    });
});

router.get('/winners-history', (req, res) => {
    res.json({ winnersHistory: gameState.winnersHistory });
});

// ── Inscripción ───────────────────────────────────────────────
router.post('/request-entry', requireAuth, async (req, res) => {
    const { name, operationId, boxNumber, mpAlias } = req.body;
    if (!isWithinSchedule()) return res.status(400).json({ error: 'Fuera de horario de juego' });
    if (gameState.status !== 'OPEN') return res.status(400).json({ error: 'La sala está cerrada' });
    if (gameState.players.length >= gameState.config.maxPlayers) return res.status(400).json({ error: 'Sala completa' });
    if (gameState.boxes[boxNumber] || gameState.extraBoxes[boxNumber]) return res.status(400).json({ error: 'Caja ocupada' });

    const player = {
        id: req.user.id, name: name || req.user.username,
        mpAlias: mpAlias || req.user.mpAlias || '',
        box: null, extraBox: null,
        hasExtra: false, approved: false,
        selectedBox: boxNumber
    };
    const transfer = {
        id: Date.now().toString(), playerId: player.id,
        name: player.name, mpAlias: player.mpAlias, operationId,
        amount: gameState.config.entryPrice, type: 'entry',
        boxNumber, timestamp: new Date().toISOString(), approved: false
    };
    gameState.players.push(player);
    gameState.pendingTransfers.push(transfer);
    await saveStateToDB();
    res.json({ player, transfer });
});

router.post('/request-extra', requireAuth, async (req, res) => {
    const { operationId } = req.body;
    const player = gameState.players.find(p => p.id === req.user.id);
    if (!player || player.hasExtra) return res.status(400).json({ error: 'No permitido' });
    const transfer = {
        id: Date.now().toString(), playerId: req.user.id,
        name: player.name, mpAlias: player.mpAlias, operationId,
        amount: gameState.config.extraPrice, type: 'extra',
        timestamp: new Date().toISOString(), approved: false
    };
    gameState.pendingTransfers.push(transfer);
    res.json({ transfer });
});

router.post('/confirm-box', requireAuth, async (req, res) => {
    const { boxNumber } = req.body;
    const player = gameState.players.find(p => p.id === req.user.id);
    if (!player || !player.approved) return res.status(400).json({ error: 'No autorizado' });
    if (gameState.boxes[boxNumber]) return res.status(400).json({ error: 'Caja ocupada' });
    gameState.boxes[boxNumber] = req.user.id;
    player.box = boxNumber;
    await saveStateToDB();
    checkAllSelected();
    res.json({ success: true });
});

router.post('/select-extra-box', requireAuth, async (req, res) => {
    const { boxNumber } = req.body;
    const player = gameState.players.find(p => p.id === req.user.id);
    if (!player || !player.hasExtra || player.extraBox) return res.status(400).json({ error: 'No permitido' });
    if (gameState.boxes[boxNumber] || gameState.extraBoxes[boxNumber]) return res.status(400).json({ error: 'Caja ocupada' });
    gameState.extraBoxes[boxNumber] = req.user.id;
    player.extraBox = boxNumber;
    res.json({ success: true });
});

// ── Admin: aprobar/rechazar ───────────────────────────────────
router.post('/approve-transfer', async (req, res) => {
    const { transferId } = req.body;
    const transfer = gameState.pendingTransfers.find(t => t.id === transferId);
    if (!transfer) return res.status(404).json({ error: 'No encontrada' });
    transfer.approved = true;
    const player = gameState.players.find(p => p.id === transfer.playerId);
    if (transfer.type === 'entry') {
        player.approved = true;
        gameState.roundFund += gameState.config.entryPrice;
    } else {
        player.hasExtra = true;
        gameState.roundFund += gameState.config.extraPrice;
    }
    await saveStateToDB();
    res.json({ success: true, player });
});

router.post('/reject-transfer', async (req, res) => {
    const { transferId } = req.body;
    const transfer = gameState.pendingTransfers.find(t => t.id === transferId);
    if (transfer) {
        const player = gameState.players.find(p => p.id === transfer.playerId);
        if (player && !player.approved) {
            gameState.players = gameState.players.filter(p => p.id !== player.id);
        }
    }
    gameState.pendingTransfers = gameState.pendingTransfers.filter(t => t.id !== transferId);
    await saveStateToDB();
    res.json({ success: true });
});

router.post('/config', async (req, res) => {
    const incoming = req.body;
    if (incoming.schedule && typeof incoming.schedule === 'object') {
        gameState.config.schedule = { ...gameState.config.schedule, ...incoming.schedule };
        delete incoming.schedule;
    }
    gameState.config = { ...gameState.config, ...incoming };
    await saveStateToDB();
    const within = isWithinSchedule();
    if (!within && gameState.status === 'OPEN') {
        if (timers.countdown) clearInterval(timers.countdown);
        if (timers.autoReset) clearTimeout(timers.autoReset);
        gameState.status = 'CLOSED';
    } else if (within && gameState.status === 'CLOSED' && gameState.config.schedule?.enabled) {
        resetRound(false);
    }
    res.json({ config: gameState.config });
});

router.post('/force-start', async (req, res) => {
    if (gameState.status === 'OPEN') {
        startCountdown();
        res.json({ success: true });
    } else {
        res.status(400).json({ error: 'No se puede forzar inicio' });
    }
});

router.post('/reset', async (req, res) => {
    resetRound(true);
    res.json({ success: true });
});

router.post('/mark-transferred', async (req, res) => {
    const { roundId } = req.body;
    const entry = gameState.winnersHistory.find(w => w.roundId === roundId);
    if (!entry) return res.status(404).json({ error: 'No encontrado' });
    entry.transferred = true;
    await query('UPDATE cajas_winners SET transferred = true WHERE round_id = $1', [roundId]);
    res.json({ success: true });
});

router.get('/players-needed', (req, res) => {
    const approved = gameState.players.filter(p => p.approved && p.box).length;
    res.json({ needed: Math.max(0, gameState.config.minPlayers - approved), current: approved, min: gameState.config.minPlayers });
});

// ── Game logic ────────────────────────────────────────────────
function resetRound(clearJackpot = false) {
    gameState.status = isWithinSchedule() ? 'OPEN' : 'CLOSED';
    gameState.players = []; gameState.boxes = {}; gameState.extraBoxes = {};
    gameState.roundFund = 0; gameState.countdownEnd = null;
    gameState.winner = null; gameState.winningBox = null;
    gameState.lastPrize = null; gameState.pendingTransfers = [];
    if (clearJackpot) gameState.jackpot = 0;
    if (timers.countdown) clearInterval(timers.countdown);
    if (timers.autoReset) clearTimeout(timers.autoReset);
    saveStateToDB();
}

function checkAllSelected() {
    const approved = gameState.players.filter(p => p.approved);
    const withBox = approved.filter(p => p.box);
    if (withBox.length >= gameState.config.minPlayers && gameState.status === 'OPEN' && withBox.length === approved.length) {
        startCountdown();
    }
}

function startCountdown() {
    gameState.status = 'COUNTDOWN';
    gameState.countdownEnd = Date.now() + (gameState.config.countdownTime * 1000);
    timers.countdown = setInterval(() => {
        if (gameState.countdownEnd - Date.now() <= 0) {
            clearInterval(timers.countdown);
            closeRound();
        }
    }, 100);
}

function closeRound() {
    gameState.status = 'CLOSED';
    setTimeout(() => drawWinner(), 500);
}

async function drawWinner() {
    const winningBox = Math.floor(Math.random() * gameState.config.totalBoxes) + 1;
    gameState.winningBox = winningBox;
    const winnerId = gameState.boxes[winningBox] || gameState.extraBoxes[winningBox];

    if (winnerId) {
        const commission = gameState.roundFund * (gameState.config.commissionPercent / 100);
        const prize = (gameState.roundFund - commission) + gameState.jackpot;
        gameState.winner = gameState.players.find(p => p.id === winnerId);
        if (gameState.winner) gameState.winner.prize = prize;
        gameState.lastPrize = prize;
        const roundId = Date.now().toString();

        const historyEntry = {
            roundId, timestamp: new Date().toISOString(),
            name: gameState.winner?.name || '?',
            mpAlias: gameState.winner?.mpAlias || '—',
            prize, winningBox, transferred: false
        };
        gameState.winnersHistory.unshift(historyEntry);
        gameState.jackpot = 0;

        // Persistir en DB
        try {
            await query(
                `INSERT INTO cajas_winners (round_id, user_id, name, mp_alias, prize, winning_box)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [roundId, winnerId, historyEntry.name, historyEntry.mpAlias, prize, winningBox]
            );
        } catch (e) { console.error('Error saving winner:', e.message); }
    } else {
        const commission = gameState.roundFund * (gameState.config.commissionPercent / 100);
        gameState.jackpot += gameState.roundFund - commission;
        gameState.lastPrize = null;
        gameState.winner = null;
    }

    gameState.status = 'FINISHED';
    await saveStateToDB();
    timers.autoReset = setTimeout(() => resetRound(false), 12000);
}

// ── Chat ──────────────────────────────────────────────────────
function broadcastChatUpdate() {
    const payload = `data: ${JSON.stringify({ sessions: Object.values(chatSessions) })}\n\n`;
    chatAdminStreams.forEach(r => { try { r.write(payload); } catch(e) {} });
}

router.get('/chat/admin-stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ sessions: Object.values(chatSessions) })}\n\n`);
    chatAdminStreams.push(res);
    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch(e) {} }, 25000);
    req.on('close', () => { clearInterval(hb); chatAdminStreams = chatAdminStreams.filter(r2 => r2 !== res); });
});

router.get('/chat/player-stream/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    chatPlayerStreams[sessionId] = res;
    if (chatSessions[sessionId]) res.write(`data: ${JSON.stringify(chatSessions[sessionId])}\n\n`);
    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch(e) {} }, 25000);
    req.on('close', () => { clearInterval(hb); delete chatPlayerStreams[sessionId]; });
});

router.post('/chat/init', (req, res) => {
    const { sessionId, name } = req.body;
    if (!sessionId || !name) return res.status(400).json({ error: 'Faltan datos' });
    if (!chatSessions[sessionId]) {
        chatSessions[sessionId] = { sessionId, name, messages: [], open: true, waitingReply: false, lastMsg: null };
    }
    res.json(chatSessions[sessionId]);
});

router.post('/chat/send', (req, res) => {
    const { sessionId, text } = req.body;
    const session = chatSessions[sessionId];
    if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });
    if (!session.open) return res.status(400).json({ error: 'Conversación cerrada por el admin' });
    if (session.waitingReply) return res.status(400).json({ error: 'Esperá la respuesta del operador' });
    if (!text?.trim() || text.length > 300) return res.status(400).json({ error: 'Mensaje inválido' });
    if (containsBannedWord(text)) return res.status(400).json({ error: 'Mensaje con palabras no permitidas' });
    const msg = { from: 'player', text: text.trim(), ts: new Date().toISOString() };
    session.messages.push(msg);
    session.waitingReply = true; session.lastMsg = msg.ts;
    if (chatPlayerStreams[sessionId]) { try { chatPlayerStreams[sessionId].write(`data: ${JSON.stringify(session)}\n\n`); } catch(e) {} }
    broadcastChatUpdate();
    res.json({ success: true });
});

router.post('/chat/reply', (req, res) => {
    const { sessionId, text } = req.body;
    const session = chatSessions[sessionId];
    if (!session || !text?.trim()) return res.status(400).json({ error: 'Datos inválidos' });
    const msg = { from: 'admin', text: text.trim(), ts: new Date().toISOString() };
    session.messages.push(msg);
    session.waitingReply = false;
    if (chatPlayerStreams[sessionId]) { try { chatPlayerStreams[sessionId].write(`data: ${JSON.stringify(session)}\n\n`); } catch(e) {} }
    broadcastChatUpdate();
    res.json({ success: true });
});

router.post('/chat/close', (req, res) => {
    const { sessionId } = req.body;
    const session = chatSessions[sessionId];
    if (!session) return res.status(404).json({ error: 'No encontrada' });
    session.open = false;
    if (chatPlayerStreams[sessionId]) { try { chatPlayerStreams[sessionId].write(`data: ${JSON.stringify(session)}\n\n`); } catch(e) {} }
    broadcastChatUpdate();
    res.json({ success: true });
});

router.post('/chat/reopen', (req, res) => {
    const { sessionId } = req.body;
    const session = chatSessions[sessionId];
    if (!session) return res.status(404).json({ error: 'No encontrada' });
    session.open = true; session.waitingReply = false;
    if (chatPlayerStreams[sessionId]) { try { chatPlayerStreams[sessionId].write(`data: ${JSON.stringify(session)}\n\n`); } catch(e) {} }
    broadcastChatUpdate();
    res.json({ success: true });
});

router.post('/chat/delete', (req, res) => {
    const { sessionId } = req.body;
    if (!chatSessions[sessionId]) return res.status(404).json({ error: 'No encontrada' });
    if (chatPlayerStreams[sessionId]) { try { chatPlayerStreams[sessionId].write(`data: ${JSON.stringify({ deleted: true })}\n\n`); } catch(e) {} }
    delete chatSessions[sessionId];
    broadcastChatUpdate();
    res.json({ success: true });
});

router.get('/chat/session/:sessionId', (req, res) => {
    const session = chatSessions[req.params.sessionId];
    if (!session) return res.status(404).json({ error: 'No encontrada' });
    res.json(session);
});

// Verificador de horario
setInterval(() => {
    const within = isWithinSchedule();
    if (!within && gameState.status === 'OPEN') {
        if (timers.countdown) clearInterval(timers.countdown);
        if (timers.autoReset) clearTimeout(timers.autoReset);
        gameState.status = 'CLOSED';
        saveStateToDB();
    } else if (within && gameState.status === 'CLOSED' && gameState.config.schedule?.enabled) {
        resetRound(false);
    }
}, 60 * 1000);

module.exports = router;
