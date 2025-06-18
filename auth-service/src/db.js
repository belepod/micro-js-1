const { Pool } = require('pg');

const pool = new Pool({
  user: process.env.POSTGRES_USER,
  host: process.env.POSTGRES_HOST,
  database: process.env.POSTGRES_DB,
  password: process.env.POSTGRES_PASSWORD,
  port: 5432,
});

function escapeIdentifier(str) {
  return '"' + str.replace(/"/g, '""') + '"';
}

async function query(tenantId, sql, params) {
  if (!tenantId) {
    throw new Error('A tenantId is required for tenant-specific queries.');
  }

  const client = await pool.connect();
  try {
    const safeTenantId = escapeIdentifier(tenantId);
    await client.query(`SET search_path TO ${safeTenantId}, public;`);
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

async function adminQuery(sql, params) {
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

module.exports = {
  query,
  adminQuery,
  escapeIdentifier,
  pool,
};
