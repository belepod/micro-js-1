const { Kafka } = require('kafkajs');
const db = require('./db');

const kafka = new Kafka({
  clientId: 'survey-service',
  brokers: [process.env.KAFKA_BROKER],
});

// Needs both a producer and a consumer
const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: 'survey-group' });

// --- Define all topics this service interacts with ---
const TENANT_CREATED_TOPIC = 'tenant-created';
const TENANT_DELETED_TOPIC = 'tenant-deleted';
const TENANT_RENAMED_TOPIC = 'tenant-renamed';
const USER_CREATED_TOPIC = 'user-created';

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
      const event = JSON.parse(message.value.toString());

      // --- Handle Tenant Creation ---
      if (topic === TENANT_CREATED_TOPIC) {
        const { tenantId } = event;
        console.log(`[Survey Service] Received tenant-created event for: ${tenantId}`);
        try {
            const safeTenantId = db.escapeIdentifier(tenantId);
            const createTableSql = `CREATE TABLE survey_users (id SERIAL PRIMARY KEY, user_id INTEGER UNIQUE NOT NULL, username VARCHAR(255) NOT NULL, created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP);`;
            await db.adminQuery(`CREATE SCHEMA IF NOT EXISTS ${safeTenantId}`);
            await db.query(tenantId, createTableSql, []);
            console.log(`[Survey Service] Schema for tenant '${tenantId}' provisioned.`);
        } catch (err) {
            console.error(`[Survey Service] Failed to provision schema for tenant ${tenantId}:`, err);
        }
        return;
      }

      // --- Handle Tenant Deletion ---
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
      
      // --- Handle Tenant Renaming ---
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

      // --- Handle User Creation and Send Reply ---
      if (topic === USER_CREATED_TOPIC) {
        const { tenantId, id, username, correlationId, replyTopic } = event;
        let status = 'FAILURE';
        
        try {
          await db.query(tenantId, 'INSERT INTO survey_users(user_id, username) VALUES($1, $2)', [id, username]);
          console.log(`[Survey Service] User ${username} processed successfully for tenant ${tenantId}.`);
          status = 'SUCCESS';
        } catch (err) {
          console.error(`[Survey Service] Failed to process user ${username} for tenant ${tenantId}`, err);
          status = 'FAILURE';
        }

        await producer.send({
            topic: replyTopic,
            messages: [{ value: JSON.stringify({ correlationId, status }) }]
        });
        console.log(`[Survey Service] Sent reply for ${correlationId} with status ${status}`);
      }
    },
  });
};

const disconnect = async () => {
  await producer.disconnect();
  await consumer.disconnect();
};

module.exports = { connect, disconnect };
