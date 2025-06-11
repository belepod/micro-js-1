const express = require('express');
const db = require('./db');
const kafka = require('./kafka'); // Import the new kafka manager

const app = express();
app.use(express.json());

app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).send('Username and password are required');
  }

  try {
    const result = await db.query(
      'INSERT INTO users(username, password) VALUES($1, $2) RETURNING id, username',
      [username, password]
    );
    const newUser = result.rows[0];

    // Use the new Kafka function to handle the request-reply logic
    await kafka.sendUserCreationRequest(newUser, res);

    // IMPORTANT: We no longer send a response here. kafka.js handles it.
  } catch (err) {
    console.error(err);
    res.status(500).send('Error registering user');
  }
});

app.get('/users', async (req, res) => {
    try {
        const { rows } = await db.query('SELECT id, username FROM users');
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
