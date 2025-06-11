const { Kafka } = require('kafkajs');
const db = require('./db');

const kafka = new Kafka({
  clientId: 'survey-service',
  brokers: [process.env.KAFKA_BROKER],
});

const consumer = kafka.consumer({ groupId: 'survey-group' });

const TENANT_CREATED_TOPIC = 'tenant-created';
const USER_CREATED_TOPIC = 'user-created';

const connect = async () => {
  await consumer.connect();
  // This service now subscribes to BOTH events.
  await consumer.subscribe({ topics: [TENANT_CREATED_TOPIC, USER_CREATED_TOPIC], fromBeginning: true });

  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      // --- Handle Tenant Creation ---
      if (topic === TENANT_CREATED_TOPIC) {
        const { tenantId } = JSON.parse(message.value.toString());
        console.log(`[Survey Service] Received tenant-created event for: ${tenantId}`);
        try {
          const safeTenantId = db.escapeIdentifier(tenantId);
          // This service defines its OWN schema.
          const createTableSql = `CREATE TABLE survey_users (id SERIAL PRIMARY KEY, user_id INTEGER UNIQUE NOT NULL, username VARCHAR(255) NOT NULL, created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP);`;

          await db.adminQuery(`CREATE SCHEMA IF NOT EXISTS ${safeTenantId}`);
          await db.query(tenantId, createTableSql, []);
          console.log(`[Survey Service] Schema for tenant '${tenantId}' provisioned.`);
        } catch (err) {
          console.error(`[Survey Service] Failed to provision schema for tenant ${tenantId}:`, err);
        }
        return; 
      }

      // --- Handle User Creation ---
      if (topic === USER_CREATED_TOPIC) {
        const event = JSON.parse(message.value.toString());
        const { tenantId, id, username } = event;
        try {
          await db.query(tenantId,
            'INSERT INTO survey_users(user_id, username) VALUES($1, $2)',
            [id, username]
          );
          console.log(`[Survey Service] User ${username} processed for tenant ${tenantId}.`);
        } catch (err) {
          console.error(`[Survey Service] Failed to process user ${username} for tenant ${tenantId}`, err);
        }
      }
    },
  });
};

const disconnect = async () => {
  await consumer.disconnect();
};

module.exports = { connect, disconnect };
