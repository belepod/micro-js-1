const { Kafka } = require('kafkajs');
const db = require('./db');

const kafka = new Kafka({
  clientId: 'auth-service',
  brokers: [process.env.KAFKA_BROKER],
});

const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: 'auth-group' });

const TENANT_CREATED_TOPIC = 'tenant-created';
const USER_CREATED_TOPIC = 'user-created';

const connect = async () => {
  await producer.connect();
  await consumer.connect();
  await consumer.subscribe({ topics: [TENANT_CREATED_TOPIC], fromBeginning: true });

  await consumer.run({
    eachMessage: async ({ topic, message }) => {
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
      }
    },
  });
};

const disconnect = async () => {
  await producer.disconnect();
  await consumer.disconnect();
};

const sendUserCreatedEvent = async (tenantId, newUser) => {
  await producer.send({
    topic: USER_CREATED_TOPIC,
    messages: [{ 
      value: JSON.stringify({
        tenantId,
        id: newUser.id,
        username: newUser.username,
      }) 
    }],
  });
  console.log(`[Auth Service] Sent user-created event for ${newUser.username} (tenant: ${tenantId})`);
};

module.exports = { connect, disconnect, sendUserCreatedEvent };
