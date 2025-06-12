const express = require('express');
const db = require('./db');
const kafka = require('./kafka');

const app = express();
app.use(express.json());

app.post('/tenants', async (req, res) => {
    const { tenantId, createdBy, address} = req.body;
    if (!tenantId || !/^[a-z0-9_]+$/.test(tenantId)) {
        return res.status(400).send('Invalid tenantId. Use lowercase letters, numbers, and underscores only.');
    }

    try {
        await db.query('INSERT INTO tenants (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING', [tenantId]);

        await kafka.sendTenantCreatedEvent(tenantId, createdBy, address || 'system');
        //await kafka.sendTenantCreatedEvent(tenantId);
        
        res.status(202).send({ message: `Tenant creation request for '${tenantId}' accepted.` });
    } catch (err) {
        console.error('Error creating tenant:', err);
        res.status(500).send('Failed to accept tenant creation request.');
    }
});
app.delete('/tenants/:tenantId', async (req, res) => {
    const { tenantId } = req.params;

    try {
        const result = await db.query('DELETE FROM tenants WHERE tenant_id = $1', [tenantId]);

        if (result.rowCount === 0) {
            return res.status(404).send({ error: `Tenant '${tenantId}' not found.` });
        }

        await kafka.sendTenantDeletedEvent(tenantId);

        res.status(202).send({ message: `Tenant '${tenantId}' deletion accepted.` });
    } catch (err) {
        console.error(`Error deleting tenant '${tenantId}':`, err);
        res.status(500).send('Failed to accept tenant deletion request.');
    }
});

app.put('/tenants/:tenantId', async (req, res) => {
    const { tenantId: oldTenantId } = req.params;
    const { newTenantId } = req.body;

    if (!newTenantId || !/^[a-z0-9_]+$/.test(newTenantId)) {
        return res.status(400).send('Invalid newTenantId provided.');
    }
    if (oldTenantId === newTenantId) {
        return res.status(400).send('New tenant ID cannot be the same as the old one.');
    }

    try {
        const result = await db.query('UPDATE tenants SET tenant_id = $1 WHERE tenant_id = $2', [newTenantId, oldTenantId]);

        if (result.rowCount === 0) {
            return res.status(404).send({ error: `Tenant '${oldTenantId}' not found.` });
        }

        // Step 2: Publish the event.
        await kafka.sendTenantRenamedEvent(oldTenantId, newTenantId);

        res.status(202).send({ message: `Tenant rename from '${oldTenantId}' to '${newTenantId}' accepted.` });
    } catch (err) {
        // Handle potential unique constraint violation if the new name already exists
        if (err.code === '23505') { // unique_violation
            return res.status(409).send({ error: `Tenant ID '${newTenantId}' already exists.` });
        }
        console.error(`Error renaming tenant '${oldTenantId}':`, err);
        res.status(500).send('Failed to accept tenant rename request.');
    }
});
const PORT = 3000;
const startServer = async () => {
    await kafka.connect();
    app.listen(PORT, () => {
      console.log(`Tenant Manager service listening on port ${PORT}`);
    });

    process.on('SIGINT', async () => {
        await kafka.disconnect();
        process.exit(0);
    });
};

startServer();
