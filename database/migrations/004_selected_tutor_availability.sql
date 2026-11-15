-- Migración aditiva para reservar con el profesor seleccionado.
SET search_path TO agorahub, public;

ALTER TABLE tutoring_requests
  ADD COLUMN IF NOT EXISTS tutor_id UUID REFERENCES tutor_profiles(user_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ix_requests_tutor_status
  ON tutoring_requests(tutor_id, status, preferred_starts_at);

GRANT SELECT, INSERT, UPDATE ON tutoring_requests TO service_role;