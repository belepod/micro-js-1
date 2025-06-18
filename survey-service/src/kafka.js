const { Kafka } = require('kafkajs');
const { SchemaRegistry } = require('@kafkajs/confluent-schema-registry');
const db = require('./db');
const axios = require('axios');

const kafka = new Kafka({
  clientId: 'survey-service',
  brokers: [process.env.KAFKA_BROKER],
});

const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: 'survey-group' });

const registry = new SchemaRegistry({ host: process.env.SCHEMA_REGISTRY_URL });


const fs = require('fs');
const path = require('path');


const processingStatusSchema = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../avro-schemas/processing-status.avsc'), 'utf-8')
);


const TENANT_CREATED_TOPIC = 'tenant-created';
const TENANT_DELETED_TOPIC = 'tenant-deleted';
const TENANT_RENAMED_TOPIC = 'tenant-renamed';
const USER_CREATED_TOPIC = 'user-created';



function buildCreateTableSql(tableDefinition) {
    const { table_name, columns } = tableDefinition;
    let primaryKeys = [];
    const columnParts = columns.map(col => {
        let part = `${db.escapeIdentifier(col.column_name)} ${col.data_type}`;
        if (!col.is_nullable) part += ' NOT NULL';
        if (col.default) part += ` DEFAULT ${col.default}`;
        if (col.is_unique) part += ' UNIQUE';
        if (col.is_primary_key) primaryKeys.push(db.escapeIdentifier(col.column_name));
        return part;
    });

    if (primaryKeys.length > 0) {
        columnParts.push(`PRIMARY KEY (${primaryKeys.join(', ')})`);
    }

    return `CREATE TABLE ${db.escapeIdentifier(table_name)} (${columnParts.join(', ')});`;
}


async function reconcileTenantSchema(tenantId) {
    console.log(`[Reconciler] Starting full schema reconciliation for tenant: ${tenantId}`);
    const safeTenantId = db.escapeIdentifier(tenantId);
    
    // 1. Ensure the tenant schema itself exists.
    await db.adminQuery(`CREATE SCHEMA IF NOT EXISTS ${safeTenantId}`);
    
    // 2. Fetch the DESIRED state from our 'root' schema.
    const tablesResult = await db.query('root', 'SELECT * FROM root.schema_tables', []);
    const columnsResult = await db.query('root', 'SELECT * FROM root.schema_columns ORDER BY id', []);
    
    const desiredTables = new Map(tablesResult.rows.map(table => [
        table.table_name, 
        { ...table, columns: columnsResult.rows.filter(c => c.table_name === table.table_name) }
    ]));

    // 3. Fetch the ACTUAL state from the live tenant's schema.
    const actualTablesResult = await db.adminQuery(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = $1",
        [tenantId]
    );
    const actualTables = new Set(actualTablesResult.rows.map(r => r.table_name));

    // --- RECONCILIATION LOGIC ---

    // A) Loop through what SHOULD exist (desired state).
    for (const [tableName, tableDef] of desiredTables.entries()) {
        if (!actualTables.has(tableName)) {
            // Table is missing, so create it completely.
            const createSql = buildCreateTableSql(tableDef);
            await db.query(tenantId, createSql, []);
            console.log(`> [Reconciler] CREATED missing table '${tableName}' for tenant '${tenantId}'.`);
        } else {
            // Table exists, so we must check its columns.
            const actualColsResult = await db.adminQuery(
                "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2",
                [tenantId, tableName]
            );
            const actualCols = new Set(actualColsResult.rows.map(r => r.column_name));
            const desiredCols = new Set(tableDef.columns.map(c => c.column_name));

            // Find and ADD missing columns.
            for (const colDef of tableDef.columns) {
                if (!actualCols.has(colDef.column_name)) {
                    const addColSql = `ALTER TABLE ${safeTenantId}.${db.escapeIdentifier(tableName)} ADD COLUMN ${db.escapeIdentifier(colDef.column_name)} ${colDef.data_type};`;
                    await db.adminQuery(addColSql);
                    console.log(`> [Reconciler] ADDED missing column '${colDef.column_name}' to table '${tableName}' for tenant '${tenantId}'.`);
                }
            }
            
            // Find and DROP extra columns.
            for (const colName of actualCols) {
                if (!desiredCols.has(colName)) {
                     const dropColSql = `ALTER TABLE ${safeTenantId}.${db.escapeIdentifier(tableName)} DROP COLUMN ${db.escapeIdentifier(colName)};`;
                     await db.adminQuery(dropColSql);
                     console.log(`> [Reconciler] DROPPED extra column '${colName}' from table '${tableName}' for tenant '${tenantId}'.`);
                }
            }
        }
    }
    
    // B) Loop through what ACTUALLY exists to find tables that need to be dropped.
    for (const tableName of actualTables) {
        if (!desiredTables.has(tableName)) {
            const dropTableSql = `DROP TABLE ${safeTenantId}.${db.escapeIdentifier(tableName)};`;
            await db.adminQuery(dropTableSql);
            console.log(`> [Reconciler] DROPPED extra table '${tableName}' from tenant '${tenantId}'.`);
        }
    }

    console.log(`[Reconciler] Finished schema reconciliation for tenant: ${tenantId}`);
}

