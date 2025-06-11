const { Kafka } = require('kafkajs');
const db = require('./db');

const kafka = new Kafka({
  clientId: 'survey-service',
  brokers: [process.env.KAFKA_BROKER],
});

const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: 'survey-group' });

const TENANT_CREATED_TOPIC = 'tenant-created';
const USER_CREATED_TOPIC = 'user-created';

const connect = async () => {
  await producer.connect();
  await consumer.connect();

  await consumer.subscribe({ topics: [USER_CREATED_TOPIC, TENANT_CREATED_TOPIC], fromBeginning: true });
 await consumer.run({
    eachMessage: async ({ topic, message }) => {
      
      // --- Handle Tenant Creation ---
      if (topic === TENANT_CREATED_TOPIC) {
        const { tenantId } = JSON.parse(message.value.toString());
        console.log(`[Survey Service] Received tenant-created event for: ${tenantId}`);
        try {
          const safeTenantId = db.escapeIdentifier(tenantId);
          const createTableSql = `
            CREATE TABLE survey_users (
              id SERIAL PRIMARY KEY,
              user_id INTEGER UNIQUE NOT NULL,
              username VARCHAR(255) NOT NULL,
              created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
          `;
          await db.adminQuery(`CREATE SCHEMA IF NOT EXISTS ${safeTenantId}`);
          await db.query(tenantId, createTableSql, []);
          console.log(`[Survey Service] Schema and table for tenant '${tenantId}' created.`);
        } catch (err) {
          console.error(`[Survey Service] Failed to create schema for tenant ${tenantId}:`, err);
        }
        return; // End processing for this message
      }

      // --- Handle User Creation (updated) ---
      if (topic === USER_CREATED_TOPIC) {
        const event = JSON.parse(message.value.toString());
        // Destructure tenantId from the event
        const { tenantId, id, username, correlationId, replyTopic } = event;
        console.log(`[Survey Service] Received event for tenant ${tenantId}:`, event);

        let status = 'FAILURE';

        try {
          // Use the tenant-aware query
          await db.query(tenantId,
            'INSERT INTO survey_users(user_id, username) VALUES($1, $2)',
            [id, username]
          );
          console.log(`[Survey Service] User ${username} added to survey database for tenant ${tenantId}.`);
          status = 'SUCCESS';
        } catch (err) {
          console.error(`[Survey Service] Error saving user to database for tenant ${tenantId}`, err);
        }     // Send the reply

      await producer.send({
        topic: replyTopic,
        messages: [{
          value: JSON.stringify({ correlationId, status })
        }]
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
