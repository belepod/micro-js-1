const { Kafka } = require('kafkajs');
const { randomUUID } = require('crypto');
const db = require('./db');

// This map holds pending HTTP requests for the Request-Reply pattern
const pendingRequests = new Map();

const kafka = new Kafka({
  clientId: 'auth-service',
  brokers: [process.env.KAFKA_BROKER],
});

// We need both a producer (for user creation) and a consumer (for all events)
const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: 'auth-group' });

// --- Define all topics this service interacts with ---
const TENANT_CREATED_TOPIC = 'tenant-created';
const TENANT_DELETED_TOPIC = 'tenant-deleted';
const TENANT_RENAMED_TOPIC = 'tenant-renamed';
const USER_CREATED_TOPIC = 'user-created';
const REPLY_TOPIC = 'processing-status';

const connect = async () => {
  await producer.connect();
  await consumer.connect();
  
  // Subscribe to all relevant topics
  await consumer.subscribe({ 
    topics: [
      TENANT_CREATED_TOPIC, 
      TENANT_DELETED_TOPIC, 
      TENANT_RENAMED_TOPIC, 
      REPLY_TOPIC // Don't forget the reply topic!
    ], 
    fromBeginning: true 
  });

  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      const event = JSON.parse(message.value.toString());

      // --- Handle Tenant Creation ---
      if (topic === TENANT_CREATED_TOPIC) {
        const { tenantId } = event;
        console.log(`[Auth Service] Received tenant-created event for: ${tenantId}`);
        try {
          const safeTenantId = db.escapeIdentifier(tenantId);
          const createTableSql = `CREATE TABLE users (id SERIAL PRIMARY KEY, username VARCHAR(255) UNIQUE NOT NULL, password VARCHAR(255) NOT NULL, created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP);`;
          await db.adminQuery(`CREATE SCHEMA IF NOT EXISTS ${safeTenantId}`);
          await db.query(tenantId, createTableSql, []);
          console.log(`[Auth Service] Schema for tenant '${tenantId}' provisioned.`);
        } catch (err) {
          console.error(`[Auth Service] Failed to provision schema for tenant ${tenantId}:`, err);
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

  await producer.send({
    topic: USER_CREATED_TOPIC,
    messages: [{ 
      value: JSON.stringify({
        tenantId,
        id: newUser.id,
        username: newUser.username,
        correlationId,
        replyTopic: REPLY_TOPIC,
      }) 
    }],
  });
  console.log(`[Auth Service] Sent user-creation request for ${newUser.username} with correlationId ${correlationId}`);
};

module.exports = { connect, disconnect, sendUserCreationRequest };
