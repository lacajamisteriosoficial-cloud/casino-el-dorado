const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// ── Helmet (headers HTTP seguros) ─────────────────────────────
const helmetConfig = helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://sdk.mercadopago.com", "https://fonts.googleapis.com"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://fonts.gstatic.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:", "https:"],
            connectSrc: ["'self'", "https://api.mercadopago.com"],
        },
    },
    crossOriginEmbedderPolicy: false,
});

// ── Rate Limiters ─────────────────────────────────────────────

// Límite general de API
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
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
    windowMs: 1 * 60 * 1000, // 1 minuto
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Demasiadas acciones de juego. Esperá un momento.' }
});

module.exports = { helmetConfig, apiLimiter, authLimiter, gameLimiter };
