const { Kafka } = require('kafkajs');
const { randomUUID } = require('crypto');
const db = require('./db');

// Map to hold pending HTTP requests waiting for a reply
const pendingRequests = new Map();

const kafka = new Kafka({
  clientId: 'auth-service',
  brokers: [process.env.KAFKA_BROKER],
});

const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: 'auth-group' });

// Define our topics
const TENANT_CREATED_TOPIC = 'tenant-created';
const USER_CREATED_TOPIC = 'user-created';
const REPLY_TOPIC = 'processing-status'; // The "reply" topic

const connect = async () => {
  await producer.connect();
  await consumer.connect();
  // Subscribe to BOTH tenant creation AND replies
  await consumer.subscribe({ topics: [TENANT_CREATED_TOPIC, REPLY_TOPIC], fromBeginning: true });

  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      // --- Handle Tenant Creation (as before) ---
      if (topic === TENANT_CREATED_TOPIC) {
        const { tenantId } = JSON.parse(message.value.toString());
        console.log(`[Auth Service] Received tenant-created event for: ${tenantId}`);
        try {
          const safeTenantId = db.escapeIdentifier(tenantId);
          // The service now defines its OWN schema.
          const createTableSql = `CREATE TABLE users (id SERIAL PRIMARY KEY, username VARCHAR(255) UNIQUE NOT NULL, password VARCHAR(255) NOT NULL, created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP);`;
          
          await db.adminQuery(`CREATE SCHEMA IF NOT EXISTS ${safeTenantId}`);
          await db.query(tenantId, createTableSql, []);
          console.log(`[Auth Service] Schema for tenant '${tenantId}' provisioned.`);
        } catch (err) {
          console.error(`[Auth Service] Failed to provision schema for tenant ${tenantId}:`, err);
        }
        return;
      }
      
      // --- Handle Replies for User Creation ---
      if (topic === REPLY_TOPIC) {
        const event = JSON.parse(message.value.toString());
        const { correlationId, status } = event;

        if (pendingRequests.has(correlationId)) {
          const { res, timeout } = pendingRequests.get(correlationId);
          clearTimeout(timeout); // Very important: prevent the timeout from firing
          
          if (status === 'SUCCESS') {
            res.status(201).json({ status: 'Completed', message: 'User created successfully in all services.' });
          } else {
            res.status(500).json({ status: 'Failed', message: 'User creation failed in a downstream service.' });
          }
          pendingRequests.delete(correlationId);
        } else {
            console.log(`[Auth Service] Received reply for timed-out or unknown request: ${correlationId}`);
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
  }, 15000); // 15-second timeout

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
