-- Avatares de perfil optimizados. Las escrituras se realizan desde el backend con service role.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('avatars', 'avatars', true, 307200, ARRAY['image/jpeg', 'image/png', 'image/webp']::text[])
ON CONFLICT (id) DO UPDATE
SET public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Public can read profile avatars" ON storage.objects;
CREATE POLICY "Public can read profile avatars"
ON storage.objects FOR SELECT
USING (bucket_id = 'avatars');