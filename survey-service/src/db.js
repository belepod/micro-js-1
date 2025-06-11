const { Pool } = require('pg');

const pool = new Pool({
  user: process.env.POSTGRES_USER,
  host: process.env.POSTGRES_HOST,
  database: process.env.POSTGRES_DB,
  password: process.env.POSTGRES_PASSWORD,
  port: 5432,
});

const escapeIdentifier = (str) => `"${str.replace(/"/g, '""')}"`;

const query = async (tenantId, text, params) => {
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO ${escapeIdentifier(tenantId)}, public`);
    return await client.query(text, params);
  } finally {
    client.release();
  }
};

const adminQuery = (text, params) => {
    return pool.query(text, params);
};

module.exports = {
  query,
  adminQuery,
  escapeIdentifier,
};
