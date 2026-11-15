-- Publish only active, registered tutors with a priced subject and active availability.
SET search_path TO agorahub, public;

CREATE OR REPLACE VIEW tutor_search_view AS
SELECT
    tp.user_id AS tutor_id,
    u.full_name,
    u.avatar_url,
    tp.professional_title,
    (
        SELECT MIN(ts.hourly_rate)::NUMERIC(12,2)
        FROM tutor_subjects ts
        JOIN subjects subject ON subject.id = ts.subject_id AND subject.is_active = TRUE
        WHERE ts.tutor_id = tp.user_id AND ts.hourly_rate IS NOT NULL
    ) AS hourly_rate,
    tp.currency,
    tp.teaching_modality,
    tp.service_area,
    tp.verification_status,
    tp.average_rating,
    tp.review_count,
    (
        SELECT string_agg(DISTINCT subject.name, ', ' ORDER BY subject.name)
        FROM tutor_subjects ts
        JOIN subjects subject ON subject.id = ts.subject_id AND subject.is_active = TRUE
        WHERE ts.tutor_id = tp.user_id AND ts.hourly_rate IS NOT NULL
    ) AS subjects,
    ARRAY(
        SELECT DISTINCT level.name::text
        FROM tutor_education_levels tutor_level
        JOIN education_levels level ON level.id = tutor_level.education_level_id AND level.is_active = TRUE
        WHERE tutor_level.tutor_id = tp.user_id
        ORDER BY level.name::text
    ) AS education_levels,
    ARRAY(
        SELECT DISTINCT availability.day_of_week
        FROM tutor_availability_rules availability
        WHERE availability.tutor_id = tp.user_id AND availability.is_active = TRUE
        ORDER BY availability.day_of_week
    ) AS availability_days,
    (
        SELECT jsonb_agg(jsonb_build_object('subject_id', subject.id, 'name', subject.name, 'hourly_rate', ts.hourly_rate) ORDER BY subject.name)
        FROM tutor_subjects ts
        JOIN subjects subject ON subject.id = ts.subject_id AND subject.is_active = TRUE
        WHERE ts.tutor_id = tp.user_id AND ts.hourly_rate IS NOT NULL
    ) AS subject_rates
FROM tutor_profiles tp
JOIN users u ON u.id = tp.user_id AND u.status = 'active'
WHERE EXISTS (
    SELECT 1
    FROM user_roles membership
    JOIN roles role ON role.id = membership.role_id AND role.code = 'tutor'
    WHERE membership.user_id = tp.user_id
)
AND EXISTS (
    SELECT 1
    FROM tutor_subjects ts
    JOIN subjects subject ON subject.id = ts.subject_id AND subject.is_active = TRUE
    WHERE ts.tutor_id = tp.user_id AND ts.hourly_rate IS NOT NULL
)
AND EXISTS (
    SELECT 1
    FROM tutor_availability_rules availability
    WHERE availability.tutor_id = tp.user_id AND availability.is_active = TRUE
);

CREATE OR REPLACE FUNCTION search_tutors(
    p_subject TEXT DEFAULT NULL,
    p_education_level TEXT DEFAULT NULL,
    p_modality TEXT DEFAULT NULL,
    p_area TEXT DEFAULT NULL,
    p_min_rate NUMERIC DEFAULT NULL,
    p_max_rate NUMERIC DEFAULT NULL,
    p_availability_day SMALLINT DEFAULT NULL
)
RETURNS SETOF tutor_search_view
LANGUAGE SQL
STABLE
SET search_path = agorahub, public
AS $$
    SELECT tutor.*
    FROM tutor_search_view tutor
    WHERE (p_subject IS NULL OR EXISTS (
        SELECT 1
        FROM tutor_subjects ts
        JOIN subjects subject ON subject.id = ts.subject_id AND subject.is_active = TRUE
        WHERE ts.tutor_id = tutor.tutor_id
          AND ts.hourly_rate IS NOT NULL
          AND position(lower(p_subject) IN lower(subject.name)) > 0
    ))
    AND (p_education_level IS NULL OR EXISTS (
        SELECT 1
        FROM tutor_education_levels tutor_level
        JOIN education_levels level ON level.id = tutor_level.education_level_id AND level.is_active = TRUE
        WHERE tutor_level.tutor_id = tutor.tutor_id AND level.name = p_education_level
    ))
    AND (p_modality IS NULL OR tutor.teaching_modality IN (p_modality, 'both'))
    AND (p_area IS NULL OR position(lower(p_area) IN lower(COALESCE(tutor.service_area, ''))) > 0)
    AND (p_availability_day IS NULL OR p_availability_day = ANY(tutor.availability_days))
    AND (p_min_rate IS NULL AND p_max_rate IS NULL OR EXISTS (
        SELECT 1
        FROM tutor_subjects ts
        JOIN subjects subject ON subject.id = ts.subject_id AND subject.is_active = TRUE
        WHERE ts.tutor_id = tutor.tutor_id
          AND ts.hourly_rate IS NOT NULL
          AND (p_subject IS NULL OR position(lower(p_subject) IN lower(subject.name)) > 0)
          AND (p_min_rate IS NULL OR ts.hourly_rate >= p_min_rate)
          AND (p_max_rate IS NULL OR ts.hourly_rate <= p_max_rate)
    ))
    ORDER BY tutor.average_rating DESC;
$$;

-- Keep existing student conversations while adding independent tutor ownership.
ALTER TABLE ai_conversations
    ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE CASCADE;

UPDATE ai_conversations
SET owner_id = student_id
WHERE owner_id IS NULL;

ALTER TABLE ai_conversations
    ALTER COLUMN owner_id SET NOT NULL,
    ALTER COLUMN student_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS ix_ai_conversations_owner
    ON ai_conversations(owner_id, updated_at DESC);

GRANT SELECT, INSERT, UPDATE ON ai_conversations TO service_role;
GRANT SELECT ON tutor_search_view TO service_role;
REVOKE ALL ON FUNCTION search_tutors(TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, SMALLINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION search_tutors(TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, SMALLINT) TO service_role;