-- ===========================================================================
-- Cajero: depositos y retiros con metodos de pago colombianos.
--
-- Decisiones de diseno, en linea con el resto del esquema:
--
--   1. `wallets.available` sigue siendo el saldo jugable total (efectivo +
--      bono). No se toca su significado: todo el motor de escrow/liquidacion
--      de wallet.service.ts sigue leyendolo igual.
--   2. `withdrawable` es la porcion de `available` que es retirable (dinero
--      en efectivo: depositos + ganancias). Se mueve en el mismo signo que
--      `available` en cada movimiento de dinero real, lo que mantiene el
--      invariante `withdrawable <= available` sin tener que tocar cada sitio
--      de wallet.service.ts uno por uno.
--   3. `bonus` queda reservado para un futuro motor de promociones. Se
--      agrega la columna para que el Cajero lo pueda mostrar ya mismo, pero
--      ningun movimiento la toca todavia: se queda en 0 hasta que exista esa
--      logica (requisitos de apuesta, expiracion, etc.), que es un problema
--      aparte y no se improvisa aqui.
--   4. `cashier_transactions` es el rastro del intento de pago (Nequi,
--      DaviPlata, PSE, tarjeta) ANTES de que se vuelva un movimiento de
--      saldo. `ledger_entries` sigue siendo el diario contable inmutable;
--      esta tabla es el estado de la conversacion con la pasarela.
-- ===========================================================================

ALTER TABLE wallets
    ADD COLUMN withdrawable BIGINT NOT NULL DEFAULT 0 CHECK (withdrawable >= 0),
    ADD COLUMN bonus        BIGINT NOT NULL DEFAULT 0 CHECK (bonus >= 0);

-- Backfill: el saldo que ya existia (depositos y ganancias previas a esta
-- migracion) se considera integramente retirable.
UPDATE wallets SET withdrawable = available;

ALTER TABLE wallets
    ADD CONSTRAINT wallets_withdrawable_le_available CHECK (withdrawable <= available);

COMMENT ON COLUMN wallets.withdrawable IS 'Subconjunto de available que es en efectivo (depositos + ganancias). No incluye bono.';
COMMENT ON COLUMN wallets.bonus IS 'Reservado para el motor de promociones. Siempre 0 hasta que exista esa feature.';

-- ---------------------------------------------------------------------------
-- El diario tambien registra el efecto sobre `withdrawable`, igual que ya
-- hace con `available` (amount) y `locked` (locked_delta).
-- ---------------------------------------------------------------------------
ALTER TABLE ledger_entries
    ADD COLUMN withdrawable_after BIGINT NOT NULL DEFAULT 0 CHECK (withdrawable_after >= 0);

-- ---------------------------------------------------------------------------
-- Transacciones del cajero: un intento de deposito o retiro con una pasarela.
-- ---------------------------------------------------------------------------
CREATE TABLE cashier_transactions (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL REFERENCES users(id),

    type             TEXT NOT NULL CHECK (type IN ('DEPOSIT', 'WITHDRAWAL')),
    method           TEXT NOT NULL CHECK (method IN ('NEQUI', 'DAVIPLATA', 'PSE', 'CARD')),
    amount           BIGINT NOT NULL CHECK (amount > 0),

    status           TEXT NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING', 'COMPLETED', 'FAILED', 'CANCELLED')),

    -- Adaptador que atendio el intento ('mock' en dev; el nombre del PSP real
    -- en produccion, p.ej. 'wompi'). Ver services/payment-providers/.
    provider         TEXT NOT NULL,
    provider_ref     TEXT,

    -- Para retiros: destino declarado por el usuario (numero de Nequi,
    -- cuenta PSE, etc.). Nunca datos de tarjeta completos.
    destination      JSONB NOT NULL DEFAULT '{}'::jsonb,

    failure_reason   TEXT,
    metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,

    idempotency_key  TEXT NOT NULL UNIQUE,

    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at     TIMESTAMPTZ,

    -- Recarga minima de $5.000 COP. Los retiros no tienen piso de producto
    -- (el piso operativo, si se necesita, lo pone el adaptador de pago).
    CONSTRAINT deposit_min_amount CHECK (type <> 'DEPOSIT' OR amount >= 5000),
    CONSTRAINT completed_has_timestamp CHECK (status <> 'COMPLETED' OR completed_at IS NOT NULL)
);

CREATE INDEX cashier_transactions_user_idx ON cashier_transactions (user_id, created_at DESC);
CREATE INDEX cashier_transactions_pending_idx ON cashier_transactions (status) WHERE status = 'PENDING';

CREATE TRIGGER cashier_transactions_touch BEFORE UPDATE ON cashier_transactions
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
