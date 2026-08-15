-- ===========================================================================
-- Blackjack Arena 1v1
--
-- Tercer juego de la plataforma. No necesita tablas nuevas: el estado de
-- cada mano vive en memoria del proceso (igual que el tablero de Minas o la
-- fisica de Air Hockey), y lo unico que se persiste es la liquidacion final
-- via las mismas `matches`/`match_players`/`ledger_entries` de siempre.
-- ===========================================================================

ALTER TABLE matches
    DROP CONSTRAINT matches_game_type_check;

ALTER TABLE matches
    ADD CONSTRAINT matches_game_type_check
        CHECK (game_type IN ('air_hockey', 'mines', 'blackjack'));

-- Misma exigencia de juego limpio demostrable que ya tiene Minas: si es
-- blackjack, tiene que haber un commit_hash publicado antes de jugar.
ALTER TABLE matches
    ADD CONSTRAINT blackjack_has_commit
        CHECK (game_type <> 'blackjack' OR commit_hash IS NOT NULL);

COMMENT ON COLUMN matches.score_home IS
    'Asiento 0: goles en air_hockey, puntos en minas, vidas restantes en blackjack';
COMMENT ON COLUMN matches.score_away IS
    'Asiento 1: goles en air_hockey, puntos en minas, vidas restantes en blackjack';
