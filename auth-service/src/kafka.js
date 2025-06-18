const { Kafka } = require('kafkajs');
const { SchemaRegistry } = require('@kafkajs/confluent-schema-registry');
const { randomUUID } = require('crypto');
const bcrypt = require('bcrypt'); // <-- Import bcrypt
const db = require('./db');
const axios = require('axios');
const { generateInsertQuery } = require('./db');

const pendingRequests = new Map();

const SERVICE_NAME = 'auth-service';

const kafka = new Kafka({
  clientId: SERVICE_NAME,
  brokers: [process.env.KAFKA_BROKER],
});

const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: `${SERVICE_NAME}-group` });

const registry = new SchemaRegistry({ host: process.env.SCHEMA_REGISTRY_URL });
const fs = require('fs');
const path = require('path');

const userCreatedSchema = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../avro-schemas/user-created.avsc'), 'utf-8')
);

const tenantCreatedSchema = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../avro-schemas/tenant-created.avsc'), 'utf-8')
);
const TENANT_CREATED_TOPIC = 'tenant-created';
const TENANT_DELETED_TOPIC = 'tenant-deleted';
const TENANT_RENAMED_TOPIC = 'tenant-renamed';
const USER_CREATED_TOPIC = 'user-created';
const REPLY_TOPIC = 'processing-status';


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

    return `CREATE TABLE IF NOT EXISTS ${db.escapeIdentifier(table_name)} (${columnParts.join(', ')});`;
}

