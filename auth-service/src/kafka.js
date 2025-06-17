const { Kafka } = require('kafkajs');
const { SchemaRegistry } = require('@kafkajs/confluent-schema-registry');
const { randomUUID } = require('crypto');
const bcrypt = require('bcrypt'); // <-- Import bcrypt
const db = require('./db');
const axios = require('axios');

const pendingRequests = new Map();

const kafka = new Kafka({
  clientId: 'auth-service',
  brokers: [process.env.KAFKA_BROKER],
});

const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: 'auth-group' });

const registry = new SchemaRegistry({ host: process.env.SCHEMA_REGISTRY_URL });
const fs = require('fs');
const path = require('path');

const userCreatedSchema = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../avro-schemas/user-created.avsc'), 'utf-8')
);
const migrationSchemaV2 = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../avro-schemas/auth-db-migration-v2.avsc'), 'utf-8')
);
const dbTaskRequestedSchema = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../avro-schemas/db-task-requested.avsc'), 'utf-8')
);

const MIGRATION_TOPIC_V2 = 'auth-db-migration-v2';
const TENANT_CREATED_TOPIC = 'tenant-created';
const TENANT_DELETED_TOPIC = 'tenant-deleted';
const TENANT_RENAMED_TOPIC = 'tenant-renamed';
const USER_CREATED_TOPIC = 'user-created';
const REPLY_TOPIC = 'processing-status';
const DB_TASK_REQUESTED_TOPIC = 'db-task-requested';


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


/**
 * The full, state-diffing reconciler. This function compares the desired state
 * in the 'root' schema with the actual state in the tenant's schema and
 * generates CREATE/ALTER/DROP statements to make them match.
 */
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
  
  await consumer.subscribe({ 
    topics: [
      TENANT_CREATED_TOPIC, 
      TENANT_DELETED_TOPIC, 
      TENANT_RENAMED_TOPIC, 
      REPLY_TOPIC,
      MIGRATION_TOPIC_V2,
      DB_TASK_REQUESTED_TOPIC
    ], 
    fromBeginning: true 
  });

  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      const event = await registry.decode(message.value).catch(e => console.error(e));
      if (!event) return;

      if (topic === TENANT_CREATED_TOPIC) {
        const { tenantId, initialUsername, initialPassword } = event;
        console.log(`[Auth Service] Received tenant-created event for: ${tenantId}`);

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
            console.error(`[Auth Service] FAILED to process tenant-created event for ${tenantId}. Reason:`, err);
        }
        return;
      }

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

      if (topic === MIGRATION_TOPIC_V2) {
        console.log('[Auth Service] Received request to start DB schema v2 migration.');
        try {
          // 1. Get all tenants from the tenant-manager
          const response = await axios.get(`${process.env.TENANT_MANAGER_URL}/tenants`);
          const allTenants = response.data; // This should be an array like ["acme", "stark"]
          console.log(`[Auth Service] Found ${allTenants.length} tenants to migrate.`);

          // 2. Loop through each tenant and apply the migration
          for (const tenantId of allTenants) {
            try {
              // Using "IF NOT EXISTS" makes the script safe to run multiple times (idempotent)
              const alterSql = `ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(255);`;
              await db.query(tenantId, alterSql, []);
              console.log(`[Auth Service] >>>> Successfully migrated tenant '${tenantId}' to DB schema v2.`);
            } catch (err) {
              // Log the error for the specific tenant but continue with the rest
              console.error(`[Auth Service] >>>> FAILED to migrate tenant '${tenantId}':`, err.message);
            }
          }
          console.log('[Auth Service] DB migration v2 process completed for all tenants.');
        } catch (err) {
          // This catches critical errors, like not being able to reach the tenant-manager
          console.error('[Auth Service] CRITICAL failure during migration process:', err.message);
        }
        return;
      }

if (topic === DB_TASK_REQUESTED_TOPIC) {
    // Check if this task is for me
    if (event.serviceName !== 'auth-service') {
        return; // Not my problem, ignore it
    }
    console.log(`[Auth Service] Received a DB task request: ${event.taskType}`);
    await handleDbTask(event);
    return;
}


      // --- Handle Replies for User Creation ---
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

