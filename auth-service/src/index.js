const express = require('express');
const db = require('./db');
const kafka = require('./kafka');
const { reconcileTenantSchema } = require('./kafka');

const app = express();
app.use(express.json());

app.post('/register', async (req, res) => {
  const tenantId = req.headers['x-tenant-id'];
  if (!tenantId) {
      return res.status(400).send('X-Tenant-ID header is required.');
  }

  const { username, password, name } = req.body;
  if (!username || !password) {
    return res.status(400).send('Username and password are required');
  }

  try {
    const result = await db.query(tenantId,
      'INSERT INTO users(username, password) VALUES($1, $2) RETURNING id, username',
      [username, password]
    );
    const newUser = result.rows[0];

    // Call the request-reply function. It will handle the response.
    await kafka.sendUserCreationRequest(tenantId, newUser, res);
    
    // DO NOT send a response here. kafka.js will do it when the reply arrives.

  } catch (err) {
    console.error(`Error registering user for tenant ${tenantId}:`, err);
    if (err.code === '42P01') { 
        return res.status(404).send({ error: `Tenant '${tenantId}' does not exist.` });
    }
    res.status(500).send('Error registering user');
  }
});

app.get('/users', async (req, res) => {
    const tenantId = req.headers['x-tenant-id'];
    if (!tenantId) {
        return res.status(400).send('X-Tenant-ID header is required.');
    }
    try {
        const { rows } = await db.query(tenantId, 'SELECT id, username FROM users');
        res.status(200).json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Error fetching users');
    }
});

app.post('/admin/migrations/run', async (req, res) => {
    // SECURITY In a real-world application, this endpoint MUST be protected
    // and only accessible to administrators.
    try {
        // This just publishes the event. The actual work happens in the consumer.
        await kafka.sendMigrationEvent();
        res.status(202).send({ 
            message: "Database migration process for all tenants has been initiated. Check service logs for progress." 
        });
    } catch (err) {
        console.error("Failed to trigger migration event:", err);
        res.status(500).send({ error: "Could not start migration process." });
    }
});

// The single, powerful endpoint
app.post('/admin/migrations/run-task', async (req, res) => {
    // This endpoint now acts as a simple gateway to publish the task event.
    // The real work happens in the consumer.
    // NOTE: Add validation here to ensure the payload is well-formed.
    const taskPayload = req.body;
    try {
        await kafka.sendDbTaskEvent(taskPayload);
        res.status(202).send({ message: `DB Task of type '${taskPayload.taskType}' has been initiated. Check service logs.` });
    } catch (err) {
        console.error("Failed to trigger DB Task event:", err);
        res.status(500).send({ error: "Could not start DB Task process." });
    }
});

// --- NEW DIRECT AND SYNCHRONOUS RECONCILIATION ENDPOINT ---
app.post('/admin/reconcile-all-tenants', async (req, res) => {
    // In a real app, this MUST be protected by strong admin authentication.
    console.log('[Admin] Received request to reconcile all tenants...');
    
    const results = {
        successful: [],
        failed: []
    };

    try {
        // Step 1: Get all tenant schemas directly from this service's database.
        // This query finds all schemas that are not system-managed.
        const tenantsResult = await db.adminQuery(
            "SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname NOT IN ('public', 'root', 'information_schema') AND nspname NOT LIKE 'pg_%';"
        );
        const allTenants = tenantsResult.rows.map(r => r.nspname);
        
        if (allTenants.length === 0) {
            return res.status(200).json({ message: 'No tenants found to reconcile.' });
        }

        console.log(`[Admin] Found ${allTenants.length} tenants. Starting reconciliation loop.`);

        // Step 2: Loop through each tenant and run the reconciliation sequentially.
        // A for...of loop is used to handle async/await correctly one-by-one.
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
        // Step 3: Return a detailed report.
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
      console.log(`Auth service listening on port ${PORT}`);
    });

    process.on('SIGINT', async () => {
        await kafka.disconnect();
        process.exit(0);
    });
};

startServer();
