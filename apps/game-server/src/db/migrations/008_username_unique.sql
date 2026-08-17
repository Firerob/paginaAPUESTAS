-- ===========================================================================
-- "Nombre de usuario" para el login real = users.display_name (ya es el
-- campo que se muestra en todo el sitio: chat, partidas, lobby). Unico
-- caso-insensible, para que "Ana" y "ana" no puedan coexistir como dos
-- usuarios distintos.
--
-- No es dato de prueba (a diferencia de 002_seed_dev.sql): corre en todos
-- los entornos, incluida produccion.
-- ===========================================================================

CREATE UNIQUE INDEX users_display_name_ci_unique ON users (lower(display_name));
