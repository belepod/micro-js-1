const express = require('express');
const db = require('./db');
const kafka = require('./kafka');
const { reconcileTenantSchema } = require('./kafka');

const app = express();
app.use(express.json());

app.get('/users', async (req, res) => {
    const tenantId = req.headers['x-tenant-id'];
    if (!tenantId) {
        return res.status(400).send('X-Tenant-ID header is required.');
    }
    try {
        const { rows } = await db.query(tenantId, 'SELECT user_id, username FROM survey_users');
        res.status(200).json(rows);
    } catch (err) {
        console.error(err);
        if (err.code === '42P01') {
            return res.status(404).send({ error: `Tenant '${tenantId}' does not exist.` });
        }
        res.status(500).send('Error fetching users');
    }
});

app.post('/admin/reconcile', async (req, res) => {
    console.log('[Admin] Received request to reconcile all tenants...');
    
    const results = {
        successful: [],
        failed: []
    };

    try {
        const tenantsResult = await db.adminQuery(
            "SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname NOT IN ('public', 'root', 'information_schema') AND nspname NOT LIKE 'pg_%';"
        );
        const allTenants = tenantsResult.rows.map(r => r.nspname);
        
        if (allTenants.length === 0) {
            return res.status(200).json({ message: 'No tenants found to reconcile.' });
        }

        console.log(`[Admin] Found ${allTenants.length} tenants. Starting reconciliation loop.`);

        for (const tenantId of allTenants) {
            try {
                await reconcileTenantSchema(tenantId);
                results.successful.push(tenantId);
            } catch (err) {
                console.error(`[Admin] FAILED to reconcile tenant '${tenantId}':`, err.message);
                results.failed.push({ tenantId: tenantId, error: err.message });
            }
        }

        console.log('[Admin] Reconciliation process complete.');
        res.status(200).json({
            status: results.failed.length > 0 ? 'Completed with errors' : 'Completed successfully',
            ...results
        });

    } catch (err) {
        console.error('[Admin] A critical error occurred during the reconciliation process:', err);
        res.status(500).send({ error: 'A critical error stopped the reconciliation process.' });
    }
});


const PORT = 3000;
const startServer = async () => {
    await kafka.connect();
    app.listen(PORT, () => {
      console.log(`Survey service listening on port ${PORT}`);
    });

    process.on('SIGINT', async () => {
        await kafka.disconnect();
        process.exit(0);
    });
};

startServer();
