const express = require('express');
const db = require('./db');
const kafka = require('./kafka');

const app = express();
app.use(express.json());

app.post('/register', async (req, res) => {
  const tenantId = req.headers['x-tenant-id'];
  if (!tenantId) {
    return res.status(400).send('X-Tenant-ID header is required.');
  }

  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).send('Username and password are required');
  }

  try {
    const result = await db.query(tenantId,
      'INSERT INTO users(username, password) VALUES($1, $2) RETURNING id, username',
      [username, password]
    );
    const newUser = result.rows[0];

    // Fire and forget
    await kafka.sendUserCreatedEvent(tenantId, newUser);
    
    // Immediately respond with 202 Accepted.
    res.status(202).json({ 
        status: "Pending", 
        message: "User registration accepted and is being processed.",
        user: newUser 
    });

  } catch (err) {
    console.error(`Error registering user for tenant ${tenantId}:`, err);
    if (err.code === '42P01') { 
        return res.status(404).send({ error: `Tenant '${tenantId}' does not exist.` });
    }
    res.status(500).send('Error registering user');
  }
});

// ... (GET /users and startServer remain the same) ...
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

    process.on('SIGINT', async () => {
        await kafka.disconnect();
        process.exit(0);
    });
};

startServer();
