const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const { query } = require('../config/db');

// Todas las rutas de admin requieren token admin
router.use(requireAdmin);

// ── Dashboard: stats globales ─────────────────────────────────
router.get('/stats', async (req, res) => {
    try {
        const [users, revenue, sessions, activeUsers, pendingDeposits] = await Promise.all([
            query('SELECT COUNT(*) as total FROM users WHERE role = $1', ['player']),
            query(`SELECT COALESCE(SUM(amount),0) as total FROM transactions
                   WHERE type = 'commission' AND status = 'approved'`),
            query(`SELECT COUNT(*) as total FROM game_sessions WHERE status = 'finished'`),
            query(`SELECT COUNT(*) as total FROM users WHERE last_login > NOW() - INTERVAL '24 hours'`),
            query(`SELECT COALESCE(SUM(amount),0) as total FROM transactions
                   WHERE type = 'deposit' AND status = 'pending'`)
        ]);

        // Revenue por juego
        const byGame = await query(`
            SELECT game, COALESCE(SUM(commission),0) as revenue, COUNT(*) as sessions
            FROM game_sessions
            WHERE status = 'finished' AND game IS NOT NULL
            GROUP BY game
            ORDER BY revenue DESC
        `);

        // Últimas transacciones
        const lastTx = await query(`
            SELECT t.id, t.type, t.amount, t.status, t.game, t.created_at,
                   u.username
            FROM transactions t
            LEFT JOIN users u ON t.user_id = u.id
            ORDER BY t.created_at DESC
            LIMIT 20
        `);

        res.json({
            totalUsers: parseInt(users.rows[0].total),
            totalRevenue: parseFloat(revenue.rows[0].total),
            totalSessions: parseInt(sessions.rows[0].total),
            activeUsers24h: parseInt(activeUsers.rows[0].total),
            pendingDeposits: parseFloat(pendingDeposits.rows[0].total),
            revenueByGame: byGame.rows,
            lastTransactions: lastTx.rows
        });
    } catch (err) {
        console.error('Admin stats error:', err);
        res.status(500).json({ error: 'Error al obtener estadísticas' });
    }
});

// ── Listar usuarios ───────────────────────────────────────────
router.get('/users', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = 20;
    const offset = (page - 1) * limit;
    const search = req.query.search || '';

    try {
        const countRes = await query(
            `SELECT COUNT(*) FROM users WHERE role = 'player' AND (username ILIKE $1 OR email ILIKE $1)`,
            [`%${search}%`]
        );
        const usersRes = await query(
            `SELECT id, username, email, balance, mp_alias, is_active, created_at, last_login
             FROM users
             WHERE role = 'player' AND (username ILIKE $1 OR email ILIKE $1)
             ORDER BY created_at DESC
             LIMIT $2 OFFSET $3`,
            [`%${search}%`, limit, offset]
        );

        res.json({
            users: usersRes.rows,
            total: parseInt(countRes.rows[0].count),
            page,
            pages: Math.ceil(parseInt(countRes.rows[0].count) / limit)
        });
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener usuarios' });
    }
});

// ── Ver/editar usuario ────────────────────────────────────────
router.get('/users/:id', async (req, res) => {
    try {
        const [userRes, txRes] = await Promise.all([
            query('SELECT id, username, email, balance, mp_alias, is_active, created_at, last_login FROM users WHERE id = $1', [req.params.id]),
            query(`SELECT type, amount, balance_after, description, status, game, created_at
                   FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30`, [req.params.id])
        ]);
        if (userRes.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
        res.json({ user: userRes.rows[0], transactions: txRes.rows });
    } catch (err) {
        res.status(500).json({ error: 'Error interno' });
    }
});

router.patch('/users/:id', async (req, res) => {
    const { balance, isActive, mpAlias } = req.body;
    try {
        const fields = [];
        const values = [];
        let idx = 1;
        if (balance !== undefined) { fields.push(`balance = $${idx++}`); values.push(balance); }
        if (isActive !== undefined) { fields.push(`is_active = $${idx++}`); values.push(isActive); }
        if (mpAlias !== undefined) { fields.push(`mp_alias = $${idx++}`); values.push(mpAlias); }
        if (fields.length === 0) return res.status(400).json({ error: 'Nada que actualizar' });
        values.push(req.params.id);
        await query(`UPDATE users SET ${fields.join(', ')} WHERE id = $${idx}`, values);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Error al actualizar usuario' });
    }
});

// ── Ajuste manual de saldo ─────────────────────────────────────
router.post('/users/:id/adjust-balance', async (req, res) => {
    const { amount, reason } = req.body;
    if (!amount || !reason) return res.status(400).json({ error: 'Monto y motivo requeridos' });

    const client = await require('../config/db').getClient();
    try {
        await client.query('BEGIN');
        const userRes = await client.query(
            'UPDATE users SET balance = balance + $1 WHERE id = $2 RETURNING balance',
            [amount, req.params.id]
        );
        const newBalance = parseFloat(userRes.rows[0].balance);
        await client.query(
            `INSERT INTO transactions (user_id, type, amount, balance_after, description, status)
             VALUES ($1, $2, $3, $4, $5, 'approved')`,
            [req.params.id, amount > 0 ? 'deposit' : 'refund', Math.abs(amount), newBalance, `Ajuste manual: ${reason}`]
        );
        await client.query('COMMIT');
        res.json({ success: true, newBalance });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'Error al ajustar saldo' });
    } finally {
        client.release();
    }
});

