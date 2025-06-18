const express = require('express');
const db = require('./db');
const bcrypt = require('bcrypt');
const kafka = require('./kafka');
const { reconcileTenantSchema } = require('./kafka');
const {sendUserCreationRequest} = require('./kafka')
const { buildDynamicInsertQuery } = require('./dbUtils');

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.send(`Auth Service v${pjson.version}`);
});

app.post('/register', async (req, res) => {
  const tenantId = req.headers['x-tenant-id'];
  if (!tenantId) {
    return res.status(400).json({ error: 'X-Tenant-ID header is required.' });
  }

  const requestData = { ...req.body };

  if (!requestData.username || !requestData.password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  try {
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(requestData.password, saltRounds);
    requestData.password = hashedPassword;
    
    const { sql, values } = await buildDynamicInsertQuery(tenantId, 'users', requestData);

    const { rows } = await db.query(tenantId, sql, values);

    const newUser = rows[0];
    delete newUser.password;

    res.status(201).json(newUser);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Username already exists.' });
    }
    console.error(`Registration failed for tenant ${tenantId}:`, err);
    res.status(500).json({ error: 'Registration failed.', details: err.message });
  }
});

app.post('/tables/:tableName/rows', async (req, res) => {
  const { tableName } = req.params;
  const tenantId = req.headers['x-tenant-id'];

  if (!tenantId) {
    return res.status(400).json({ error: 'X-Tenant-ID header is required.' });
  }

  const requestData = { ...req.body };

  try {
    if (requestData.password) {
      const saltRounds = 10;
      const hashedPassword = await bcrypt.hash(requestData.password, saltRounds);
      requestData.password = hashedPassword;
    }
    
    const { sql, values } = await buildDynamicInsertQuery(tenantId, tableName, requestData);
    
    const { rows } = await db.query(tenantId, sql, values);

    const newRow = rows[0];
    if (newRow.password) {
        delete newRow.password;
    }

    res.status(201).json(newRow);
  } catch (err) {
    if (err.code === '23505') { // Handles UNIQUE constraint violations
      return res.status(409).json({ error: `A record with one of the unique fields already exists in table '${tableName}'.` });
    }
    console.error(`Insert failed for tenant ${tenantId}, table ${tableName}:`, err);
    res.status(500).json({ error: 'Insert failed.', details: err.message });
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


app.post('/admin/reconcile-all-tenants', async (req, res) => {
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
      console.log(`Auth service listening on port ${PORT}`);
    });

    process.on('SIGINT', async () => {
        await kafka.disconnect();
        process.exit(0);
    });
};

startServer();