const sendMigrationEvent = async () => {
  const eventPayload = {
    description: 'Trigger migration to add "name" column to users table.',
    triggeredAt: new Date().toISOString()
  };
  
  const subject = `${MIGRATION_TOPIC_V2}-value`;

  // Register and get the schema ID
  const { id: schemaId } = await registry.register(
    { type: 'AVRO', schema: JSON.stringify(migrationSchemaV2) },
    { subject }
  );

  // Encode the payload before sending
  const encodedPayload = await registry.encode(schemaId, eventPayload);

  await producer.send({
    topic: MIGRATION_TOPIC_V2,
    messages: [{ value: encodedPayload }], // <-- SEND THE ENCODED PAYLOAD
  });
  console.log('[Auth Service] Published ENCODED migration event to start DB schema v2 update.');
};

// --- NEW HELPER FUNCTION: The heart of the migration logic ---
async function handleDbTask(task) {
    let tenantsToMigrate = [];
    if (task.tenantId) {
        // A specific tenant is targeted
        tenantsToMigrate.push(task.tenantId);
        console.log(`> Task will run for specific tenant: ${task.tenantId}`);
    } else {
        // Target all tenants
        console.log(`> Task will run for ALL tenants.`);
        const response = await axios.get(`${process.env.TENANT_MANAGER_URL}/tenants`);
        tenantsToMigrate = response.data;
    }

    // Dynamically build the SQL based on the task type
    let sql = '';
    switch (task.taskType) {
        case 'ADD_TABLE':
            sql = task.tableDdl; // e.g., CREATE TABLE new_table (...)
            break;
        case 'RENAME_TABLE':
            sql = `ALTER TABLE ${db.escapeIdentifier(task.tableName)} RENAME TO ${db.escapeIdentifier(task.newTableName)};`;
            break;
        case 'DROP_TABLE':
            sql = `DROP TABLE IF EXISTS ${db.escapeIdentifier(task.tableName)};`;
            break;
        case 'ADD_COLUMN':
            sql = `ALTER TABLE ${db.escapeIdentifier(task.tableName)} ADD COLUMN IF NOT EXISTS ${db.escapeIdentifier(task.columnName)} ${task.columnDefinition};`;
            break;
        case 'RENAME_COLUMN':
            sql = `ALTER TABLE ${db.escapeIdentifier(task.tableName)} RENAME COLUMN ${db.escapeIdentifier(task.columnName)} TO ${db.escapeIdentifier(task.newColumnName)};`;
            break;
        case 'DROP_COLUMN':
            sql = `ALTER TABLE ${db.escapeIdentifier(task.tableName)} DROP COLUMN IF EXISTS ${db.escapeIdentifier(task.columnName)};`;
            break;
        default:
            console.error(`> Unknown task type: ${task.taskType}`);
            return;
    }

    console.log(`> Executing SQL: ${sql}`);

    // Loop and run the SQL for each targeted tenant
    for (const tenantId of tenantsToMigrate) {
        try {
            await db.query(tenantId, sql, []);
            console.log(`>> SUCCESS on tenant '${tenantId}'`);
        } catch (err) {
            console.error(`>> FAILED on tenant '${tenantId}':`, err.message);
        }
    }
    console.log('> DB Task processing finished.');
}


// --- NEW Publisher function in kafka.js ---
const sendDbTaskEvent = async (taskPayload) => {
    const subject = `${DB_TASK_REQUESTED_TOPIC}-value`;
    const { id: schemaId } = await registry.register(
        { type: 'AVRO', schema: JSON.stringify(dbTaskRequestedSchema) },
        { subject }
    );
    const encodedPayload = await registry.encode(schemaId, taskPayload);
    await producer.send({
        topic: DB_TASK_REQUESTED_TOPIC,
        messages: [{ value: encodedPayload }],
    });
    console.log('[Auth Service] Published db-task-requested event.');
};


module.exports = { connect, disconnect, sendUserCreationRequest, sendMigrationEvent, sendDbTaskEvent, reconcileTenantSchema, buildCreateTableSql };
