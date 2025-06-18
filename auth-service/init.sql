CREATE SCHEMA IF NOT EXISTS root;

CREATE TABLE root.schema_tables (
    table_name VARCHAR(63) PRIMARY KEY,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE root.schema_columns (
    id SERIAL PRIMARY KEY,
    table_name VARCHAR(63) REFERENCES root.schema_tables(table_name) ON DELETE CASCADE,
    column_name VARCHAR(63) NOT NULL,
    data_type VARCHAR(100) NOT NULL,
    is_nullable BOOLEAN DEFAULT TRUE,
    "default" VARCHAR(255),
    is_primary_key BOOLEAN DEFAULT FALSE,
    is_unique BOOLEAN DEFAULT FALSE,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(table_name, column_name)
);

INSERT INTO root.schema_tables (table_name, description) VALUES ('users', 'Standard application users for a tenant.');
INSERT INTO root.schema_columns (table_name, column_name, data_type, is_nullable, is_primary_key) VALUES ('users', 'id', 'SERIAL', false, true);
INSERT INTO root.schema_columns (table_name, column_name, data_type, is_nullable, is_unique) VALUES ('users', 'username', 'VARCHAR(255)', false, true);
INSERT INTO root.schema_columns (table_name, column_name, data_type, is_nullable) VALUES ('users', 'password', 'VARCHAR(255)', false);

INSERT INTO root.schema_tables (table_name, description) VALUES ('superusers', 'Tenant-level administrative users.');
INSERT INTO root.schema_columns (table_name, column_name, data_type, is_nullable, is_primary_key) VALUES ('superusers', 'id', 'SERIAL', false, true);
INSERT INTO root.schema_columns (table_name, column_name, data_type, is_nullable, is_unique) VALUES ('superusers', 'username', 'VARCHAR(255)', false, true);
INSERT INTO root.schema_columns (table_name, column_name, data_type, is_nullable) VALUES ('superusers', 'password', 'VARCHAR(255)', false);
