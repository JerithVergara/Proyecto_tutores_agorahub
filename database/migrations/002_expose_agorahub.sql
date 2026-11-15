-- El backend usa PostgREST con el esquema agorahub.

GRANT USAGE ON SCHEMA agorahub TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA agorahub TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA agorahub TO service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA agorahub
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA agorahub
    GRANT USAGE, SELECT ON SEQUENCES TO service_role;

-- Agrega el esquema al conjunto que PostgREST puede exponer y recarga su configuración.
ALTER ROLE authenticator SET pgrst.db_schemas = 'public, graphql_public, agorahub';
NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';