const express = require('express');
const db = require('./db');
const kafka = require('./kafka'); // Import the new kafka manager

const app = express();
app.use(express.json());

app.get('/users', async (req, res) => {
    try {
        const { rows } = await db.query('SELECT user_id, username FROM survey_users');
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
      console.log(`Survey service listening on port ${PORT}`);
    });

    // Graceful shutdown
    process.on('SIGINT', async () => {
        await kafka.disconnect();
        process.exit(0);
    });
};

startServer();
