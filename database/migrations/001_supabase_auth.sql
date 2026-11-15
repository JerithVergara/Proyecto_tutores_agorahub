-- Supabase Auth conserva el hash de contraseña en auth.users.
-- agorahub.users solo guarda el perfil de aplicación y referencia el mismo UUID.

SET search_path TO agorahub, public;

ALTER TABLE users
    ALTER COLUMN password_hash DROP NOT NULL;

COMMENT ON COLUMN users.password_hash IS
    'No se usa para autenticación. Las credenciales son administradas por Supabase Auth en auth.users.';