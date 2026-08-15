-- ===========================================================================
-- Air Hockey con apuestas — esquema base
--
-- Principios:
--   1. El dinero vive en `wallets` (saldo materializado) y en `ledger_entries`
--      (diario append-only). El diario es la verdad auditable; la wallet es la
--      proyeccion rapida. Ambos se escriben SIEMPRE en la misma transaccion.
--   2. Ningun monto puede quedar negativo: lo garantizan CHECK constraints a
--      nivel de tabla, no la logica de aplicacion.
--   3. Toda escritura de dinero lleva `idempotency_key` UNIQUE. Un reintento
--      del servidor (crash, timeout de red) no puede acreditar dos veces.
--   4. Montos en BIGINT = pesos colombianos ENTEROS. Sin centavos, sin floats.
-- ===========================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;     -- emails case-insensitive

-- ---------------------------------------------------------------------------
-- Usuarios
-- ---------------------------------------------------------------------------
CREATE TABLE users (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email          CITEXT UNIQUE NOT NULL,
    display_name   TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 2 AND 32),
    password_hash  TEXT,
    -- 'system' es la cuenta de la casa: acumula el rake, no juega.
    role           TEXT NOT NULL DEFAULT 'player'
                   CHECK (role IN ('player', 'system', 'admin')),
    -- self_excluded es requisito de juego responsable: el usuario se bloquea
    -- a si mismo y ni el operador puede revertirlo antes del plazo.
    status         TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'suspended', 'self_excluded', 'closed')),
    kyc_status     TEXT NOT NULL DEFAULT 'none'
                   CHECK (kyc_status IN ('none', 'pending', 'verified', 'rejected')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Wallets: una por usuario. `available` es lo que puede apostar o retirar;
-- `locked` es lo que esta en escrow dentro de una partida en curso.
-- ---------------------------------------------------------------------------
CREATE TABLE wallets (
    user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
    currency    CHAR(3) NOT NULL DEFAULT 'COP',
    available   BIGINT NOT NULL DEFAULT 0 CHECK (available >= 0),
    locked      BIGINT NOT NULL DEFAULT 0 CHECK (locked >= 0),
    -- Contador optimista. Se incrementa en cada escritura; sirve para detectar
    -- escrituras concurrentes en tests y para debugging forense.
    version     BIGINT NOT NULL DEFAULT 0,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Partidas
-- ---------------------------------------------------------------------------
CREATE TABLE matches (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- id de la sala de Colyseus. UNIQUE evita que una sala cree dos partidas.
    room_id         TEXT UNIQUE NOT NULL,
    stake           BIGINT NOT NULL CHECK (stake > 0),
    rake_bps        INTEGER NOT NULL DEFAULT 1000 CHECK (rake_bps BETWEEN 0 AND 10000),

    status          TEXT NOT NULL DEFAULT 'matchmaking'
                    CHECK (status IN ('matchmaking', 'escrowed', 'in_progress',
                                      'finished', 'cancelled', 'voided')),

    -- Se llenan en la liquidacion. NULL mientras la partida no termine.
    pot             BIGINT CHECK (pot IS NULL OR pot >= 0),
    rake            BIGINT CHECK (rake IS NULL OR rake >= 0),
    payout          BIGINT CHECK (payout IS NULL OR payout >= 0),

    winner_user_id  UUID REFERENCES users(id),
    end_reason      TEXT CHECK (end_reason IN ('score', 'abandon', 'forfeit',
                                               'timeout', 'error', 'cancelled')),
    score_home      SMALLINT NOT NULL DEFAULT 0 CHECK (score_home >= 0),
    score_away      SMALLINT NOT NULL DEFAULT 0 CHECK (score_away >= 0),

    -- Semilla del saque inicial. Se guarda para poder reproducir la partida
    -- ante una disputa del jugador.
    seed            TEXT NOT NULL,
    server_version  TEXT NOT NULL DEFAULT 'dev',

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at      TIMESTAMPTZ,
    ended_at        TIMESTAMPTZ,
    settled_at      TIMESTAMPTZ,
    -- Latido del game server. El barredor (sweeper) anula las partidas cuyo
    -- proceso murio sin liquidar, devolviendo el dinero bloqueado.
    heartbeat_at    TIMESTAMPTZ,

    -- Una partida liquidada tiene que tener sus montos completos.
    CONSTRAINT settled_has_amounts CHECK (
        settled_at IS NULL
        OR (pot IS NOT NULL AND rake IS NOT NULL AND payout IS NOT NULL)
    ),
    -- Y una partida 'finished' tiene que tener ganador; una 'voided' no.
    CONSTRAINT finished_has_winner CHECK (
        status <> 'finished' OR winner_user_id IS NOT NULL
    ),
    CONSTRAINT voided_has_no_winner CHECK (
        status NOT IN ('voided', 'cancelled') OR winner_user_id IS NULL
    )
);

CREATE INDEX matches_status_idx ON matches (status);
-- Para el sweeper: encontrar rapido partidas colgadas.
CREATE INDEX matches_unsettled_idx ON matches (heartbeat_at)
    WHERE status IN ('escrowed', 'in_progress');

-- ---------------------------------------------------------------------------
-- Jugadores de cada partida
-- ---------------------------------------------------------------------------
CREATE TABLE match_players (
    match_id       UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    user_id        UUID NOT NULL REFERENCES users(id),
    seat           SMALLINT NOT NULL CHECK (seat IN (0, 1)),
    stake_held     BIGINT NOT NULL CHECK (stake_held >= 0),
    result         TEXT CHECK (result IN ('win', 'loss', 'void')),
    goals          SMALLINT NOT NULL DEFAULT 0 CHECK (goals >= 0),
    disconnects    SMALLINT NOT NULL DEFAULT 0,
    joined_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (match_id, user_id),
    UNIQUE (match_id, seat)
);

-- Un usuario no puede tener dinero bloqueado en dos partidas a la vez.
-- Esto cierra el agujero clasico: abrir dos pestañas y apostar el mismo saldo.
CREATE UNIQUE INDEX match_players_one_open_per_user_idx
    ON match_players (user_id) WHERE result IS NULL;

-- ---------------------------------------------------------------------------
-- Diario contable (append-only). Nunca se hace UPDATE ni DELETE aqui.
--
-- `amount`       = efecto sobre `wallets.available` (con signo)
-- `locked_delta` = efecto sobre `wallets.locked`    (con signo)
--
-- Invariante global del sistema:
--   SUM(amount) sobre todas las filas = suma de depositos - suma de retiros
--   SUM(locked_delta) sobre todas las filas = 0 cuando no hay partidas abiertas
-- ---------------------------------------------------------------------------
CREATE TABLE ledger_entries (
    id               BIGSERIAL PRIMARY KEY,
    user_id          UUID NOT NULL REFERENCES users(id),
    match_id         UUID REFERENCES matches(id) ON DELETE SET NULL,
    kind             TEXT NOT NULL CHECK (kind IN (
                        'DEPOSIT',      -- entrada de dinero externo
                        'WITHDRAWAL',   -- salida de dinero externo
                        'BET_HOLD',     -- available -> locked (escrow)
                        'BET_RELEASE',  -- locked -> available (devolucion)
                        'BET_LOSS',     -- locked -> 0 (el perdedor pierde su apuesta)
                        'BET_WIN',      -- 0 -> available (premio neto del ganador)
                        'RAKE',         -- comision hacia la cuenta de la casa
                        'ADJUSTMENT'    -- correccion manual, requiere motivo
                     )),
    amount           BIGINT NOT NULL,
    locked_delta     BIGINT NOT NULL DEFAULT 0,
    -- Snapshot del saldo despues de aplicar esta fila. Permite auditar sin
    -- tener que re-sumar todo el diario.
    balance_after    BIGINT NOT NULL CHECK (balance_after >= 0),
    locked_after     BIGINT NOT NULL CHECK (locked_after >= 0),
    idempotency_key  TEXT NOT NULL UNIQUE,
    metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ledger_user_created_idx ON ledger_entries (user_id, created_at DESC);
CREATE INDEX ledger_match_idx ON ledger_entries (match_id) WHERE match_id IS NOT NULL;

-- El diario es inmutable. Esto no es una convencion: es una regla del motor.
CREATE OR REPLACE FUNCTION ledger_is_append_only() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'ledger_entries es append-only (intento de % )', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION ledger_is_append_only();
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION ledger_is_append_only();

-- ---------------------------------------------------------------------------
-- Bitacora de la partida: goles, desconexiones, inputs rechazados.
-- Sirve para resolver disputas y para detectar patrones de trampa.
-- ---------------------------------------------------------------------------
CREATE TABLE match_events (
    id          BIGSERIAL PRIMARY KEY,
    match_id    UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    user_id     UUID REFERENCES users(id),
    tick        INTEGER NOT NULL DEFAULT 0,
    type        TEXT NOT NULL,
    payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX match_events_match_idx ON match_events (match_id, id);

-- ---------------------------------------------------------------------------
-- Trigger de mantenimiento de updated_at
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_touch BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER wallets_touch BEFORE UPDATE ON wallets
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
