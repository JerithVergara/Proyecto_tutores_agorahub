-- Persist the optional reason a tutor gives when rejecting a request.
SET search_path TO agorahub, public;

ALTER TABLE tutoring_requests
  ADD COLUMN IF NOT EXISTS rejection_reason VARCHAR(255);

GRANT SELECT, INSERT, UPDATE ON tutoring_requests TO service_role;