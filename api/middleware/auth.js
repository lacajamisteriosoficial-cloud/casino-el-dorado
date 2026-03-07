const jwt = require('jsonwebtoken');

// ── JWT para jugadores ────────────────────────────────────────
function requireAuth(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Token requerido' });
    }
    const token = authHeader.split(' ')[1];
    try {
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        req.user = payload;
        next();
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Sesión expirada. Iniciá sesión nuevamente.' });
        }
        return res.status(401).json({ error: 'Token inválido' });
    }
}

// ── JWT para admin ────────────────────────────────────────────
function requireAdmin(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Acceso denegado' });
    }
    const token = authHeader.split(' ')[1];
    try {
        const payload = jwt.verify(token, process.env.ADMIN_JWT_SECRET);
        if (payload.role !== 'admin') {
            return res.status(403).json({ error: 'Permisos insuficientes' });
        }
        req.admin = payload;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Acceso denegado' });
    }
}

module.exports = { requireAuth, requireAdmin };
