const express = require('express');
const db = require('./db');
const { sendMessage } = require('./producer');

const app = express();
app.use(express.json());

const USER_CREATED_TOPIC = 'user-created';

// Endpoint to register a new user
app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).send('Username and password are required');
  }

  try {
    // Note: In a real app, hash the password!
    const result = await db.query(
      'INSERT INTO users(username, password) VALUES($1, $2) RETURNING id, username',
      [username, password]
    );
    const newUser = result.rows[0];

    // Send a message to Kafka
    await sendMessage(USER_CREATED_TOPIC, {
      id: newUser.id,
      username: newUser.username,
    });
    
    res.status(201).json(newUser);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error registering user');
  }
});

// Endpoint to see users in its own DB
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
app.listen(PORT, () => {
  console.log(`Auth service listening on port ${PORT}`);
});
