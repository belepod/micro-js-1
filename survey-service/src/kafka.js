const { Kafka } = require('kafkajs');
const db = require('./db');

const kafka = new Kafka({
  clientId: 'survey-service',
  brokers: [process.env.KAFKA_BROKER],
});

const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: 'survey-group' });

const USER_CREATED_TOPIC = 'user-created';

const connect = async () => {
  await producer.connect();
  await consumer.connect();

  await consumer.subscribe({ topic: USER_CREATED_TOPIC, fromBeginning: true });

  await consumer.run({
    eachMessage: async ({ message }) => {
      const event = JSON.parse(message.value.toString());
      const { tenantId, id, username, correlationId, replyTopic } = event;
      console.log(`[Survey Service] Received user creation event for tenant ${tenantId}:`, event);

      let status = 'FAILURE';
      try {
        await db.query(tenantId,
          'INSERT INTO survey_users(user_id, username) VALUES($1, $2)',
          [id, username]
        );
        console.log(`[Survey Service] User ${username} added to DB for tenant ${tenantId}.`);
        status = 'SUCCESS';
      } catch (err) {
        console.error(`[Survey Service] Error saving user to DB for tenant ${tenantId}`, err);
      }

      await producer.send({
        topic: replyTopic,
        messages: [{
          value: JSON.stringify({ correlationId, status })
        }]
      });
      console.log(`[Survey Service] Sent reply for ${correlationId} with status ${status}`);
    },
  });
};

const disconnect = async () => {
  await producer.disconnect();
  await consumer.disconnect();
};

module.exports = { connect, disconnect };
