-- Validate weekly availability and prevent overlapping active tutor sessions.
SET search_path TO agorahub, public;

CREATE OR REPLACE FUNCTION ensure_tutor_slot_available(
    p_tutor_id UUID,
    p_starts_at TIMESTAMPTZ,
    p_ends_at TIMESTAMPTZ,
    p_modality VARCHAR,
    p_session_id UUID DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = agorahub, public
AS $$
BEGIN
    IF p_starts_at <= now() THEN
        RAISE EXCEPTION 'SESSION_IN_PAST';
    END IF;
    IF p_ends_at <= p_starts_at THEN
        RAISE EXCEPTION 'INVALID_TIME_RANGE';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext(p_tutor_id::text));

    IF NOT EXISTS (
        SELECT 1
        FROM tutor_availability_rules availability
        WHERE availability.tutor_id = p_tutor_id
          AND availability.is_active = TRUE
          AND availability.day_of_week = EXTRACT(DOW FROM p_starts_at AT TIME ZONE COALESCE(availability.timezone, 'America/Bogota'))::SMALLINT
          AND (p_starts_at AT TIME ZONE COALESCE(availability.timezone, 'America/Bogota'))::DATE
              = (p_ends_at AT TIME ZONE COALESCE(availability.timezone, 'America/Bogota'))::DATE
          AND (availability.modality = 'both' OR availability.modality = p_modality)
          AND (p_starts_at AT TIME ZONE COALESCE(availability.timezone, 'America/Bogota'))::TIME >= availability.start_time
          AND (p_ends_at AT TIME ZONE COALESCE(availability.timezone, 'America/Bogota'))::TIME <= availability.end_time
    ) THEN
        RAISE EXCEPTION 'TUTOR_UNAVAILABLE';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM tutor_availability_exceptions exception
        WHERE exception.tutor_id = p_tutor_id
          AND exception.exception_type = 'blocked'
          AND exception.starts_at < p_ends_at
          AND exception.ends_at > p_starts_at
    ) THEN
        RAISE EXCEPTION 'TUTOR_UNAVAILABLE';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM tutoring_sessions session
        WHERE session.tutor_id = p_tutor_id
          AND session.id IS DISTINCT FROM p_session_id
          AND session.status IN ('scheduled', 'in_progress')
          AND session.starts_at < p_ends_at
          AND session.ends_at > p_starts_at
    ) THEN
        RAISE EXCEPTION 'TUTOR_BOOKING_CONFLICT';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION protect_tutor_session_slot()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = agorahub, public
AS $$
BEGIN
    IF NEW.status IN ('scheduled', 'in_progress') THEN
        PERFORM ensure_tutor_slot_available(NEW.tutor_id, NEW.starts_at, NEW.ends_at, NEW.modality, NEW.id);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_tutor_session_slot ON tutoring_sessions;
CREATE TRIGGER trg_protect_tutor_session_slot
BEFORE INSERT OR UPDATE OF tutor_id, starts_at, ends_at, modality, status
ON tutoring_sessions
FOR EACH ROW
EXECUTE FUNCTION protect_tutor_session_slot();

CREATE OR REPLACE FUNCTION accept_tutoring_proposal(
    p_request_id UUID,
    p_proposal_id UUID,
    p_tutor_id UUID
)
RETURNS SETOF tutoring_sessions
LANGUAGE plpgsql
SET search_path = agorahub, public
AS $$
DECLARE
    request_row tutoring_requests%ROWTYPE;
    proposal_row tutoring_proposals%ROWTYPE;
    session_row tutoring_sessions%ROWTYPE;
    session_start TIMESTAMPTZ;
    session_end TIMESTAMPTZ;
    accepted_at TIMESTAMPTZ := now();
BEGIN
    PERFORM 1 FROM tutoring_requests WHERE id = p_request_id FOR UPDATE;
    SELECT * INTO request_row FROM tutoring_requests WHERE id = p_request_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'REQUEST_NOT_FOUND';
    END IF;

    SELECT * INTO proposal_row
    FROM tutoring_proposals
    WHERE id = p_proposal_id AND request_id = p_request_id AND tutor_id = p_tutor_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'PROPOSAL_NOT_FOUND';
    END IF;

    SELECT * INTO session_row FROM tutoring_sessions WHERE request_id = p_request_id;
    IF FOUND THEN
        RETURN NEXT session_row;
        RETURN;
    END IF;

    IF request_row.status IN ('accepted', 'cancelled', 'expired', 'rejected')
       OR proposal_row.status <> 'pending'
       OR (request_row.tutor_id IS NOT NULL AND request_row.tutor_id <> p_tutor_id) THEN
        RAISE EXCEPTION 'REQUEST_CLOSED';
    END IF;

    session_start := COALESCE(proposal_row.proposed_starts_at, request_row.preferred_starts_at);
    session_end := COALESCE(proposal_row.proposed_ends_at, request_row.preferred_ends_at, session_start + INTERVAL '1 hour');

    PERFORM ensure_tutor_slot_available(p_tutor_id, session_start, session_end, request_row.modality, NULL);

    INSERT INTO tutoring_sessions (
        request_id, accepted_proposal_id, student_id, tutor_id, subject_id,
        starts_at, ends_at, modality, location_text, meeting_url, status
    )
    VALUES (
        request_row.id, proposal_row.id, request_row.student_id, p_tutor_id, request_row.subject_id,
        session_start, session_end, request_row.modality, request_row.location_text, request_row.meeting_url, 'scheduled'
    )
    RETURNING * INTO session_row;

    UPDATE tutoring_proposals
    SET status = CASE WHEN id = proposal_row.id THEN 'accepted' ELSE 'rejected' END,
        updated_at = accepted_at
    WHERE request_id = request_row.id AND status = 'pending';

    UPDATE tutoring_requests
    SET status = 'accepted', updated_at = accepted_at
    WHERE id = request_row.id;

    RETURN NEXT session_row;
END;
$$;

REVOKE ALL ON FUNCTION accept_tutoring_proposal(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION accept_tutoring_proposal(UUID, UUID, UUID) TO service_role;
GRANT SELECT, INSERT, UPDATE ON tutoring_sessions, tutoring_proposals, tutoring_requests TO service_role;