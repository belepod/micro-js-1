const { Pool } = require('pg');

const pool = new Pool({
  user: process.env.POSTGRES_USER,
  host: process.env.POSTGRES_HOST,
  database: process.env.POSTGRES_DB,
  password: process.env.POSTGRES_PASSWORD,
  port: 5432,
});

// A safe way to get a quoted identifier for schema/table names
const escapeIdentifier = (str) => `"${str.replace(/"/g, '""')}"`;

// The query function is now tenant-aware. It uses `search_path`.
const query = async (tenantId, text, params) => {
  const client = await pool.connect();
  try {
    // Setting search_path is the safest way to work with per-tenant schemas
    // It tells Postgres where to look for tables for the duration of the transaction.
    await client.query(`SET search_path TO ${escapeIdentifier(tenantId)}, public`);
    return await client.query(text, params);
  } finally {
    client.release();
  }
};

// A special function for administrative tasks that don't need a tenant context
const adminQuery = (text, params) => {
    return pool.query(text, params);
};


module.exports = {
  query,
  adminQuery,
  escapeIdentifier,
};
