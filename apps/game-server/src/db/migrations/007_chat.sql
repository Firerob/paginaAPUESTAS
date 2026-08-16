-- ===========================================================================
-- Chat global. Un solo canal publico (namespace de Socket.io `/chat`, sala
-- `global_chat`): cualquiera puede leerlo, solo un usuario con JWT valido
-- puede escribir. `user_id` NOT NULL a proposito — nunca se guarda un
-- mensaje sin autor, eso lo garantiza el server antes de llegar aca.
-- ===========================================================================

CREATE TABLE chat_messages (
    id          BIGSERIAL PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES users(id),
    body        TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 120),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- El unico patron de lectura real es "los ultimos N": DESC cubre eso directo.
CREATE INDEX chat_messages_created_idx ON chat_messages (created_at DESC, id DESC);
