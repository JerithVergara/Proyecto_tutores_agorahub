-- Migración operativa: blogs, materias personalizadas y moneda única USD.
-- Ejecutar en el SQL Editor de Supabase una sola vez.
SET search_path TO agorahub, public;

CREATE TABLE IF NOT EXISTS tutor_blogs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tutor_id    UUID NOT NULL REFERENCES tutor_profiles(user_id) ON DELETE CASCADE,
    title       VARCHAR(180) NOT NULL,
    content     TEXT NOT NULL,
    status      VARCHAR(20) NOT NULL DEFAULT 'published'
                CHECK (status IN ('draft', 'published', 'archived')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_tutor_blogs_tutor ON tutor_blogs(tutor_id, updated_at DESC);

-- Se conserva la columna currency porque tutor_search_view depende de ella.
-- Solo se normaliza su contenido y el valor predeterminado.
ALTER TABLE tutor_profiles ALTER COLUMN currency SET DEFAULT 'USD';
UPDATE tutor_profiles SET currency = 'USD' WHERE currency IS NULL OR currency <> 'USD';

ALTER TABLE tutoring_requests ADD COLUMN IF NOT EXISTS currency CHAR(3) NOT NULL DEFAULT 'USD';
ALTER TABLE tutoring_proposals ADD COLUMN IF NOT EXISTS currency CHAR(3) NOT NULL DEFAULT 'USD';
UPDATE tutoring_requests SET currency = 'USD';
UPDATE tutoring_proposals SET currency = 'USD';

-- El proyecto anterior almacenaba los valores en COP. La conversión conserva
-- aproximadamente el valor inicial antes de operar en USD.
UPDATE tutor_profiles SET hourly_rate = ROUND(hourly_rate / 1000, 2) WHERE hourly_rate > 1000;
UPDATE tutor_subjects SET hourly_rate = ROUND(hourly_rate / 1000, 2) WHERE hourly_rate > 1000;
UPDATE tutoring_requests SET budget_per_hour = ROUND(budget_per_hour / 1000, 2) WHERE budget_per_hour > 1000;
UPDATE tutoring_proposals SET proposed_hourly_rate = ROUND(proposed_hourly_rate / 1000, 2) WHERE proposed_hourly_rate > 1000;

GRANT SELECT, INSERT, UPDATE, DELETE ON tutor_blogs, subjects, tutor_subjects TO service_role;