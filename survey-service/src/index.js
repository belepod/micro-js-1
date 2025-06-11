const express = require('express');
const db = require('./db');
const kafka = require('./kafka');

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
