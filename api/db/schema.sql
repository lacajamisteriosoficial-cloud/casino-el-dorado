-- ══════════════════════════════════════════════
-- CASINO EL DORADO — Schema PostgreSQL
-- ══════════════════════════════════════════════

-- Extensión para UUID
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Usuarios ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username      VARCHAR(30)  UNIQUE NOT NULL,
    email         VARCHAR(150) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    balance       NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    mp_alias      VARCHAR(100),
    role          VARCHAR(10)  NOT NULL DEFAULT 'player', -- 'player' | 'admin'
    is_active     BOOLEAN NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login    TIMESTAMPTZ
);

-- ── Transacciones (carga de fichas, premios, comisiones) ──────
CREATE TABLE IF NOT EXISTS transactions (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
    type          VARCHAR(20) NOT NULL, -- 'deposit' | 'prize' | 'bet' | 'commission' | 'refund'
    amount        NUMERIC(12,2) NOT NULL,
    balance_after NUMERIC(12,2),
    description   TEXT,
    mp_operation  VARCHAR(100), -- ID operación MercadoPago
    status        VARCHAR(15) NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected'
    game          VARCHAR(20), -- 'blackjack' | 'truco' | 'ludo' | 'jackpot' | 'cajas'
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Sesiones de juego ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS game_sessions (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    game          VARCHAR(20) NOT NULL,
    status        VARCHAR(15) NOT NULL DEFAULT 'active', -- 'active' | 'finished'
    pot           NUMERIC(12,2) NOT NULL DEFAULT 0,
    commission    NUMERIC(12,2) NOT NULL DEFAULT 0,
    winner_id     UUID REFERENCES users(id) ON DELETE SET NULL,
    prize         NUMERIC(12,2),
    metadata      JSONB,       -- datos específicos del juego
    started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at   TIMESTAMPTZ
);

-- ── Participantes por sesión ──────────────────────────────────
CREATE TABLE IF NOT EXISTS session_players (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id    UUID REFERENCES game_sessions(id) ON DELETE CASCADE,
    user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
    bet_amount    NUMERIC(12,2) NOT NULL,
    result        VARCHAR(10), -- 'win' | 'loss' | 'draw'
    joined_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Config global del casino (clave-valor) ────────────────────
CREATE TABLE IF NOT EXISTS casino_config (
    key           VARCHAR(50) PRIMARY KEY,
    value         TEXT NOT NULL,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Estado de Caja Misteriosa (persistencia) ──────────────────
CREATE TABLE IF NOT EXISTS cajas_state (
    id            SERIAL PRIMARY KEY,
    state_json    JSONB NOT NULL,
    config_json   JSONB NOT NULL,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Historial de ganadores (Caja Misteriosa) ──────────────────
CREATE TABLE IF NOT EXISTS cajas_winners (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    round_id      VARCHAR(50) NOT NULL,
    user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
    name          VARCHAR(100),
    mp_alias      VARCHAR(100),
    prize         NUMERIC(12,2),
    winning_box   INTEGER,
    transferred   BOOLEAN NOT NULL DEFAULT false,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Chat soporte ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_messages (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id    VARCHAR(100) NOT NULL,
    user_name     VARCHAR(100),
    from_role     VARCHAR(10) NOT NULL, -- 'player' | 'admin'
    message       TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Índices ───────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_transactions_user     ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status   ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_created  ON transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_game         ON game_sessions(game);
CREATE INDEX IF NOT EXISTS idx_sessions_status       ON game_sessions(status);
CREATE INDEX IF NOT EXISTS idx_chat_session          ON chat_messages(session_id);

-- ── Config por defecto ────────────────────────────────────────
INSERT INTO casino_config (key, value) VALUES
    ('commission_percent',  '20'),
    ('min_bet',             '5'),
    ('max_bet',             '100'),
    ('maintenance_mode',    'false'),
    ('casino_name',         'El Dorado'),
    ('cajas_entry_price',   '500'),
    ('cajas_extra_price',   '1000'),
    ('cajas_min_players',   '2'),
    ('cajas_max_players',   '10'),
    ('cajas_total_boxes',   '20'),
    ('cajas_mp_alias',      'casino.eldorado.mp')
ON CONFLICT (key) DO NOTHING;