// ── Deposits pendientes ───────────────────────────────────────
router.get('/deposits/pending', async (req, res) => {
    try {
        const result = await query(`
            SELECT t.id, t.amount, t.description, t.mp_operation, t.created_at,
                   u.username, u.email, u.mp_alias
            FROM transactions t
            JOIN users u ON t.user_id = u.id
            WHERE t.type = 'deposit' AND t.status = 'pending'
            ORDER BY t.created_at ASC
        `);
        res.json({ deposits: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener depósitos' });
    }
});

// ── Aprobar/rechazar depósito manual ──────────────────────────
router.post('/deposits/:id/approve', async (req, res) => {
    const client = await require('../config/db').getClient();
    try {
        await client.query('BEGIN');
        const txRes = await client.query(
            "SELECT * FROM transactions WHERE id = $1 AND status = 'pending'",
            [req.params.id]
        );
        if (txRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Transacción no encontrada o ya procesada' });
        }
        const tx = txRes.rows[0];
        const userRes = await client.query(
            'UPDATE users SET balance = balance + $1 WHERE id = $2 RETURNING balance',
            [tx.amount, tx.user_id]
        );
        await client.query(
            "UPDATE transactions SET status = 'approved', balance_after = $1 WHERE id = $2",
            [parseFloat(userRes.rows[0].balance), req.params.id]
        );
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'Error al aprobar depósito' });
    } finally {
        client.release();
    }
});

router.post('/deposits/:id/reject', async (req, res) => {
    try {
        await query("UPDATE transactions SET status = 'rejected' WHERE id = $1 AND status = 'pending'", [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Error al rechazar depósito' });
    }
});

// ── Config casino ─────────────────────────────────────────────
router.get('/config', async (req, res) => {
    try {
        const result = await query('SELECT key, value FROM casino_config');
        const config = {};
        result.rows.forEach(r => { config[r.key] = r.value; });
        res.json({ config });
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener config' });
    }
});

router.post('/config', async (req, res) => {
    const { key, value } = req.body;
    if (!key || value === undefined) return res.status(400).json({ error: 'key y value requeridos' });
    try {
        await query(
            `INSERT INTO casino_config (key, value, updated_at) VALUES ($1, $2, NOW())
             ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
            [key, value.toString()]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Error al guardar config' });
    }
});

// ── Historial de juegos ───────────────────────────────────────
router.get('/games/history', async (req, res) => {
    const game = req.query.game || null;
    try {
        const result = await query(
            `SELECT gs.id, gs.game, gs.status, gs.pot, gs.commission, gs.prize,
                    gs.started_at, gs.finished_at,
                    u.username as winner_username
             FROM game_sessions gs
             LEFT JOIN users u ON gs.winner_id = u.id
             WHERE ($1::text IS NULL OR gs.game = $1)
             ORDER BY gs.started_at DESC
             LIMIT 50`,
            [game]
        );
        res.json({ sessions: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener historial de juegos' });
    }
});

// ── Ganadores Caja Misteriosa ─────────────────────────────────
router.get('/cajas/winners', async (req, res) => {
    try {
        const result = await query(
            'SELECT * FROM cajas_winners ORDER BY created_at DESC LIMIT 50'
        );
        res.json({ winners: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener ganadores' });
    }
});

router.post('/cajas/winners/:roundId/transfer', async (req, res) => {
    try {
        await query(
            'UPDATE cajas_winners SET transferred = true WHERE round_id = $1',
            [req.params.roundId]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Error al marcar transferencia' });
    }
});

// ── Crear usuarios de testing ─────────────────────────────────
router.post('/test/create-bots', async (req, res) => {
    const bcrypt = require('bcrypt');
    const bots = [
        { username: 'Bot_Alpha',   email: 'bot_alpha@test.casino',   balance: 50000 },
        { username: 'Bot_Beta',    email: 'bot_beta@test.casino',    balance: 50000 },
        { username: 'Bot_Gamma',   email: 'bot_gamma@test.casino',   balance: 50000 },
        { username: 'Bot_Delta',   email: 'bot_delta@test.casino',   balance: 50000 },
        { username: 'Bot_Epsilon', email: 'bot_epsilon@test.casino', balance: 50000 },
        { username: 'Bot_Zeta',    email: 'bot_zeta@test.casino',    balance: 50000 },
    ];
    const hash = await bcrypt.hash('BotTest123', 10);
    const created = [];
    for (const bot of bots) {
        try {
            const ex = await query('SELECT id FROM users WHERE username=$1', [bot.username]);
            if (ex.rows.length) {
                // Solo resetear balance
                await query('UPDATE users SET balance=$1 WHERE username=$2', [bot.balance, bot.username]);
                created.push({ username: bot.username, action: 'balance_reset' });
            } else {
                const r = await query(
                    `INSERT INTO users (username, email, password_hash, balance, is_active)
                     VALUES ($1,$2,$3,$4,true) RETURNING id, username`,
                    [bot.username, bot.email, hash, bot.balance]
                );
                created.push({ username: bot.username, action: 'created', id: r.rows[0].id });
            }
        } catch(e) {
            created.push({ username: bot.username, action: 'error', error: e.message });
        }
    }
    res.json({ success: true, bots: created, password: 'BotTest123' });
});

// Resetear balance de bots
router.post('/test/reset-bots', async (req, res) => {
    try {
        await query(`UPDATE users SET balance=50000 WHERE username LIKE 'Bot_%'`);
        res.json({ success: true, message: 'Balance de bots reseteado a $50.000' });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
