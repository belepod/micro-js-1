const express = require('express');
const db = require('./db');
const kafka = require('./kafka');

const app = express();
app.use(express.json());

app.post('/tenants', async (req, res) => {
    const { tenantId } = req.body;
    if (!tenantId || !/^[a-z0-9_]+$/.test(tenantId)) {
        return res.status(400).send('Invalid tenantId. Use lowercase letters, numbers, and underscores only.');
    }

    try {
        // Step 1: Save the tenant to its own database.
        await db.query('INSERT INTO tenants (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING', [tenantId]);

        // Step 2: Publish a generic event. The manager's job is done.
        await kafka.sendTenantCreatedEvent(tenantId);
        
        res.status(202).send({ message: `Tenant creation request for '${tenantId}' accepted and is being processed.` });
    } catch (err) {
        console.error('Error creating tenant:', err);
        res.status(500).send('Failed to accept tenant creation request.');
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
