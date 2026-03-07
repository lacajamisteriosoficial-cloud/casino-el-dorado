const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { query } = require('../config/db');

// ── Crear preferencia de pago MP ──────────────────────────────
router.post('/create-preference', requireAuth, async (req, res) => {
    const { amount, description } = req.body;

    if (!amount || amount < 5 || amount > 50000) {
        return res.status(400).json({ error: 'Monto inválido (mín $5, máx $50.000)' });
    }

    try {
        const mpAccessToken = process.env.MP_ACCESS_TOKEN;
        if (!mpAccessToken) {
            return res.status(500).json({ error: 'Pasarela de pago no configurada' });
        }

        const preference = {
            items: [{
                title: description || 'Fichas Casino El Dorado',
                quantity: 1,
                currency_id: 'ARS',
                unit_price: parseFloat(amount)
            }],
            payer: { email: req.user.email },
            external_reference: `${req.user.id}__${Date.now()}`,
            back_urls: {
                success: `${process.env.ALLOWED_ORIGIN || ''}/wallet.html?status=success`,
                failure: `${process.env.ALLOWED_ORIGIN || ''}/wallet.html?status=failure`,
                pending: `${process.env.ALLOWED_ORIGIN || ''}/wallet.html?status=pending`
            },
            auto_return: 'approved',
            notification_url: `${process.env.ALLOWED_ORIGIN || ''}/api/payments/webhook`
        };

        const mpRes = await fetch('https://api.mercadopago.com/checkout/preferences', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${mpAccessToken}`
            },
            body: JSON.stringify(preference)
        });

        const mpData = await mpRes.json();

        if (!mpRes.ok) {
            console.error('MP error:', mpData);
            return res.status(500).json({ error: 'Error al crear preferencia de pago' });
        }

        // Registrar transacción pendiente
        await query(
            `INSERT INTO transactions (user_id, type, amount, description, mp_operation, status, game)
             VALUES ($1, 'deposit', $2, $3, $4, 'pending', null)`,
            [req.user.id, amount, description || 'Carga de fichas', mpData.id]
        );

        res.json({
            preferenceId: mpData.id,
            initPoint: mpData.init_point,
            sandboxInitPoint: mpData.sandbox_init_point
        });

    } catch (err) {
        console.error('Payment error:', err);
        res.status(500).json({ error: 'Error interno al procesar el pago' });
    }
});

// ── Webhook MercadoPago ───────────────────────────────────────
router.post('/webhook', async (req, res) => {
    const { type, data } = req.body;

    // Responder rápido a MP
    res.status(200).send('OK');

    if (type !== 'payment') return;

    try {
        const mpAccessToken = process.env.MP_ACCESS_TOKEN;
        const paymentRes = await fetch(`https://api.mercadopago.com/v1/payments/${data.id}`, {
            headers: { 'Authorization': `Bearer ${mpAccessToken}` }
        });
        const payment = await paymentRes.json();

        if (payment.status !== 'approved') return;

        // Extraer userId del external_reference
        const [userId] = (payment.external_reference || '').split('__');
        if (!userId) return;

        const amount = parseFloat(payment.transaction_amount);

        // Actualizar transacción y saldo (transacción atómica)
        const client = await require('../config/db').getClient();
        try {
            await client.query('BEGIN');

            // Evitar duplicados por payment_id
            const exists = await client.query(
                "SELECT id FROM transactions WHERE mp_operation = $1 AND status = 'approved'",
                [data.id.toString()]
            );
            if (exists.rows.length > 0) {
                await client.query('ROLLBACK');
                return;
            }

            // Actualizar saldo
            const userRes = await client.query(
                'UPDATE users SET balance = balance + $1 WHERE id = $2 RETURNING balance',
                [amount, userId]
            );
            const newBalance = parseFloat(userRes.rows[0]?.balance || 0);

            // Registrar transacción aprobada
            await client.query(
                `INSERT INTO transactions (user_id, type, amount, balance_after, description, mp_operation, status)
                 VALUES ($1, 'deposit', $2, $3, 'Carga de fichas via MercadoPago', $4, 'approved')`,
                [userId, amount, newBalance, data.id.toString()]
            );

            await client.query('COMMIT');
            console.log(`✅ Pago aprobado: usuario ${userId}, monto $${amount}`);
        } catch (e) {
            await client.query('ROLLBACK');
            console.error('Webhook transaction error:', e);
        } finally {
            client.release();
        }

    } catch (err) {
        console.error('Webhook error:', err);
    }
});

// ── Historial de transacciones del usuario ────────────────────
router.get('/history', requireAuth, async (req, res) => {
    try {
        const result = await query(
            `SELECT id, type, amount, balance_after, description, status, game, created_at
             FROM transactions
             WHERE user_id = $1
             ORDER BY created_at DESC
             LIMIT 50`,
            [req.user.id]
        );
        res.json({ transactions: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener historial' });
    }
});

module.exports = router;
