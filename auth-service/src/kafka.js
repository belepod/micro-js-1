const { Kafka } = require('kafkajs');
const { SchemaRegistry } = require('@kafkajs/confluent-schema-registry');
const { randomUUID } = require('crypto');
const bcrypt = require('bcrypt'); // <-- Import bcrypt
const db = require('./db');
const axios = require('axios');

// This map holds pending HTTP requests for the Request-Reply pattern
const pendingRequests = new Map();

const kafka = new Kafka({
  clientId: 'auth-service',
  brokers: [process.env.KAFKA_BROKER],
});

// We need both a producer (for user creation) and a consumer (for all events)
const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: 'auth-group' });

const registry = new SchemaRegistry({ host: process.env.SCHEMA_REGISTRY_URL });
//const userCreatedSchema = require('../avro-schemas/user-created.avsc');
const fs = require('fs');
const path = require('path');

//const schemaPath = path.join(__dirname, '../avro-schemas/user-created.avsc');
//const userCreatedSchema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
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
// --- Define all topics this service interacts with ---
const TENANT_CREATED_TOPIC = 'tenant-created';
const TENANT_DELETED_TOPIC = 'tenant-deleted';
const TENANT_RENAMED_TOPIC = 'tenant-renamed';
const USER_CREATED_TOPIC = 'user-created';
const REPLY_TOPIC = 'processing-status';
const DB_TASK_REQUESTED_TOPIC = 'db-task-requested';

const connect = async () => {
  await producer.connect();
  await consumer.connect();
  
  // Subscribe to all relevant topics
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
      // Decode the message using the schema registry
      const event = await registry.decode(message.value).catch(e => console.error(e));
      if (!event) return;

      // --- THE NEW, POWERFUL TENANT-CREATED HANDLER ---
      if (topic === TENANT_CREATED_TOPIC) {
        const { tenantId, initialUsername, initialPassword } = event;
        console.log(`[Auth Service] Received tenant-created event for: ${tenantId}`);

        try {
          const safeTenantId = db.escapeIdentifier(tenantId);

          // 1. Create the schema
          await db.adminQuery(`CREATE SCHEMA IF NOT EXISTS ${safeTenantId}`);
          console.log(`> Schema '${tenantId}' created.`);

          // 2. Create the standard 'users' table
          const createUsersTableSql = `CREATE TABLE users (id SERIAL PRIMARY KEY, username VARCHAR(255) UNIQUE NOT NULL, password VARCHAR(255) NOT NULL, created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP);`;
          await db.query(tenantId, createUsersTableSql, []);
          console.log(`> Table 'users' created for tenant '${tenantId}'.`);

          // 3. Create the new 'superusers' table
          const createSuperusersTableSql = `CREATE TABLE superusers (id SERIAL PRIMARY KEY, username VARCHAR(255) UNIQUE NOT NULL, password VARCHAR(255) NOT NULL, created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP);`;
          await db.query(tenantId, createSuperusersTableSql, []);
          console.log(`> Table 'superusers' created for tenant '${tenantId}'.`);

          // 4. If initial user details are provided, create the superuser
          if (initialUsername && initialPassword) {
            const saltRounds = 10;
            const hashedPassword = await bcrypt.hash(initialPassword, saltRounds);
            const insertSuperuserSql = 'INSERT INTO superusers (username, password) VALUES ($1, $2)';
            await db.query(tenantId, insertSuperuserSql, [initialUsername, hashedPassword]);
            console.log(`> Initial superuser '${initialUsername}' created for tenant '${tenantId}'.`);
          }
        } catch (err) {
          console.error(`[Auth Service] FAILED to provision schema/user for tenant ${tenantId}:`, err);
        }
        return;
      }

      // --- Handle Tenant Deletion ---
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



module.exports = { connect, disconnect, sendUserCreationRequest, sendMigrationEvent, sendDbTaskEvent };
