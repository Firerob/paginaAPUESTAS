-- ===========================================================================
-- Cuenta de la casa: dato de SISTEMA, no de prueba. Existe en TODOS los
-- entornos, incluida produccion.
--
-- A diferencia de 002_seed_dev.sql (que se salta a proposito con
-- NODE_ENV=production porque solo siembra a Ana y Beto), esta fila es
-- infraestructura real: settleMatch() acredita el rake ahi mismo en cada
-- liquidacion. Sin ella, cualquier partida con comision > 0 (practicamente
-- todas: ver RAKE_BPS) revienta con "wallet inexistente" y cae al camino de
-- emergencia — partida anulada, reembolso completo a los dos — sin importar
-- quien gano de verdad.
--
-- Idempotente (ON CONFLICT DO NOTHING) a proposito: en un entorno de
-- desarrollo donde 002_seed_dev.sql SI corrio, esta fila ya existe y esta
-- migracion no hace nada.
-- ===========================================================================

INSERT INTO users (id, email, display_name, role, status, kyc_status)
VALUES ('00000000-0000-0000-0000-0000000000ff', 'house@airhockey.local', 'Casa', 'system', 'active', 'verified')
ON CONFLICT (id) DO NOTHING;

INSERT INTO wallets (user_id, available, locked, withdrawable)
VALUES ('00000000-0000-0000-0000-0000000000ff', 0, 0, 0)
ON CONFLICT (user_id) DO NOTHING;
