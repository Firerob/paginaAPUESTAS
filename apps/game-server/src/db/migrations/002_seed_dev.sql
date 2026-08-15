-- ===========================================================================
-- Semilla de desarrollo: cuenta de la casa + dos jugadores con saldo.
-- No ejecutar en produccion (el runner la salta si NODE_ENV=production).
-- ===========================================================================

-- Cuenta de sistema que acumula la comision. UUID fijo para poder referenciarla
-- desde la configuracion (HOUSE_USER_ID).
INSERT INTO users (id, email, display_name, role, status, kyc_status)
VALUES ('00000000-0000-0000-0000-0000000000ff', 'house@airhockey.local', 'Casa', 'system', 'active', 'verified')
ON CONFLICT (id) DO NOTHING;

INSERT INTO wallets (user_id, available, locked)
VALUES ('00000000-0000-0000-0000-0000000000ff', 0, 0)
ON CONFLICT (user_id) DO NOTHING;

-- Dos jugadores de prueba, con 50.000 COP cada uno.
INSERT INTO users (id, email, display_name, kyc_status)
VALUES
    ('00000000-0000-0000-0000-000000000001', 'ana@test.local',  'Ana',  'verified'),
    ('00000000-0000-0000-0000-000000000002', 'beto@test.local', 'Beto', 'verified')
ON CONFLICT (id) DO NOTHING;

INSERT INTO wallets (user_id, available, locked)
VALUES
    ('00000000-0000-0000-0000-000000000001', 50000, 0),
    ('00000000-0000-0000-0000-000000000002', 50000, 0)
ON CONFLICT (user_id) DO NOTHING;

-- El deposito inicial tambien queda en el diario, para que el invariante
-- "SUM(amount) = depositos - retiros" se cumpla desde el primer dia.
INSERT INTO ledger_entries
    (user_id, kind, amount, locked_delta, balance_after, locked_after, idempotency_key, metadata)
VALUES
    ('00000000-0000-0000-0000-000000000001', 'DEPOSIT', 50000, 0, 50000, 0, 'seed:deposit:ana',  '{"source":"seed"}'),
    ('00000000-0000-0000-0000-000000000002', 'DEPOSIT', 50000, 0, 50000, 0, 'seed:deposit:beto', '{"source":"seed"}')
ON CONFLICT (idempotency_key) DO NOTHING;
