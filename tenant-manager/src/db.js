const { Pool } = require('pg');

const pools = {}; // A map to hold a connection pool for each service DB

const getPool = (dbHost, dbName) => {
    const key = `${dbHost}-${dbName}`;
    if (!pools[key]) {
        console.log(`Creating new connection pool for ${key}`);
        pools[key] = new Pool({
            user: process.env.POSTGRES_USER,
            host: dbHost,
            database: dbName,
            password: process.env.POSTGRES_PASSWORD,
            port: 5432,
        });
    }
    return pools[key];
};

const escapeIdentifier = (str) => `"${str.replace(/"/g, '""')}"`;

module.exports = { getPool, escapeIdentifier };
