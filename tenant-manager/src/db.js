const { Pool } = require('pg');

// Create a single connection pool for the tenant_manager's own database.
const pool = new Pool({
  user: process.env.POSTGRES_USER,
  host: process.env.POSTGRES_HOST,
  database: process.env.POSTGRES_DB,
  password: process.env.POSTGRES_PASSWORD,
  port: 5432,
});

// Export a 'query' function and the 'pool' itself so we can get clients for transactions.
module.exports = {
  query: (text, params) => pool.query(text, params),
  pool: pool // Export the pool object
};
