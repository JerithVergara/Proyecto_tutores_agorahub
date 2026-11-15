-- Reputación derivada de reseñas publicadas e ingresos consultados desde sesiones completadas.
SET search_path TO agorahub, public;

CREATE OR REPLACE FUNCTION refresh_tutor_review_stats()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  affected_tutor UUID;
BEGIN
  affected_tutor := COALESCE(NEW.tutor_id, OLD.tutor_id);
  UPDATE tutor_profiles
  SET review_count = COALESCE(stats.review_count, 0),
      average_rating = COALESCE(stats.average_rating, 0),
      updated_at = now()
  FROM (
    SELECT tutor_id,
           COUNT(*)::INTEGER AS review_count,
           ROUND(AVG(rating)::NUMERIC, 1) AS average_rating
    FROM tutor_reviews
    WHERE tutor_id = affected_tutor AND is_published = TRUE
    GROUP BY tutor_id
  ) AS stats
  WHERE tutor_profiles.user_id = affected_tutor;

  IF NOT FOUND THEN
    UPDATE tutor_profiles
    SET review_count = 0, average_rating = 0, updated_at = now()
    WHERE user_id = affected_tutor;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tutor_reviews_refresh_stats ON tutor_reviews;
CREATE TRIGGER tutor_reviews_refresh_stats
AFTER INSERT OR UPDATE OF rating, is_published OR DELETE ON tutor_reviews
FOR EACH ROW EXECUTE FUNCTION refresh_tutor_review_stats();

UPDATE tutor_profiles AS tp
SET review_count = COALESCE(stats.review_count, 0),
    average_rating = COALESCE(stats.average_rating, 0),
    updated_at = now()
FROM (
  SELECT tutor_id, COUNT(*)::INTEGER AS review_count, ROUND(AVG(rating)::NUMERIC, 1) AS average_rating
  FROM tutor_reviews
  WHERE is_published = TRUE
  GROUP BY tutor_id
) AS stats
WHERE tp.user_id = stats.tutor_id;

GRANT SELECT ON tutor_reviews TO service_role;