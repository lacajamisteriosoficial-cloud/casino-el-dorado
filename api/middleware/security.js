const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// ── Helmet (headers HTTP seguros) ─────────────────────────────
const helmetConfig = helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
});

// ── Rate Limiters ─────────────────────────────────────────────

// Límite general de API
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Demasiadas peticiones. Intentá de nuevo en 15 minutos.' }
});

// Límite estricto para login/registro (anti brute-force)
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Demasiados intentos de acceso. Intentá de nuevo en 15 minutos.' }
});

// Límite para acciones de juego
const gameLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Demasiadas acciones de juego. Esperá un momento.' }
});

module.exports = { helmetConfig, apiLimiter, authLimiter, gameLimiter };
