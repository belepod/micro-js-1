const express = require('express');
const db = require('./db');
const kafka = require('./kafka');

const app = express();
app.use(express.json());

// --- NEW ENDPOINT: Register a new Tenant ---
app.post('/tenants', async (req, res) => {
    const { tenantId } = req.body;
    if (!tenantId || !/^[a-z0-9_]+$/.test(tenantId)) {
        return res.status(400).send('Invalid tenantId. Use lowercase letters, numbers, and underscores only.');
    }

    try {
        // Create the schema and the users table within it
        const safeTenantId = db.escapeIdentifier(tenantId);
        const createUserTableSql = `
            CREATE TABLE users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `;
        await db.adminQuery(`CREATE SCHEMA IF NOT EXISTS ${safeTenantId}`);
        await db.query(tenantId, createUserTableSql, []); // Use the new tenant-aware query
        
        // Record the tenant in our public tenants table
        await db.adminQuery('INSERT INTO public.tenants (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING', [tenantId]);

        // Publish an event so other services can create their schemas
        await kafka.sendTenantCreationEvent(tenantId);
        
        res.status(201).send({ message: `Tenant '${tenantId}' created successfully.` });
    } catch (err) {
        console.error('Error creating tenant:', err);
        res.status(500).send('Failed to create tenant.');
    }
});


// --- UPDATED ENDPOINT: Register a user for a specific tenant ---
app.post('/register', async (req, res) => {
  const tenantId = req.headers['x-tenant-id']; // <-- Get tenant from header
  if (!tenantId) {
      return res.status(400).send('X-Tenant-ID header is required.');
  }

  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).send('Username and password are required');
  }

  try {
    // Use the tenant-aware query function
    const result = await db.query(tenantId,
      'INSERT INTO users(username, password) VALUES($1, $2) RETURNING id, username',
      [username, password]
    );
    const newUser = result.rows[0];

    await kafka.sendUserCreationRequest(tenantId, newUser, res);
  } catch (err) {
    console.error(`Error registering user for tenant ${tenantId}:`, err);
    // Check for specific error, like schema not existing
    if (err.code === '42P01') { // undefined_table or wrong_object_type
        return res.status(404).send({ error: `Tenant '${tenantId}' does not exist.` });
    }
    res.status(500).send('Error registering user');
  }
});

// --- UPDATED ENDPOINT: Get users for a tenant ---
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
const PORT = 3000;
const startServer = async () => {
    await kafka.connect();
    app.listen(PORT, () => {
      console.log(`Auth service listening on port ${PORT}`);
    });

    // Graceful shutdown
    process.on('SIGINT', async () => {
        await kafka.disconnect();
        process.exit(0);
    });
};

startServer();
