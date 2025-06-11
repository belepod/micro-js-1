const express = require('express');
const db = require('./db');
const { runConsumer } = require('./consumer');

const app = express();
app.use(express.json());

// Endpoint to see users in its own DB
app.get('/users', async (req, res) => {
    try {
        const { rows } = await db.query('SELECT user_id, username FROM survey_users');
        res.status(200).json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Error fetching users');
    }
});

// Start the Kafka consumer
runConsumer().catch(console.error);

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Survey service listening on port ${PORT}`);
});
