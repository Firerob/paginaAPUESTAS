-- ===========================================================================
-- Soporte multi-juego + prueba de juego limpio (provably fair)
--
-- El esquema original asumia Air Hockey: `score_home`/`score_away` y nada mas.
-- Mines necesita guardar la configuracion del tablero y, sobre todo, poder
-- demostrarle al jugador que las bombas no se movieron a mitad de partida.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Que juego es cada partida
-- ---------------------------------------------------------------------------
ALTER TABLE matches
    ADD COLUMN game_type TEXT NOT NULL DEFAULT 'air_hockey'
        CHECK (game_type IN ('air_hockey', 'mines'));

-- Parametros del juego: tamaño del tablero, numero de bombas, etc.
-- JSONB y no columnas sueltas porque cada juego tiene su propia forma y no
-- queremos una migracion por cada variante que probemos.
ALTER TABLE matches
    ADD COLUMN config JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- Prueba de juego limpio
--
-- `commit_hash` es SHA-256 de `seed` y se publica ANTES de la primera jugada.
-- `seed` ya existia (se usaba para el saque de Air Hockey) y aqui pasa a ser
-- la semilla del tablero. Al terminar se revela, y cualquiera puede:
--
--   1. comprobar que sha256(seed) = commit_hash
--   2. recalcular las bombas desde la semilla y comparar
--
-- `revealed_at` deja constancia de cuando se publico la semilla. Que exista
-- la columna es lo que permite auditar que no se revelo antes de tiempo:
-- una semilla revelada antes del final le daria el tablero al jugador.
-- ---------------------------------------------------------------------------
ALTER TABLE matches
    ADD COLUMN commit_hash TEXT,
    ADD COLUMN revealed_at TIMESTAMPTZ;

-- Una partida terminada de un juego con compromiso tiene que tenerlo.
ALTER TABLE matches
    ADD CONSTRAINT mines_has_commit CHECK (
        game_type <> 'mines' OR commit_hash IS NOT NULL
    );

CREATE INDEX matches_game_type_idx ON matches (game_type, status);

-- ---------------------------------------------------------------------------
-- El marcador deja de ser "goles"
--
-- En Mines son puntos, y pueden pasar de 32767. El SMALLINT original se
-- queda corto: 8x8 con multiplicador acumulado supera el limite con
-- facilidad, y un desbordamiento aqui decide mal una partida con dinero.
-- ---------------------------------------------------------------------------
ALTER TABLE matches
    ALTER COLUMN score_home TYPE INTEGER,
    ALTER COLUMN score_away TYPE INTEGER;

ALTER TABLE match_players
    ALTER COLUMN goals TYPE INTEGER;

COMMENT ON COLUMN matches.score_home IS 'Asiento 0: goles en air_hockey, puntos en mines';
COMMENT ON COLUMN matches.score_away IS 'Asiento 1: goles en air_hockey, puntos en mines';
COMMENT ON COLUMN matches.commit_hash IS 'SHA-256 de seed, publicado antes de jugar';
