const express = require('express');
const db = require('./db');
const schemaConfig = require('./schemas.json');

const app = express();
app.use(express.json());

app.post('/tenants', async (req, res) => {
    const { tenantId } = req.body;
    if (!tenantId || !/^[a-z0-9_]+$/.test(tenantId)) {
        return res.status(400).send('Invalid tenantId. Use lowercase letters, numbers, and underscores only.');
    }

    try {
        // Record the tenant in a central location (we'll use the auth-db's public schema for this)
        const authDbPool = db.getPool('auth-db', 'auth_db');
        await authDbPool.query('INSERT INTO public.tenants (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING', [tenantId]);

        // Use Promise.all to create schemas in all service databases concurrently
        const schemaCreationPromises = schemaConfig.services.map(async (service) => {
            const pool = db.getPool(service.db_host, service.db_name);
            const client = await pool.connect();
            const safeTenantId = db.escapeIdentifier(tenantId);
            
            try {
                // Important: Use a transaction to ensure both schema and table are created or neither are.
                await client.query('BEGIN');
                await client.query(`CREATE SCHEMA IF NOT EXISTS ${safeTenantId}`);
                await client.query(`SET search_path TO ${safeTenantId}`);
                await client.query(service.ddl);
                await client.query('COMMIT');
                console.log(`Successfully provisioned schema for tenant '${tenantId}' in service '${service.name}'`);
            } catch (err) {
                await client.query('ROLLBACK');
                console.error(`Failed to provision schema for tenant '${tenantId}' in service '${service.name}'`, err);
                throw new Error(`Failed to provision for service: ${service.name}`);
            } finally {
                client.release();
            }
        });

        await Promise.all(schemaCreationPromises);

        res.status(201).send({ message: `Tenant '${tenantId}' provisioned successfully across all services.` });
    } catch (err) {
        console.error('Error during tenant provisioning:', err);
        res.status(500).send({ error: 'Failed to provision tenant.', details: err.message });
    }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Tenant Manager service listening on port ${PORT}`);
});