async function reconcileTenantSchema(tenantId) {
    console.log(`[Reconciler] Starting schema reconciliation for tenant: ${tenantId}`);
    const safeTenantId = db.escapeIdentifier(tenantId);
    
    await db.adminQuery(`CREATE SCHEMA IF NOT EXISTS ${safeTenantId}`);
    
    const desiredTablesResult = await db.query('root', 'SELECT * FROM root.schema_tables', []);
    const desiredColumnsResult = await db.query('root', 'SELECT * FROM root.schema_columns ORDER BY id', []);

    const schemaDefinition = desiredTablesResult.rows.map(table => ({
        ...table,
        columns: desiredColumnsResult.rows.filter(c => c.table_name === table.table_name)
    }));

    const actualTablesResult = await db.adminQuery("SELECT table_name FROM information_schema.tables WHERE table_schema = $1", [tenantId]);
    const actualTables = new Set(actualTablesResult.rows.map(r => r.table_name));

    for (const tableDef of schemaDefinition) {
        if (!actualTables.has(tableDef.table_name)) {
            const createSql = buildCreateTableSql(tableDef);
            await db.query(tenantId, createSql, []);
            console.log(`> [Reconciler] CREATED missing table '${tableDef.table_name}' for tenant '${tenantId}'.`);
        } else {
            const actualColsResult = await db.adminQuery("SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2", [tenantId, tableDef.table_name]);
            const actualCols = new Set(actualColsResult.rows.map(r => r.column_name));
            const desiredCols = new Set(tableDef.columns.map(c => c.column_name));

            for (const col of tableDef.columns) {
                if (!actualCols.has(col.column_name)) {
                    const addColSql = `ALTER TABLE ${safeTenantId}.${db.escapeIdentifier(col.table_name)} ADD COLUMN ${db.escapeIdentifier(col.column_name)} ${col.data_type};`;
                    await db.adminQuery(addColSql);
                    console.log(`> [Reconciler] ADDED missing column '${col.column_name}' to table '${col.table_name}' for tenant '${tenantId}'.`);
                }
            }
            for (const colName of actualCols) {
                if (!desiredCols.has(colName)) {
                     const dropColSql = `ALTER TABLE ${safeTenantId}.${db.escapeIdentifier(tableDef.table_name)} DROP COLUMN ${db.escapeIdentifier(colName)};`;
                     await db.adminQuery(dropColSql);
                     console.log(`> [Reconciler] DROPPED extra column '${colName}' from table '${tableDef.table_name}' for tenant '${tenantId}'.`);
                }
            }
        }
    }
    console.log(`[Reconciler] Finished schema reconciliation for tenant: ${tenantId}`);
}
const connect = async () => {
  await producer.connect();
  await consumer.connect();
  
  await consumer.subscribe({ 
    topics: [
      TENANT_CREATED_TOPIC, 
      TENANT_DELETED_TOPIC, 
      TENANT_RENAMED_TOPIC, 
      REPLY_TOPIC,
    ], 
    fromBeginning: true 
  });

  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      const event = await registry.decode(message.value).catch(e => console.error(e));
      if (!event) return;

      if (topic === TENANT_CREATED_TOPIC) {
        const { tenantId, initialUsername, initialPassword } = event;
        console.log(`[${SERVICE_NAME}] Received tenant-created event for: ${tenantId}`);

        try {
          await reconcileTenantSchema(event.tenantId);

          if (initialUsername && initialPassword) {
            const saltRounds = 10;
            const hashedPassword = await bcrypt.hash(initialPassword, saltRounds);
            const insertSuperuserSql = 'INSERT INTO superusers (username, password) VALUES ($1, $2)';
            await db.query(tenantId, insertSuperuserSql, [initialUsername, hashedPassword]);
            console.log(`> Initial superuser '${initialUsername}' created for tenant '${tenantId}'.`);
          }
        } catch (err) {
          console.error(`[${SERVICE_NAME}] FAILED to provision schema/user for tenant ${tenantId}:`, err);
        }   }

      if (topic === TENANT_DELETED_TOPIC) {
        const { tenantId } = event;
        console.log(`[Auth Service] Received tenant-deleted event for: ${tenantId}`);
        try {
            const safeTenantId = db.escapeIdentifier(tenantId);
            await db.adminQuery(`DROP SCHEMA IF EXISTS ${safeTenantId} CASCADE`);
            console.log(`[Auth Service] Schema for tenant '${tenantId}' deleted.`);
        } catch (err) {
            console.error(`[Auth Service] Failed to delete schema for tenant ${tenantId}:`, err);
        }
        return;
      }
      
      // --- Handle Tenant Renaming ---
      if (topic === TENANT_RENAMED_TOPIC) {
        const { oldTenantId, newTenantId } = event;
        console.log(`[Auth Service] Received tenant-renamed event from '${oldTenantId}' to '${newTenantId}'`);
        try {
            const safeOldId = db.escapeIdentifier(oldTenantId);
            const safeNewId = db.escapeIdentifier(newTenantId);
            await db.adminQuery(`ALTER SCHEMA ${safeOldId} RENAME TO ${safeNewId}`);
            console.log(`[Auth Service] Schema for tenant '${oldTenantId}' renamed to '${newTenantId}'.`);
        } catch (err) {
            console.error(`[Auth Service] Failed to rename schema for tenant ${oldTenantId}:`, err);
        }
        return;
      }

      if (topic === REPLY_TOPIC) {
        const { correlationId, status } = event;
        if (pendingRequests.has(correlationId)) {
          const { res, timeout } = pendingRequests.get(correlationId);
          clearTimeout(timeout);
          
          if (status === 'SUCCESS') {
            res.status(201).json({ status: 'Completed', message: 'User created successfully in all services.' });
          } else {
            res.status(500).json({ status: 'Failed', message: 'User creation failed in a downstream service.' });
          }
          pendingRequests.delete(correlationId);
        }
      }
    },
  });
};

const disconnect = async () => {
  await producer.disconnect();
  await consumer.disconnect();
};

const sendUserCreationRequest = async (tenantId, newUser, res) => {
  const correlationId = randomUUID();

  const timeout = setTimeout(() => {
    if (pendingRequests.has(correlationId)) {
      console.log(`[Auth Service] Request ${correlationId} timed out.`);
      res.status(504).send({ error: 'Request timed out waiting for downstream service confirmation.' });
      pendingRequests.delete(correlationId);
    }
  }, 15000);

  pendingRequests.set(correlationId, { res, timeout });


    const message = {
    tenantId,
    userId: newUser.id,
    username: newUser.username,
    correlationId,
    replyTopic: REPLY_TOPIC,
  };
  
  // Get the ID for our schema from the registry.
  const { id: schemaId } = await registry.register(
    { type: 'AVRO', schema: JSON.stringify(userCreatedSchema) },
    { subject: `${USER_CREATED_TOPIC}-value` }
  );

  // ENCODE the message before sending.
  const encodedPayload = await registry.encode(schemaId, message);

  await producer.send({
    topic: USER_CREATED_TOPIC,
    messages: [{ value: encodedPayload }],
  });
  console.log(`[Auth Service] Sent ENCODED user-creation request for ${newUser.username} using new 'userId' field`);
};

module.exports = { connect, disconnect, sendUserCreationRequest, reconcileTenantSchema, buildCreateTableSql };