const connect = async () => {
  await producer.connect();
  await consumer.connect();

  // Subscribe to all relevant topics
  await consumer.subscribe({ 
    topics: [
      TENANT_CREATED_TOPIC,
      TENANT_DELETED_TOPIC,
      TENANT_RENAMED_TOPIC,
      USER_CREATED_TOPIC
    ], 
    fromBeginning: true 
  });

  await consumer.run({
    eachMessage: async ({ topic, message }) => {
            let event;
      try {
        event = await registry.decode(message.value);
        if (!event) {
            console.log(`[Survey Service] Received empty message on topic ${topic}. Skipping.`);
            return;
        }
      } catch (e) {
        console.error(`[Survey Service] Failed to decode message on topic ${topic}:`, e);
        return;
      }
      if (topic === TENANT_CREATED_TOPIC) {
        const { tenantId } = event;
        console.log(`[Survey Service] Received tenant-created event for: ${tenantId}`);
        try {
                  await reconcileTenantSchema(event.tenantId);
        } catch (err) {
            console.error(`[Survey Service] Failed to provision schema for tenant ${tenantId}:`, err);
        }
        return;
      }

      if (topic === TENANT_DELETED_TOPIC) {
        const { tenantId } = event;
        console.log(`[Survey Service] Received tenant-deleted event for: ${tenantId}`);
        try {
            const safeTenantId = db.escapeIdentifier(tenantId);
            await db.adminQuery(`DROP SCHEMA IF EXISTS ${safeTenantId} CASCADE`);
            console.log(`[Survey Service] Schema for tenant '${tenantId}' deleted.`);
        } catch (err) {
            console.error(`[Survey Service] Failed to delete schema for tenant ${tenantId}:`, err);
        }
        return;
      }
      
      if (topic === TENANT_RENAMED_TOPIC) {
        const { oldTenantId, newTenantId } = event;
        console.log(`[Survey Service] Received tenant-renamed event from '${oldTenantId}' to '${newTenantId}'`);
        try {
            const safeOldId = db.escapeIdentifier(oldTenantId);
            const safeNewId = db.escapeIdentifier(newTenantId);
            await db.adminQuery(`ALTER SCHEMA ${safeOldId} RENAME TO ${safeNewId}`);
            console.log(`[Survey Service] Schema for tenant '${oldTenantId}' renamed to '${newTenantId}'.`);
        } catch (err) {
            console.error(`[Survey Service] Failed to rename schema for tenant ${oldTenantId}:`, err);
        }
        return;
      }

      if (topic === USER_CREATED_TOPIC) {
        const { tenantId, userId, username, correlationId, replyTopic } = event;
        let status = 'FAILURE';
        
        try {
          await db.query(tenantId, 'INSERT INTO survey_users(user_id, username) VALUES($1, $2)', [userId, username]);
          console.log(`[Survey Service] User ${username} processed successfully for tenant ${tenantId}.`);
          status = 'SUCCESS';
        } catch (err) {
          console.error(`[Survey Service] Failed to process user ${username} for tenant ${tenantId}`, err);
          status = 'FAILURE';
        }

                const replyMessage = { correlationId, status };
        
        const { id: schemaId } = await registry.register(
            { type: 'AVRO', schema: JSON.stringify(processingStatusSchema) },
            { subject: `${replyTopic}-value` } // e.g., 'processing-status-value'
        );
        
        const encodedReply = await registry.encode(schemaId, replyMessage);


        await producer.send({
            topic: replyTopic,
            messages: [{ value: encodedReply }]
        });
                console.log(`[Survey Service] Sent ENCODED reply for ${correlationId}`);
      }
    },
  });
};

const disconnect = async () => {
  await producer.disconnect();
  await consumer.disconnect();
};

module.exports = { connect, disconnect, reconcileTenantSchema, buildCreateTableSql  };
