-- This script will be run by the tenant-db container on startup.
-- It creates the tenants table with all the required fields.

DROP TABLE IF EXISTS tenants;

CREATE TABLE tenants (
    tenant_id VARCHAR(50) PRIMARY KEY,
    organization_name VARCHAR(255) NOT NULL,
    logo_url VARCHAR(512),
    subdomain VARCHAR(100) UNIQUE,
    address TEXT,
    timezone VARCHAR(100),
    currency CHAR(3),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Optional: You can pre-populate with a test tenant if you wish
-- INSERT INTO tenants (tenant_id, organization_name) VALUES ('acme_corp', 'ACME Corporation');
