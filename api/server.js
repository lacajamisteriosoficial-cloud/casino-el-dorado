require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');

const { helmetConfig, apiLimiter } = require('./middleware/security');
const authRoutes     = require('./routes/auth');
const gamesRoutes    = require('./routes/games');
const cajasRoutes    = require('./routes/cajas');
const paymentsRoutes = require('./routes/payments');
const adminRoutes    = require('./routes/admin');
const setupSockets   = require('./games/socketHandler');

const app = express();
const server = http.createServer(app);

const allowedOrigins = [
  process.env.ALLOWED_ORIGIN,
  'http://localhost:3000',
  'http://localhost:3001'
].filter(Boolean);

// ── Socket.io ─────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: allowedOrigins, credentials: true },
  transports: ['websocket', 'polling']
});
setupSockets(io);

// ── Seguridad ─────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(helmetConfig);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('CORS no permitido'));
  },
  credentials: true
}));

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));
app.use('/api', apiLimiter);

// ── Rutas API ─────────────────────────────────────────────────
app.use('/api/auth',     authRoutes);
app.use('/api/games',    gamesRoutes);
app.use('/api/cajas',    cajasRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/admin',    adminRoutes);

// ── Archivos estáticos ────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public'), { index: false, extensions: ['html'] }));
app.use('/admin', express.static(path.join(__dirname, '../admin'), { index: false, extensions: ['html'] }));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '../admin/index.html')));
app.get('/admin/*', (req, res) => res.sendFile(path.join(__dirname, '../admin/index.html')));
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.use((req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));
app.use((err, req, res, next) => {
  console.error('Server error:', err.message);
  res.status(500).json({ error: 'Error interno del servidor' });
});

// ── Iniciar ───────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎰 Casino El Dorado corriendo en puerto ${PORT}`);
  console.log(`🌍 Entorno: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
