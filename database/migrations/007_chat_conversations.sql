-- Conversaciones directas entre estudiantes y tutores.
SET search_path TO agorahub, public;

CREATE TABLE IF NOT EXISTS chat_conversations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id  UUID NOT NULL REFERENCES student_profiles(user_id) ON DELETE CASCADE,
    tutor_id    UUID NOT NULL REFERENCES tutor_profiles(user_id) ON DELETE CASCADE,
    request_id  UUID REFERENCES tutoring_requests(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (student_id, tutor_id)
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
    sender_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body            VARCHAR(2000) NOT NULL,
    sent_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    read_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ix_chat_conversations_student ON chat_conversations(student_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS ix_chat_conversations_tutor ON chat_conversations(tutor_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS ix_chat_messages_conversation ON chat_messages(conversation_id, sent_at);
GRANT SELECT, INSERT, UPDATE ON chat_conversations, chat_messages TO service_role;