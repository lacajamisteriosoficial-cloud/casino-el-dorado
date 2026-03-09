const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { query } = require('../config/db');
const { authLimiter } = require('../middleware/security');
const { requireAdmin } = require('../middleware/auth');

// ── Registro SOLO por admin ───────────────────────────────────
router.post('/register', requireAdmin, [
    body('username').trim().isLength({ min: 3, max: 30 }).matches(/^[a-zA-Z0-9_]+$/),
    body('email').trim().isEmail().normalizeEmail(),
    body('password').isLength({ min: 6 }),
    body('mpAlias').optional().trim().isLength({ max: 100 }),
    body('initialBalance').optional().isFloat({ min: 0 }),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    const { username, email, password, mpAlias, initialBalance } = req.body;
    try {
        const existing = await query('SELECT id FROM users WHERE username = $1 OR email = $2', [username, email]);
        if (existing.rows.length > 0) return res.status(409).json({ error: 'El usuario o email ya existe' });

        const hash = await bcrypt.hash(password, 12);
        const balance = parseFloat(initialBalance) || 0;

        const result = await query(
            `INSERT INTO users (username, email, password_hash, mp_alias, balance)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, username, email, balance, mp_alias, created_at`,
            [username, email, hash, mpAlias || null, balance]
        );
        res.status(201).json({ success: true, user: result.rows[0] });
    } catch (err) {
        console.error('Register error:', err);
        res.status(500).json({ error: 'Error interno' });
    }
});

// ── Login jugador ─────────────────────────────────────────────
router.post('/login', authLimiter, [
    body('username').trim().notEmpty(),
    body('password').notEmpty(),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    const { username, password } = req.body;
    try {
        const result = await query(
            'SELECT id, username, email, password_hash, balance, mp_alias, is_active FROM users WHERE username = $1',
            [username]
        );
        if (result.rows.length === 0) {
            await bcrypt.compare(password, '$2a$12$placeholder.hash.for.timing.safe.comparison');
            return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
        }
        const user = result.rows[0];
        if (!user.is_active) return res.status(403).json({ error: 'Cuenta suspendida. Contactá soporte.' });

        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });

        await query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

        const token = jwt.sign(
            { id: user.id, username: user.username, role: 'player' },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );
        res.json({ token, user: { id: user.id, username: user.username, email: user.email, balance: parseFloat(user.balance), mpAlias: user.mp_alias } });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Error interno' });
    }
});

// ── Login Admin ───────────────────────────────────────────────
router.post('/admin/login', authLimiter, [
    body('username').trim().notEmpty(),
    body('password').notEmpty(),
], async (req, res) => {
    const { username, password } = req.body;
    const adminUser = process.env.ADMIN_USER;
    const adminPass = process.env.ADMIN_PASSWORD;
    if (!adminUser || !adminPass) return res.status(500).json({ error: 'Admin no configurado' });
    if (username !== adminUser || password !== adminPass) return res.status(401).json({ error: 'Credenciales incorrectas' });

    const token = jwt.sign({ username, role: 'admin' }, process.env.ADMIN_JWT_SECRET, { expiresIn: '8h' });
    res.json({ token });
});

// ── Perfil (me) ───────────────────────────────────────────────
router.get('/me', require('../middleware/auth').requireAuth, async (req, res) => {
    try {
        const result = await query(
            'SELECT id, username, email, balance, mp_alias, created_at, last_login FROM users WHERE id = $1',
            [req.user.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
        const u = result.rows[0];
        res.json({ id: u.id, username: u.username, email: u.email, balance: parseFloat(u.balance), mpAlias: u.mp_alias, createdAt: u.created_at, lastLogin: u.last_login });
    } catch (err) {
        res.status(500).json({ error: 'Error interno' });
    }
});

module.exports = router;
