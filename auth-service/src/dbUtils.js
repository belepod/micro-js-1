const db = require('./db');

async function buildDynamicInsertQuery(tenantId, tableName, data) {
  const schemaColumnsResult = await db.query(
    'root',
    'SELECT column_name FROM root.schema_columns WHERE table_name = $1',
    [tableName]
  );

  const allowedColumns = new Set(schemaColumnsResult.rows.map(r => r.column_name));
  
  const columnsToInsert = [];
  const valuesToInsert = [];

  for (const key in data) {
    if (allowedColumns.has(key)) {
      columnsToInsert.push(key);
      valuesToInsert.push(data[key]);
    }
  }

  if (columnsToInsert.length === 0) {
    throw new Error('No valid columns to insert. The provided data does not match the table schema.');
  }
  
  const escapedTableName = db.escapeIdentifier(tableName);
  const escapedColumnNames = columnsToInsert.map(col => db.escapeIdentifier(col)).join(', ');
  const placeholders = columnsToInsert.map((_, i) => `$${i + 1}`).join(', ');

  const sql = `INSERT INTO ${escapedTableName} (${escapedColumnNames}) VALUES (${placeholders}) RETURNING *;`;

  return {
    sql,
    values: valuesToInsert
  };
}

module.exports = { buildDynamicInsertQuery };
